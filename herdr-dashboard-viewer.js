#!/usr/bin/env node

import net from "node:net";

const socketIndex = process.argv.indexOf("--socket");
const socketPath = socketIndex >= 0 ? process.argv[socketIndex + 1] : undefined;
if (!socketPath) {
  process.stderr.write("Background task dashboard socket is required\n");
  process.exit(2);
}

const MAX_INCOMING_FRAME = 64 * 1024;
const STOP_CONFIRM_MS = 3500;
const ESC = "\x1b[";
const color = {
  accent: (text) => `${ESC}36m${text}${ESC}0m`,
  bold: (text) => `${ESC}1m${text}${ESC}0m`,
  dim: (text) => `${ESC}2m${text}${ESC}0m`,
  error: (text) => `${ESC}31m${text}${ESC}0m`,
  muted: (text) => `${ESC}90m${text}${ESC}0m`,
  success: (text) => `${ESC}32m${text}${ESC}0m`,
  warning: (text) => `${ESC}33m${text}${ESC}0m`,
};

let snapshot = {
  activeCount: 0,
  selected: undefined,
  selectedTaskId: undefined,
  tasks: [],
};
let help = false;
let notice = "connecting…";
let noticeUntil = Number.POSITIVE_INFINITY;
let requestSequence = 0;
let confirmStopTaskId;
let confirmStopUntil = 0;
let closed = false;
let buffer = "";

const socket = net.createConnection(socketPath);
socket.setEncoding("utf8");

