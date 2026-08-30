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
  dim: (text) => `${ESC}2m${text}${ESC}0m`,
  error: (text) => `${ESC}31m${text}${ESC}0m`,
  muted: (text) => `${ESC}90m${text}${ESC}0m`,
  selected: (text) => `${ESC}7m${text}${ESC}0m`,
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

const duration = (startedAt, endedAt) => {
  if (!startedAt) return "";
  const seconds = Math.max(
    0,
    Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000)
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const bytes = (value) => {
  const count = Number(value ?? 0);
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(count < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
};

const isActive = (task) =>
  task?.status === "running" || task?.status === "stopping";

const statusMark = (status) => {
  if (status === "running") {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return color.accent(frames[Math.floor(Date.now() / 120) % frames.length]);
  }
  if (status === "stopping") return color.warning("◐");
  if (status === "completed") return color.success("✓");
  if (status === "failed") return color.error("✕");
  if (status === "stopped") return color.muted("■");
  return color.muted("○");
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

const render = () => {
  if (closed || !process.stdout.isTTY) return;
  const width = Math.max(1, process.stdout.columns ?? 80);
  const height = Math.max(1, process.stdout.rows ?? 24);
  const inner = Math.max(1, width - 2);
  const lines = [];
  const activeCount = Number(snapshot.activeCount ?? 0);

  if (width < 20 || height < 9) {
    const compactLines = [
      plainTruncate(
        `Background tasks${activeCount ? ` · ${activeCount} active` : ""}`,
        width
      ),
    ];
    if (height > 1) {
      compactLines.push(plainTruncate("Resize pane for dashboard", width));
    }
    while (compactLines.length < height) compactLines.push("");
    draw(compactLines.slice(0, height));
    return;
  }

  lines.push(
    color.accent(
      plainTruncate(
        ` Background tasks · ${activeCount > 0 ? `${activeCount} active` : "ready"}`,
        width - 1
      )
    )
  );
  lines.push("");

  if (help) {
    const helpLines = [
      "Background task dashboard keys",
      "",
      "↑ ↓ / j k    select task",
      "x            stop active task (twice)",
      "r            refresh",
      "p            focus parent Pi pane",
      "?            toggle this help",
      "q / ctrl+c   close dashboard pane",
      "",
      "Active tasks appear first, followed by recent tasks.",
    ];
    for (const line of helpLines.slice(0, height - 4)) {
      lines.push(` ${plainTruncate(line, inner)}`);
    }
  } else {
    const taskRows = Math.min(
      Math.max(3, Math.floor((height - 8) * 0.35)),
      10
    );
    lines.push(` ${color.accent("Tasks")} ${color.dim(`(${snapshot.tasks.length})`)}`);
    if (snapshot.tasks.length === 0) {
      lines.push(` ${color.muted("No background tasks yet")}`);
      for (let index = 1; index < taskRows; index += 1) lines.push("");
    } else {
      for (const { index, item: task } of visibleWindow(
        snapshot.tasks,
        selectedTaskIndex(),
        taskRows
      )) {
        const active = task.id === snapshot.selectedTaskId;
        const terminal =
          typeof task.exitCode === "number"
            ? ` · exit ${task.exitCode}`
            : task.signal
              ? ` · ${task.signal}`
              : "";
        const text = `${active ? ">" : " "} ${task.status === "running" ? "●" : task.status === "stopping" ? "◐" : task.status === "completed" ? "✓" : task.status === "failed" ? "✕" : "■"} ${task.name} · ${duration(task.startedAt, task.endedAt)}${terminal}`;
        const row = pad(text, inner);
        lines.push(
          ` ${index === selectedTaskIndex() ? color.selected(row) : styleStatus(task.status, row)}`
        );
      }
      for (
        let index = Math.min(taskRows, snapshot.tasks.length);
        index < taskRows;
        index += 1
      ) {
        lines.push("");
      }
    }

    lines.push("");
    const task = snapshot.selected;
    const detailBudget = Math.max(1, height - lines.length - 2);
    const details = [];
    if (task) {
      details.push(`${statusMark(task.status)} ${task.name} · ${task.status}`);
      details.push(
        [
          task.id,
          task.pid === undefined ? undefined : `PID ${task.pid}`,
          duration(task.startedAt, task.endedAt),
          bytes(task.bytesWritten),
          task.completionPolicy,
          task.watchCount ? `${task.watchCount} watch${task.watchCount === 1 ? "" : "es"}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      );
      if (task.error) details.push(`error: ${task.error}`);
      if (task.command && details.length < detailBudget) {
        details.push("command:");
        details.push(
          ...wrap(task.command, Math.max(1, inner - 2))
            .slice(0, Math.max(1, Math.min(3, detailBudget - details.length)))
            .map((line) => `  ${line}`)
        );
      }
      if (task.cwd && details.length < detailBudget) {
        details.push(`cwd: ${task.cwd}`);
      }
      if (task.output && details.length < detailBudget) {
        details.push("recent output:");
        const outputBudget = Math.max(1, detailBudget - details.length);
        details.push(
          ...wrap(task.output, Math.max(1, inner - 2))
            .slice(-outputBudget)
            .map((line) => `  ${line}`)
        );
      }
    } else {
      details.push("Start a task in the parent Pi pane.");
    }
    for (const line of details.slice(0, detailBudget)) {
      lines.push(` ${plainTruncate(line, inner)}`);
    }
  }

  while (lines.length < height - 1) lines.push("");
  const footer = currentNotice() ?? "↑↓ select · x stop · ? help · p parent · q close";
  lines.push(color.dim(plainTruncate(` ${footer}`, width - 1)));
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