const send = (value) => {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(value)}\n`);
  }
};

const draw = (lines) => {
  process.stdout.write(
    `${ESC}H${lines.map((line) => `${ESC}2K${line}`).join("\r\n")}${ESC}J`
  );
};

const clean = (value) =>
  String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b[P^_].*?\x1b\\/gsu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b[@-_]/gu, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "�")
    .replaceAll("\t", "   ");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (value) =>
  [...segmenter.segment(String(value))].map((entry) => entry.segment);

const codePointWidth = (codePoint) => {
  if (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
};

const graphemeWidth = (value) => {
  if (
    /\p{Extended_Pictographic}/u.test(value) ||
    /\u20e3/u.test(value) ||
    /\p{Regional_Indicator}{2}/u.test(value)
  ) {
    return 2;
  }
  let width = 0;
  for (const character of value) {
    if (/\p{Mark}/u.test(character)) continue;
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
};

const cellWidth = (value) =>
  graphemes(value).reduce((width, part) => width + graphemeWidth(part), 0);

const plainTruncate = (value, width) => {
  const text = clean(value).replaceAll(/\s*\n\s*/gu, " ↵ ");
  if (width <= 0) return "";
  if (cellWidth(text) <= width) return text;
  if (width === 1) return "…";
  let result = "";
  let resultWidth = 0;
  for (const part of graphemes(text)) {
    const partWidth = graphemeWidth(part);
    if (resultWidth + partWidth > width - 1) break;
    result += part;
    resultWidth += partWidth;
  }
  return `${result}…`;
};

const plainTail = (value, width) => {
  const text = clean(value).replaceAll(/\s*\n\s*/gu, " ↵ ");
  if (width <= 0) return "";
  if (cellWidth(text) <= width) return text;
  if (width === 1) return "…";
  let result = "";
  let resultWidth = 0;
  const parts = graphemes(text);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const partWidth = graphemeWidth(part);
    if (resultWidth + partWidth > width - 1) break;
    result = `${part}${result}`;
    resultWidth += partWidth;
  }
  return `…${result}`;
};

const pad = (value, width) => {
  const text = plainTruncate(value, width);
  return `${text}${" ".repeat(Math.max(0, width - cellWidth(text)))}`;
};

const wrap = (value, width) => {
  const source = clean(value);
  if (!source || width <= 0) return [];
  const lines = [];
  for (const raw of source.split("\n")) {
    let line = "";
    let lineWidth = 0;
    for (const part of graphemes(raw)) {
      const partWidth = graphemeWidth(part);
      if (line && lineWidth + partWidth > width) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      if (partWidth > width) {
        lines.push("…");
        continue;
      }
      line += part;
      lineWidth += partWidth;
    }
    lines.push(line);
  }
  return lines;
};

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

const duration = (startedAt, endedAt) =>
  startedAt ? formatDuration((endedAt ?? Date.now()) - startedAt) : "";

const bytes = (value) => {
  const count = Number(value ?? 0);
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(count < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
};

const isActive = (task) =>
  task?.status === "running" || task?.status === "stopping";

const quietDuration = (task) => {
  if (!isActive(task)) return undefined;
  const quietSince = Number(task.lastOutputAt ?? task.startedAt);
  if (!Number.isFinite(quietSince) || Date.now() - quietSince < 30_000) {
    return undefined;
  }
  return `quiet ${duration(quietSince)}`;
};

const statusSymbol = (status) => {
  if (status === "running") {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return frames[Math.floor(Date.now() / 120) % frames.length];
  }
  if (status === "stopping") return "◐";
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "stopped") return "■";
  return "○";
};

const statusLabel = (status) => {
  if (status === "running") return "RUNNING";
  if (status === "stopping") return "STOPPING";
  if (status === "completed") return "COMPLETED";
  if (status === "failed") return "FAILED";
  if (status === "stopped") return "STOPPED";
  return String(status ?? "UNKNOWN").toUpperCase();
};

const styleStatus = (status, text) => {
  if (status === "running") return color.accent(text);
  if (status === "stopping") return color.warning(text);
  if (status === "completed") return color.success(text);
  if (status === "failed") return color.error(text);
  return color.muted(text);
};

const selectedTaskIndex = () => {
  const index = snapshot.tasks.findIndex(
    (task) => task.id === snapshot.selectedTaskId
  );
  return index < 0 ? 0 : index;
};

const visibleWindow = (items, selected, size) => {
  if (size <= 0) return [];
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(size / 2), Math.max(0, items.length - size))
  );
  return items.slice(start, start + size).map((item, offset) => ({
    index: start + offset,
    item,
  }));
};

const setNotice = (text, durationMs = 2000) => {
  notice = text;
  noticeUntil = durationMs === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Date.now() + durationMs;
};

const currentNotice = () =>
  Date.now() < noticeUntil && notice !== "ready" ? notice : undefined;

const columns = (left, right, width, minimumLeftWidth = 0) => {
  let cleanRight = clean(right).replaceAll(/\s*\n\s*/gu, " ").trim();
  if (!cleanRight) return pad(left, width);
  const maximumRightWidth = Math.max(0, width - minimumLeftWidth - 1);
  if (minimumLeftWidth > 0 && maximumRightWidth === 0) {
    return pad(left, width);
  }
  if (minimumLeftWidth > 0 && cellWidth(cleanRight) > maximumRightWidth) {
    cleanRight = plainTruncate(cleanRight, maximumRightWidth);
  }
  const rightWidth = Math.min(width, cellWidth(cleanRight));
  const gap = rightWidth < width ? 1 : 0;
  const leftWidth = Math.max(0, width - rightWidth - gap);
  return `${pad(left, leftWidth)}${gap ? " " : ""}${plainTruncate(cleanRight, rightWidth)}`;
};

const sectionLine = (label, right, width) => {
  const prefix = `─ ${clean(label)} `;
  const suffix = right ? ` ${clean(right)} ` : "";
  const fill = "─".repeat(
    Math.max(0, width - cellWidth(prefix) - cellWidth(suffix))
  );
  return plainTruncate(`${prefix}${fill}${suffix}`, width);
};

const compactPath = (value) => {
  const home = process.env.HOME;
  if (home && (value === home || value.startsWith(`${home}/`))) {
    return `~${value.slice(home.length)}`;
  }
  return value;
};

const terminalSummary = (task) => {
  if (typeof task.exitCode === "number") return `exit ${task.exitCode}`;
  return task.signal || undefined;
};

const taskRowSummary = (task, availableWidth) => {
  const elapsed = duration(task.startedAt, task.endedAt);
  const quiet = quietDuration(task);
  const terminal = terminalSummary(task);
  const candidates = terminal
    ? [
        [elapsed, quiet, terminal],
        [elapsed, terminal],
        [terminal],
        [elapsed],
      ]
    : [[elapsed, quiet], [elapsed]];
  for (const candidate of candidates) {
    const summary = candidate.filter(Boolean).join(" · ");
    if (cellWidth(summary) <= availableWidth) {
      return summary;
    }
  }
  return "";
};

const styledTaskRow = (row, status, selected) => {
  const marker = row.slice(0, 1);
  const symbol = row.slice(2, 3);
  const remainder = row.slice(3);
  return `${selected ? color.accent(marker) : marker} ${styleStatus(status, symbol)}${selected ? color.bold(remainder) : remainder}`;
};

const render = () => {
  if (closed || !process.stdout.isTTY) return;
  const width = Math.max(1, process.stdout.columns ?? 80);
  const height = Math.max(1, process.stdout.rows ?? 24);
  const inner = Math.max(1, width - 2);
  const lines = [];
  const activeCount = Number(snapshot.activeCount ?? 0);
  const taskCount = snapshot.tasks.length;

  const headerSummary = activeCount
    ? `${activeCount} active · ${taskCount} total`
    : taskCount
      ? `${taskCount} recent`
      : "idle";

  if (width < 36 || height < 14) {
    const compactHeaderSummary =
      inner >= 25
        ? activeCount
          ? `${activeCount} active`
          : taskCount
            ? `${taskCount} recent`
            : "idle"
        : "";
    const compactLines = [
      ` ${color.accent(color.bold(columns("Background tasks", compactHeaderSummary, inner)))}`,
    ];
    if (help) {
      compactLines.push(` ${color.dim(sectionLine("Help", "", inner))}`);
      for (const line of [
        "j/k select · x x stop",
        "r refresh · p parent",
        "? back · q close",
      ]) {
        compactLines.push(` ${plainTruncate(line, inner)}`);
      }
    } else if (snapshot.selected) {
      const task = snapshot.selected;
      const symbol = statusSymbol(task.status);
      compactLines.push(
        ` ${color.dim(sectionLine("Selected", statusLabel(task.status), inner))}`
      );
      compactLines.push(
        ` ${styleStatus(task.status, symbol)} ${color.bold(plainTruncate(task.name, Math.max(1, inner - 2)))}`
      );
      const compactMetadata = [
        duration(task.startedAt, task.endedAt),
        quietDuration(task),
        terminalSummary(task),
      ]
        .filter(Boolean)
        .join(" · ");
      if (compactMetadata) {
        compactLines.push(
          ` ${color.muted(plainTruncate(compactMetadata, inner))}`
        );
      }
    } else {
      compactLines.push(` ${color.muted("No background tasks yet.")}`);
    }
    const visibleLines = compactLines.slice(0, Math.max(0, height - 1));
    while (visibleLines.length < height - 1) visibleLines.push("");
    const activeNotice = currentNotice();
    const compactFooter = activeNotice ?? "j/k · x stop · ? help · q close";
    visibleLines.push(
      (activeNotice ? color.warning : color.dim)(
        plainTruncate(` ${compactFooter}`, width - 1)
      )
    );
    draw(visibleLines);
    return;
  }

  lines.push(
    ` ${color.accent(color.bold(columns("Background tasks", headerSummary, inner)))}`
  );

  if (help) {
    lines.push(` ${color.dim(sectionLine("Help", "", inner))}`);
    const helpLines = [
      ["↑ ↓ / j k", "select task"],
      ["x x", "stop active task"],
      ["r", "refresh"],
      ["p", "focus parent Pi pane"],
      ["? / h", "toggle help"],
      ["q / ctrl+c", "close dashboard"],
    ];
    for (const [keys, description] of helpLines) {
      lines.push(
        ` ${color.accent(pad(keys, 14))}${plainTruncate(description, Math.max(1, inner - 14))}`
      );
    }
    lines.push("");
    lines.push(
      ` ${color.muted(plainTruncate("Active tasks appear first, followed by recent tasks.", inner))}`
    );
  } else {
    const taskRows = Math.min(
      8,
      Math.max(2, Math.floor(height * 0.25))
    );
    lines.push(
      ` ${color.dim(sectionLine("Tasks", String(taskCount), inner))}`
    );
    if (taskCount === 0) {
      lines.push(` ${color.muted("No background tasks yet.")}`);
    } else {
      const visibleTasks = visibleWindow(
        snapshot.tasks,
        selectedTaskIndex(),
        taskRows
      );
      for (const { index, item: task } of visibleTasks) {
        const selected = index === selectedTaskIndex();
        const minimumIdentityWidth = Math.min(
          inner,
          Math.max(14, Math.floor(inner * 0.55))
        );
        const right = taskRowSummary(
          task,
          Math.max(0, inner - minimumIdentityWidth - 1)
        );
        const row = columns(
          `${selected ? "›" : " "} ${statusSymbol(task.status)} ${task.name}`,
          right,
          inner,
          minimumIdentityWidth
        );
        lines.push(` ${styledTaskRow(row, task.status, selected)}`);
      }
      if (taskCount > visibleTasks.length) {
        lines.push(
          ` ${color.dim(`  … ${taskCount - visibleTasks.length} more tasks`)}`
        );
      }
    }

    lines.push("");
    const task = snapshot.selected;
    if (task) {
      lines.push(
        ` ${color.dim(sectionLine("Selected task", statusLabel(task.status), inner))}`
      );
      const symbol = statusSymbol(task.status);
      const title = columns(
        task.name,
        terminalSummary(task) ?? "",
        Math.max(1, inner - 2)
      );
      lines.push(
        ` ${styleStatus(task.status, symbol)} ${color.bold(title)}`
      );
      const identityMetadata = [
        task.id,
        task.pid === undefined ? undefined : `pid ${task.pid}`,
        duration(task.startedAt, task.endedAt),
        bytes(task.bytesWritten),
      ]
        .filter(Boolean)
        .join(" · ");
      const behaviorParts = [
        `policy ${task.completionPolicy}`,
        task.timeoutSeconds === undefined
          ? undefined
          : `timeout ${formatDuration(task.timeoutSeconds * 1000)}`,
        task.watchCount
          ? `${task.watchCount} watch${task.watchCount === 1 ? "" : "es"}`
          : undefined,
        quietDuration(task),
      ].filter(Boolean);
      while (
        behaviorParts.length > 1 &&
        cellWidth(behaviorParts.join(" · ")) > inner
      ) {
        behaviorParts.pop();
      }
      const behaviorMetadata = behaviorParts.join(" · ");
      lines.push(
        ` ${color.muted(plainTruncate(identityMetadata, inner))}`
      );
      if (behaviorMetadata) {
        lines.push(
          ` ${color.muted(plainTruncate(behaviorMetadata, inner))}`
        );
      }

      if (task.error && lines.length < height - 4) {
        lines.push(` ${color.error(sectionLine("Error", "", inner))}`);
        for (const line of wrap(task.error, Math.max(1, inner - 2)).slice(0, 3)) {
          lines.push(` ${color.error(`  ${plainTruncate(line, inner - 2)}`)}`);
        }
      }

      if (task.command && lines.length < height - 4) {
        lines.push(` ${color.dim(sectionLine("Command", "", inner))}`);
        for (const line of wrap(task.command, Math.max(1, inner - 2)).slice(0, 3)) {
          lines.push(`   ${plainTruncate(line, Math.max(1, inner - 2))}`);
        }
      }
      if (task.cwd && lines.length < height - 3) {
        const cwd = compactPath(task.cwd);
        lines.push(
          ` ${color.dim("cwd")} ${plainTruncate(cwd, Math.max(1, inner - 4))}`
        );
      }

      if (lines.length < height - 2) {
        lines.push(
          ` ${color.dim(sectionLine("Output", bytes(task.bytesWritten), inner))}`
        );
        const outputRoom = Math.max(0, height - 1 - lines.length);
        if (task.output && outputRoom > 0) {
          const outputLines = clean(task.output).split("\n");
          while (outputLines.length > 1 && outputLines.at(-1) === "") {
            outputLines.pop();
          }
          let visibleOutput = outputLines.slice(-outputRoom);
          if (outputRoom > 1 && outputLines.length > outputRoom) {
            const omittedLines = outputLines.length - outputRoom + 1;
            visibleOutput = [
              `… ${omittedLines} earlier lines`,
              ...outputLines.slice(-(outputRoom - 1)),
            ];
          }
          for (const line of visibleOutput) {
            lines.push(
              ` ${color.muted("│")} ${plainTail(line, Math.max(1, inner - 2))}`
            );
          }
        } else if (outputRoom > 0) {
          const emptyOutput = task.bytesWritten > 0
            ? "Loading committed output…"
            : isActive(task)
              ? "Waiting for output…"
              : "No output captured.";
          lines.push(` ${color.muted(emptyOutput)}`);
        }
      }
    } else {
      lines.push(
        ` ${color.muted("Start a task in the parent Pi pane to see it here.")}`
      );
    }
  }

  while (lines.length < height - 1) lines.push("");
  const activeNotice = currentNotice();
  const footer =
    activeNotice ?? "j/k select · x stop · r refresh · p parent · ? help · q close";
  lines.push(
    (activeNotice ? color.warning : color.dim)(
      plainTruncate(` ${footer}`, width - 1)
    )
  );
  draw(lines.slice(0, height));
};

const selectTask = (delta) => {
  if (snapshot.tasks.length === 0) return;
  const index = Math.max(
    0,
    Math.min(snapshot.tasks.length - 1, selectedTaskIndex() + delta)
  );
  const task = snapshot.tasks[index];
  snapshot = {
    ...snapshot,
    selected: task,
    selectedTaskId: task.id,
  };
  confirmStopTaskId = undefined;
  confirmStopUntil = 0;
  send({ taskId: task.id, type: "select" });
};

const action = (name, extra = {}) => {
  requestSequence += 1;
  setNotice(`${name.replaceAll("-", " ")}…`, Number.POSITIVE_INFINITY);
  send({
    action: name,
    id: String(requestSequence),
    taskId: snapshot.selectedTaskId,
    type: "action",
    ...extra,
  });
  render();
};

const requestStop = () => {
  const task = snapshot.selected;
  if (!task) {
    setNotice("No task selected");
    return;
  }
  if (!isActive(task)) {
    setNotice(`${task.name} is already ${task.status}`);
    return;
  }
  const now = Date.now();
  if (confirmStopTaskId !== task.id || confirmStopUntil <= now) {
    confirmStopTaskId = task.id;
    confirmStopUntil = now + STOP_CONFIRM_MS;
    setNotice(`Press x again to stop ${task.name}`, STOP_CONFIRM_MS);
    return;
  }
  confirmStopTaskId = undefined;
  confirmStopUntil = 0;
  action("stop-task");
};

const cleanup = (exitCode = 0) => {
  if (closed) return;
  closed = true;
  clearInterval(animation);
  process.stdin.off("data", onInput);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  process.stdin.pause();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  socket.destroy();
  process.exit(exitCode);
};

const onInput = (data) => {
  if (data === "q" || data === "\x03") {
    action("close-dashboard");
    return;
  }
  if (data === "?" || data === "h") {
    help = !help;
  } else if (data === "\x1b[A" || data === "k") {
    selectTask(-1);
  } else if (data === "\x1b[B" || data === "j") {
    selectTask(1);
  } else if (data === "x") {
    requestStop();
  } else if (data === "r") {
    action("refresh");
  } else if (data === "p") {
    action("focus-parent");
  }
  render();
};

socket.on("connect", () => {
  setNotice("ready", 0);
  send({ type: "hello", version: 1 });
});

socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      if (buffer.length > MAX_INCOMING_FRAME) {
        socket.destroy(new Error("Dashboard protocol frame is too large"));
      }
      break;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.length > MAX_INCOMING_FRAME) {
      socket.destroy(new Error("Dashboard protocol frame is too large"));
      return;
    }
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === "snapshot") {
      snapshot = message;
      setNotice("ready", 0);
    } else if (message.type === "action-result") {
      setNotice(message.ok ? "done" : `error: ${message.error ?? "action failed"}`);
    } else if (message.type === "shutdown") {
      cleanup(0);
      return;
    }
    render();
  }
});

socket.on("error", (error) => {
  setNotice(`disconnected: ${error.message}`, Number.POSITIVE_INFINITY);
  render();
  setTimeout(() => cleanup(1), 800).unref?.();
});

socket.on("close", () => {
  if (!closed) {
    setNotice("dashboard disconnected", Number.POSITIVE_INFINITY);
    render();
    setTimeout(() => cleanup(0), 300).unref?.();
  }
});

process.on("SIGTERM", () => cleanup(0));
process.on("SIGHUP", () => cleanup(0));
process.on("uncaughtException", (error) => {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
process.stdout.on("resize", render);

if (process.stdout.isTTY) {
  process.stdout.write(
    "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b]0;Background tasks\x07"
  );
}
if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", onInput);
const animation = setInterval(render, 250);
animation.unref?.();
render();
