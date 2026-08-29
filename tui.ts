import {
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  type KeybindingsManager,
  matchesKey,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  BackgroundTaskManager,
  CompletionPolicy,
  TaskLogs,
  TaskSnapshot,
  TaskStatus,
  TaskWatchCondition,
  TaskWatchSnapshot,
} from "./core.ts";

export type BackgroundTaskAction =
  | "start"
  | "status"
  | "logs"
  | "stop"
  | "watch"
  | "unwatch";

export interface BackgroundTaskToolParams {
  action: BackgroundTaskAction;
  afterByte?: number;
  command?: string;
  completionPolicy?: CompletionPolicy;
  condition?: TaskWatchCondition;
  cwd?: string;
  inactivitySeconds?: number;
  maxBytes?: number;
  name?: string;
  pattern?: string;
  taskId?: string;
  timeoutSeconds?: number;
  wake?: boolean;
  watchId?: string;
}

export interface BackgroundTaskToolDetails {
  task?: TaskSnapshot;
  tasks?: TaskSnapshot[];
  text?: string;
  output?: string;
  bytesRead?: number;
  droppedBytes?: number;
  nextByte?: number;
  startByte?: number;
  totalBytes?: number;
  truncated?: boolean;
  watch?: TaskWatchSnapshot;
}

interface TextContent {
  type: string;
  text?: string;
}

interface RenderableToolResult {
  content: readonly TextContent[];
  details?: BackgroundTaskToolDetails;
}

export interface CompletionTaskDetails {
  error?: string;
  exitCode?: number | null;
  id: string;
  name: string;
  output?: string;
  outputError?: string;
  outputTruncated?: boolean;
  signal?: NodeJS.Signals | null;
  status: TaskStatus;
}

export interface CompletionDisplayDetails {
  omitted: number;
  tasks: CompletionTaskDetails[];
}

interface RenderableCompletionMessage {
  content: unknown;
  details?: CompletionDisplayDetails;
}

interface MessageRenderOptions {
  expanded: boolean;
  outputPad: number;
}

interface StatusPresentation {
  color: "accent" | "success" | "error" | "warning" | "muted";
  label: string;
  shortLabel: string;
  symbol: string;
}

const STATUS_PRESENTATION: Record<TaskStatus, StatusPresentation> = {
  completed: {
    color: "success",
    label: "Completed",
    shortLabel: "done",
    symbol: "✓",
  },
  failed: {
    color: "error",
    label: "Failed",
    shortLabel: "fail",
    symbol: "×",
  },
  running: {
    color: "accent",
    label: "Running",
    shortLabel: "run",
    symbol: "●",
  },
  stopped: {
    color: "muted",
    label: "Stopped",
    shortLabel: "stop",
    symbol: "■",
  },
  stopping: {
    color: "warning",
    label: "Stopping",
    shortLabel: "wait",
    symbol: "◐",
  },
};

const DASHBOARD_REFRESH_MS = 1000;
const STOP_CONFIRM_MS = 3500;
const COLLAPSED_TASK_ROWS = 5;
const COLLAPSED_LOG_LINES = 8;
const EXPANDED_LOG_LINES = 80;
const EXPANDED_COMPLETION_OUTPUT_LINES = 12;
const MAX_COMPLETION_OUTPUT_LINES = 48;

const cleanDisplay = function cleanDisplay(value: string): string {
  return stripTerminalSequences(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replaceAll("\t", "   ");
};

const cleanInline = function cleanInline(value: string): string {
  return cleanDisplay(value).replaceAll(/\s*\n\s*/gu, " ↵ ").trim();
};

export const sanitizeUiInline = function sanitizeUiInline(
  value: string
): string {
  return cleanInline(value);
};

const plural = function plural(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
};

export const formatUiDuration = function formatUiDuration(
  milliseconds: number
): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
};

export const formatUiBytes = function formatUiBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
};

const taskDuration = function taskDuration(
  task: TaskSnapshot,
  now = Date.now()
): string {
  return formatUiDuration((task.endedAt ?? now) - task.startedAt);
};

const styledStatus = function styledStatus(
  status: TaskStatus,
  theme: Theme,
  long = true
): string {
  const presentation = STATUS_PRESENTATION[status];
  const label = long ? presentation.label : presentation.shortLabel;
  return theme.fg(
    presentation.color,
    `${presentation.symbol} ${label}`
  );
};

const terminalSummary = function terminalSummary(task: TaskSnapshot): string {
  if (typeof task.exitCode === "number") {
    return `exit ${String(task.exitCode)}`;
  }
  if (task.signal) {
    return task.signal;
  }
  return "";
};

const effectiveCompletionPolicy = function effectiveCompletionPolicy(
  value: {
    completionPolicy?: CompletionPolicy;
    wakeOnExit?: boolean;
  },
  fallback?: CompletionPolicy
): CompletionPolicy | undefined {
  if (value.completionPolicy) {
    return value.completionPolicy;
  }
  if (typeof value.wakeOnExit === "boolean") {
    return value.wakeOnExit ? "wake" : "notify";
  }
  return fallback;
};

const renderTaskRow = function renderTaskRow(
  task: TaskSnapshot,
  theme: Theme,
  options: { expanded: boolean; now?: number }
): string[] {
  const terminal = terminalSummary(task);
  const completionPolicy = effectiveCompletionPolicy(task, "notify")!;
  const policy = theme.fg(
    completionPolicy === "wake" ? "accent" : "muted",
    ` · ${completionPolicy}`
  );
  const error = task.error ? ` · ${theme.fg("error", cleanInline(task.error))}` : "";
  const summary = [
    styledStatus(task.status, theme),
    theme.fg("accent", task.id),
    theme.fg("text", cleanInline(task.name)),
    theme.fg("muted", taskDuration(task, options.now)),
    terminal ? theme.fg("muted", terminal) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (!options.expanded) {
    return [`${summary}${policy}${error}`];
  }

  const details = [
    `${theme.fg("dim", "command")} ${cleanInline(task.command)}`,
    `${theme.fg("dim", "log")} ${cleanInline(task.logPath)}`,
  ];
  if (task.error) {
    details.unshift(
      `${theme.fg("error", "error")} ${cleanInline(task.error)}`
    );
  }
  return [summary + policy, ...details.map((line) => `  ${line}`)];
};

const textResult = function textResult(text: string): Component {
  return new Text(text, 0, 0);
};

export const renderBackgroundTaskCall = function renderBackgroundTaskCall(
  args: BackgroundTaskToolParams,
  theme: Theme,
  context: { expanded: boolean }
): Component {
  let text =
    theme.fg("toolTitle", theme.bold("background task")) +
    ` ${theme.fg("accent", args.action)}`;

  if (args.action === "start") {
    const identity = args.name?.trim() || args.command?.trim();
    if (identity) {
      text += ` ${theme.fg("muted", cleanInline(identity))}`;
    }
    const completionPolicy = effectiveCompletionPolicy(args);
    const options = [
      completionPolicy === undefined
        ? undefined
        : `policy ${completionPolicy}`,
      args.timeoutSeconds === undefined
        ? undefined
        : `timeout ${formatUiDuration(args.timeoutSeconds * 1000)}`,
    ].filter((value): value is string => value !== undefined);
    if (options.length > 0) {
      text += theme.fg("dim", ` · ${options.join(" · ")}`);
    }
    if (context.expanded && args.command && args.name) {
      text += `\n${theme.fg("dim", "command")} ${cleanInline(args.command)}`;
    }
  } else if (args.action === "watch") {
    if (args.taskId) {
      text += ` ${theme.fg("accent", cleanInline(args.taskId))}`;
    }
    if (args.condition) {
      text += ` ${theme.fg("muted", args.condition)}`;
    }
    if (args.pattern) {
      text += ` ${theme.fg("text", cleanInline(args.pattern))}`;
    }
    if (args.inactivitySeconds !== undefined) {
      text += theme.fg(
        "dim",
        ` · ${formatUiDuration(args.inactivitySeconds * 1000)}`
      );
    }
    if (args.wake) {
      text += theme.fg("dim", " · wake");
    }
  } else if (args.action === "unwatch") {
    if (args.watchId) {
      text += ` ${theme.fg("accent", cleanInline(args.watchId))}`;
    }
  } else if (args.taskId) {
    text += ` ${theme.fg("accent", cleanInline(args.taskId))}`;
    if (args.action === "logs") {
      if (args.afterByte !== undefined) {
        text += theme.fg("dim", ` · after byte ${String(args.afterByte)}`);
      }
      if (args.maxBytes !== undefined) {
        text += theme.fg("dim", ` · up to ${formatUiBytes(args.maxBytes)}`);
      }
    }
  } else if (args.action === "status") {
    text += theme.fg("dim", " · all tasks");
  }

  return textResult(text);
};

const resultText = function resultText(result: RenderableToolResult): string {
  return result.content
    .filter((content) => content.type === "text" && content.text)
    .map((content) => cleanDisplay(content.text ?? ""))
    .join("\n");
};

const renderLogResult = function renderLogResult(
  result: RenderableToolResult,
  options: ToolRenderResultOptions,
  theme: Theme
): Component {
  const details = result.details;
  const task = details?.task;
  const rawOutput = details?.output ?? resultText(result);
  const outputLines = cleanDisplay(rawOutput).split("\n");
  const limit = options.expanded ? EXPANDED_LOG_LINES : COLLAPSED_LOG_LINES;
  const visibleLines = outputLines.slice(-limit);
  const hidden = outputLines.length - visibleLines.length;
  const lines: string[] = [];

  if (task) {
    const counts =
      details?.bytesRead === undefined || details.totalBytes === undefined
        ? ""
        : details.startByte !== undefined && details.nextByte !== undefined
          ? ` · bytes ${String(details.startByte)}-${String(details.nextByte)} of ${String(details.totalBytes)}${details.droppedBytes ? ` · skipped ${String(details.droppedBytes)}` : ""}`
          : details.truncated
            ? ` · tail ${formatUiBytes(details.bytesRead)} of ${formatUiBytes(details.totalBytes)}`
            : ` · ${formatUiBytes(details.totalBytes)}`;
    lines.push(
      `${styledStatus(task.status, theme)} · ${theme.fg("text", cleanInline(task.name))}${theme.fg("dim", counts)}`
    );
  }
  if (hidden > 0) {
    lines.push(
      theme.fg(
        "dim",
        `… ${plural(hidden, "earlier line")} hidden in the TUI`
      )
    );
  }
  for (const line of visibleLines) {
    lines.push(
      `${theme.fg("borderMuted", ">")} ${theme.fg("toolOutput", line || " ")}`
    );
  }
  if (task && options.expanded) {
    lines.push(`${theme.fg("dim", "full log")} ${cleanInline(task.logPath)}`);
  } else if (!options.expanded && hidden > 0) {
    lines.push(theme.fg("dim", keyHint("app.tools.expand", "show more")));
  }
  return textResult(lines.join("\n"));
};

export const renderBackgroundTaskResult = function renderBackgroundTaskResult(
  result: RenderableToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { args: unknown; isError: boolean }
): Component {
  const args = context.args as BackgroundTaskToolParams;
  const details = result.details;

  if (context.isError) {
    return textResult(
      `${theme.fg("error", "× Background task error")}\n${theme.fg("toolOutput", resultText(result))}`
    );
  }

  if (options.isPartial) {
    return textResult(theme.fg("warning", "◐ Updating background tasks…"));
  }

  if (args.action === "logs") {
    return renderLogResult(result, options, theme);
  }

  if (args.action === "status") {
    const tasks = details?.tasks ?? [];
    if (tasks.length === 0) {
      return textResult(theme.fg("dim", "○ No background tasks"));
    }
    const active = tasks.filter(
      (task) => task.status === "running" || task.status === "stopping"
    ).length;
    const visible = options.expanded
      ? tasks
      : tasks.slice(0, COLLAPSED_TASK_ROWS);
    const lines = [
      `${plural(active, "active task")} · ${plural(tasks.length - active, "recent task")}`,
      ...visible.flatMap((task) =>
        renderTaskRow(task, theme, { expanded: options.expanded })
      ),
    ];
    const hidden = tasks.length - visible.length;
    if (hidden > 0) {
      lines.push(
        theme.fg(
          "dim",
          `… ${plural(hidden, "more task")} · ${keyHint("app.tools.expand", "show all")}`
        )
      );
    }
    return textResult(lines.join("\n"));
  }

  const watch = details?.watch;
  if (watch) {
    const stateColor = watch.status === "active" ? "accent" : "muted";
    return textResult(
      `${theme.fg(stateColor, watch.status)} · ${theme.fg("text", watch.condition)} · ${theme.fg("accent", watch.id)} · task ${theme.fg("accent", watch.taskId)}`
    );
  }

  const task = details?.task;
  if (!task) {
    return textResult(theme.fg("toolOutput", resultText(result)));
  }

  if (args.action === "stop") {
    return textResult(
      `${styledStatus(task.status, theme)} · ${theme.fg("text", cleanInline(task.name))} · ${theme.fg("accent", task.id)}\n${theme.fg("dim", "Pi will send SIGKILL if the process does not stop after the grace period.")}`
    );
  }

  const lines = renderTaskRow(task, theme, {
    expanded: options.expanded,
  });
  const metadata = [
    task.pid === undefined ? undefined : `PID ${String(task.pid)}`,
    `cwd ${task.cwd}`,
    `policy ${effectiveCompletionPolicy(task, "notify")!}`,
    task.timeoutSeconds === undefined
      ? undefined
      : `timeout ${formatUiDuration(task.timeoutSeconds * 1000)}`,
  ].filter((value): value is string => value !== undefined);
  lines.push(theme.fg("dim", metadata.join(" · ")));
  if (!options.expanded) {
    lines.push(theme.fg("dim", keyHint("app.tools.expand", "show command and log path")));
  }
  return textResult(lines.join("\n"));
};

const completionSummary = function completionSummary(
  tasks: readonly CompletionTaskDetails[]
): { color: "error" | "success" | "warning"; text: string } {
  const failed = tasks.filter((task) => task.status === "failed").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  if (failed > 0) {
    return {
      color: "error",
      text: `${plural(failed, "task")} failed${completed > 0 ? ` · ${plural(completed, "task")} completed` : ""}`,
    };
  }
  if (completed > 0) {
    return { color: "success", text: `${plural(completed, "task")} completed` };
  }
  return { color: "warning", text: `${plural(tasks.length, "task")} finished` };
};

export const renderCompletionMessage = function renderCompletionMessage(
  message: RenderableCompletionMessage,
  options: MessageRenderOptions,
  theme: Theme
): Component {
  const details = message.details;
  if (!details || details.tasks.length === 0) {
    return new Text(
      theme.fg("customMessageText", "Background task update"),
      options.outputPad,
      0
    );
  }

  const summary = completionSummary(details.tasks);
  const lines = [
    theme.fg(summary.color, theme.bold(summary.text)),
  ];
  const visibleTasks = options.expanded
    ? details.tasks
    : details.tasks.slice(0, COLLAPSED_TASK_ROWS);
  let outputLinesUsed = 0;

  for (const task of visibleTasks) {
    const presentation = STATUS_PRESENTATION[task.status];
    const terminal =
      typeof task.exitCode === "number"
        ? ` · exit ${String(task.exitCode)}`
        : task.signal
          ? ` · ${task.signal}`
          : "";
    lines.push(
      `${theme.fg(presentation.color, `${presentation.symbol} ${presentation.label}`)} · ${theme.fg("text", cleanInline(task.name))} · ${theme.fg("accent", task.id)}${theme.fg("dim", terminal)}`
    );
    if (task.error) {
      lines.push(`  ${theme.fg("error", cleanInline(task.error))}`);
    }
    if (
      options.expanded &&
      task.output !== undefined &&
      outputLinesUsed < MAX_COMPLETION_OUTPUT_LINES
    ) {
      const output = cleanDisplay(task.output).split("\n");
      const remaining = MAX_COMPLETION_OUTPUT_LINES - outputLinesUsed;
      const selected = output.slice(
        -Math.min(EXPANDED_COMPLETION_OUTPUT_LINES, remaining)
      );
      outputLinesUsed += selected.length;
      for (const line of selected) {
        lines.push(
          `  ${theme.fg("borderMuted", ">")} ${theme.fg("customMessageText", line || " ")}`
        );
      }
      if (task.outputTruncated || output.length > selected.length) {
        lines.push(`  ${theme.fg("dim", "… output tail truncated")}`);
      }
    } else if (options.expanded && task.outputError) {
      lines.push(
        `  ${theme.fg("warning", `Output unavailable: ${cleanInline(task.outputError)}`)}`
      );
    }
  }

  const hidden = details.tasks.length - visibleTasks.length;
  if (hidden > 0 || details.omitted > 0) {
    lines.push(
      theme.fg(
        "dim",
        `… ${plural(hidden + details.omitted, "additional task")} not shown`
      )
    );
  }
  if (
    !options.expanded &&
    details.tasks.some((task) => task.output !== undefined)
  ) {
    lines.push(theme.fg("dim", keyHint("app.tools.expand", "show output tails")));
  }

  const box = new Box(
    options.outputPad,
    0,
    (text: string) => theme.bg("customMessageBg", text)
  );
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
};

interface DashboardManager {
  list(): TaskSnapshot[];
  logs(
    idOrPrefix: string,
    requestedBytes?: number,
    afterByte?: number
  ): Promise<TaskLogs>;
  stop(idOrPrefix: string): TaskSnapshot;
}

/** User-facing log cursors shared by dashboard instances in one session. */
export class TaskDashboardReadState {
  readonly #cursors = new Map<string, number>();

  cursor(taskId: string): number {
    return this.#cursors.get(taskId) ?? 0;
  }

  markRead(taskId: string, nextByte: number): void {
    const cursor = Math.max(0, Math.floor(nextByte));
    this.#cursors.set(taskId, Math.max(this.cursor(taskId), cursor));
  }

  retain(taskIds: ReadonlySet<string>): void {
    for (const taskId of this.#cursors.keys()) {
      if (!taskIds.has(taskId)) {
        this.#cursors.delete(taskId);
      }
    }
  }

  unreadBytes(task: TaskSnapshot): number {
    return Math.max(0, task.bytesWritten - this.cursor(task.id));
  }
}

interface DashboardFlash {
  color: "error" | "success" | "warning" | "dim";
  expiresAt: number;
  text: string;
}

const clamp = function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
};

const keyLabel = function keyLabel(value: string): string {
  const labels: Record<string, string> = {
    down: "↓",
    enter: "Enter",
    escape: "Esc",
    pageDown: "PgDn",
    pageUp: "PgUp",
    return: "Enter",
    up: "↑",
  };
  return labels[value] ?? value.replaceAll("ctrl+", "Ctrl+").replaceAll("alt+", "Alt+");
};

/** Interactive, auto-refreshing task monitor used by /background-tasks. */
export class TaskDashboardComponent implements Component {
  readonly #manager: DashboardManager;
  readonly #theme: Theme;
  readonly #tui: TUI;
  readonly #keybindings: KeybindingsManager;
  readonly #onClose: () => void;
  readonly #readState: TaskDashboardReadState;
  #tasks: TaskSnapshot[] = [];
  #selectedIndex = 0;
  #showLogs = false;
  #logs: TaskLogs | undefined;
  #logsTaskId: string | undefined;
  #loadingLogs = false;
  #activeLogRequests = 0;
  #logRequestSequence = 0;
  #flash: DashboardFlash | undefined;
  #confirmStopTaskId: string | undefined;
  #confirmStopUntil = 0;
  #lastListRows = 4;
  #disposed = false;
  #interval: NodeJS.Timeout;

  constructor(options: {
    keybindings: KeybindingsManager;
    manager: BackgroundTaskManager | DashboardManager;
    onClose: () => void;
    readState?: TaskDashboardReadState;
    theme: Theme;
    tui: TUI;
  }) {
    this.#manager = options.manager;
    this.#theme = options.theme;
    this.#tui = options.tui;
    this.#keybindings = options.keybindings;
    this.#onClose = options.onClose;
    this.#readState = options.readState ?? new TaskDashboardReadState();
    this.refresh();
    this.#interval = setInterval(() => this.refresh(), DASHBOARD_REFRESH_MS);
    this.#interval.unref();
  }

  refresh(forceLogs = false): void {
    if (this.#disposed) {
      return;
    }
    const selectedId = this.#tasks[this.#selectedIndex]?.id;
    try {
      this.#tasks = this.#manager.list();
      this.#readState.retain(new Set(this.#tasks.map((task) => task.id)));
      if (selectedId) {
        const nextIndex = this.#tasks.findIndex((task) => task.id === selectedId);
        this.#selectedIndex = nextIndex >= 0 ? nextIndex : this.#selectedIndex;
      }
      this.#selectedIndex = clamp(
        this.#selectedIndex,
        0,
        Math.max(0, this.#tasks.length - 1)
      );
      if (this.#showLogs) {
        void this.#loadLogs(forceLogs);
      }
      if (this.#flash && this.#flash.expiresAt <= Date.now()) {
        this.#flash = undefined;
      }
      if (this.#confirmStopUntil <= Date.now()) {
        this.#confirmStopTaskId = undefined;
      }
    } catch (error) {
      this.#setFlash(
        "error",
        `Could not refresh tasks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.#keybindings.matches(data, "tui.select.cancel")) {
      if (this.#confirmStopTaskId) {
        this.#confirmStopTaskId = undefined;
        this.#flash = undefined;
        this.#tui.requestRender();
      } else {
        this.#onClose();
      }
      return;
    }
    if (
      this.#keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.#moveSelection(-1);
      return;
    }
    if (
      this.#keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      this.#moveSelection(1);
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.pageUp")) {
      this.#moveSelection(-this.#lastListRows);
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.pageDown")) {
      this.#moveSelection(this.#lastListRows);
      return;
    }
    if (matchesKey(data, "home")) {
      this.#moveSelection(-this.#tasks.length);
      return;
    }
    if (matchesKey(data, "end")) {
      this.#moveSelection(this.#tasks.length);
      return;
    }
    if (
      this.#keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, "l")
    ) {
      if (this.#tasks.length > 0) {
        this.#showLogs = !this.#showLogs;
        this.#logRequestSequence += 1;
        this.#logs = undefined;
        this.#logsTaskId = undefined;
        if (this.#showLogs) {
          void this.#loadLogs(true);
        }
        this.#tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "r")) {
      this.#setFlash("dim", "Refreshed task state");
      this.refresh(true);
      return;
    }
    if (matchesKey(data, "x")) {
      this.#requestStop();
    }
  }

  render(width: number): string[] {
    const maxHeight = Math.max(
      1,
      Math.floor(Math.max(1, this.#tui.terminal.rows) * 0.9)
    );
    if (maxHeight < 13) {
      return this.#renderCompact(width, maxHeight);
    }

    const usableRows = maxHeight - 9;
    const listRows = clamp(
      Math.floor(usableRows * 0.5),
      2,
      Math.min(8, Math.max(2, this.#tasks.length))
    );
    const detailRows = Math.max(
      2,
      Math.min(this.#showLogs ? 8 : 5, usableRows - listRows)
    );
    this.#lastListRows = listRows;

    const lines = [
      this.#horizontal(width, "top"),
      this.#frame(width, this.#title(width)),
      this.#frame(width, this.#summary()),
      this.#horizontal(width, "middle"),
      ...this.#taskLines(width, listRows),
      this.#horizontal(width, "middle"),
      this.#frame(width, this.#detailTitle()),
      ...this.#detailLines(width, detailRows),
      this.#horizontal(width, "middle"),
      this.#frame(width, this.#footer()),
      this.#horizontal(width, "bottom"),
    ];
    return lines.slice(0, maxHeight);
  }

  invalidate(): void {
    // Theme colors are computed during every render, so there is no themed cache.
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    clearInterval(this.#interval);
  }

  #renderCompact(width: number, maxHeight: number): string[] {
    const taskRows = Math.max(0, maxHeight - 6);
    this.#lastListRows = Math.max(1, taskRows);
    const lines = [
      this.#horizontal(width, "top"),
      this.#frame(width, this.#title(width)),
      this.#frame(width, this.#summary()),
      this.#horizontal(width, "middle"),
      ...this.#taskLines(width, taskRows),
      this.#frame(width, this.#footer()),
      this.#horizontal(width, "bottom"),
    ];
    if (lines.length <= maxHeight) {
      return lines;
    }
    return [
      ...lines.slice(0, Math.max(1, maxHeight - 2)),
      this.#frame(width, this.#footer()),
      this.#horizontal(width, "bottom"),
    ].slice(0, maxHeight);
  }

  #horizontal(width: number, position: "top" | "middle" | "bottom"): string {
    if (width <= 1) {
      return this.#theme.fg("borderMuted", "-".slice(0, width));
    }
    const left = "+";
    const right = "+";
    return this.#theme.fg(
      position === "middle" ? "borderMuted" : "border",
      `${left}${"-".repeat(Math.max(0, width - 2))}${right}`
    );
  }

  #frame(width: number, content: string, selected = false): string {
    if (width <= 1) {
      const body = truncateToWidth(content, Math.max(0, width), "", true);
      return body + " ".repeat(Math.max(0, width - visibleWidth(body)));
    }
    const innerWidth = Math.max(0, width - 2);
    let body = truncateToWidth(content, innerWidth, "…", true);
    body += " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
    const borderColor = selected ? "borderAccent" : "border";
    return (
      this.#theme.fg(borderColor, "|") +
      body +
      this.#theme.fg(borderColor, "|")
    );
  }

  #title(width: number): string {
    const left = ` ${this.#theme.fg("accent", this.#theme.bold("Background tasks"))}`;
    const right = this.#theme.fg("dim", "auto-refresh 1s ");
    const innerWidth = Math.max(0, width - 2);
    if (visibleWidth(left) + visibleWidth(right) + 2 > innerWidth) {
      return left;
    }
    return `${left}${" ".repeat(innerWidth - visibleWidth(left) - visibleWidth(right))}${right}`;
  }

  #summary(): string {
    const count = (status: TaskStatus) =>
      this.#tasks.filter((task) => task.status === status).length;
    const parts = [
      `${STATUS_PRESENTATION.running.symbol} ${String(count("running"))} running`,
      count("stopping") > 0
        ? `${STATUS_PRESENTATION.stopping.symbol} ${String(count("stopping"))} stopping`
        : undefined,
      `${STATUS_PRESENTATION.completed.symbol} ${String(count("completed"))} completed`,
      count("failed") > 0
        ? `${STATUS_PRESENTATION.failed.symbol} ${String(count("failed"))} failed`
        : undefined,
      count("stopped") > 0
        ? `${STATUS_PRESENTATION.stopped.symbol} ${String(count("stopped"))} stopped`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    const position =
      this.#tasks.length === 0
        ? ""
        : ` · selected ${String(this.#selectedIndex + 1)}/${String(this.#tasks.length)}`;
    return ` ${parts.join(" · ")}${this.#theme.fg("dim", position)}`;
  }

  #taskLines(width: number, rows: number): string[] {
    if (rows <= 0) {
      return [];
    }
    if (this.#tasks.length === 0) {
      return [
        this.#frame(
          width,
          ` ${this.#theme.fg("dim", "○ No tasks yet. Tasks started by the agent will appear here.")}`
        ),
        ...Array.from({ length: Math.max(0, rows - 1) }, () =>
          this.#frame(width, "")
        ),
      ];
    }

    const maxStart = Math.max(0, this.#tasks.length - rows);
    const start = clamp(
      this.#selectedIndex - Math.floor(rows / 2),
      0,
      maxStart
    );
    const visible = this.#tasks.slice(start, start + rows);
    const lines = visible.map((task, index) => {
      const absoluteIndex = start + index;
      const selected = absoluteIndex === this.#selectedIndex;
      const policy =
        effectiveCompletionPolicy(task, "notify") === "wake"
          ? this.#theme.fg("accent", " ↻")
          : "";
      const terminal = terminalSummary(task);
      const content = [
        selected ? this.#theme.fg("accent", " ›") : "  ",
        styledStatus(task.status, this.#theme, false),
        this.#theme.fg("muted", taskDuration(task).padStart(6)),
        this.#theme.fg("accent", task.id),
        this.#theme.fg("text", cleanInline(task.name)),
        terminal ? this.#theme.fg("muted", `(${terminal})`) : "",
        policy,
      ]
        .filter(Boolean)
        .join(" ");
      return this.#frame(width, content, selected);
    });
    while (lines.length < rows) {
      lines.push(this.#frame(width, ""));
    }
    return lines;
  }

  #detailTitle(): string {
    const task = this.#tasks[this.#selectedIndex];
    if (!task) {
      return ` ${this.#theme.fg("dim", "Task details")}`;
    }
    if (this.#showLogs) {
      const counts =
        this.#logs?.bytesRead === undefined
          ? ""
          : this.#logs.truncated
            ? ` · tail ${formatUiBytes(this.#logs.bytesRead)} of ${formatUiBytes(this.#logs.totalBytes)}`
            : ` · ${formatUiBytes(this.#logs.totalBytes)}`;
      return ` ${this.#theme.fg("accent", this.#theme.bold("Log tail"))} · ${this.#theme.fg("text", cleanInline(task.name))}${this.#theme.fg("dim", counts)}`;
    }
    return ` ${styledStatus(task.status, this.#theme)} · ${this.#theme.fg("text", this.#theme.bold(cleanInline(task.name)))}`;
  }

  #detailLines(width: number, rows: number): string[] {
    const task = this.#tasks[this.#selectedIndex];
    let details: string[];
    if (!task) {
      details = [this.#theme.fg("dim", " Start a background task to inspect it here.")];
    } else if (this.#showLogs) {
      details = this.#logDetailLines(task, rows);
    } else {
      const metadata = [
        `ID ${task.id}`,
        task.pid === undefined ? undefined : `PID ${String(task.pid)}`,
        `policy ${effectiveCompletionPolicy(task, "notify")!}`,
        task.timeoutSeconds === undefined
          ? undefined
          : `timeout ${formatUiDuration(task.timeoutSeconds * 1000)}`,
      ].filter((value): value is string => value !== undefined);
      details = [
        task.error ? ` ${this.#theme.fg("error", cleanInline(task.error))}` : undefined,
        ` ${this.#theme.fg("dim", "Command")}  ${cleanInline(task.command)}`,
        ` ${this.#theme.fg("dim", "Process")}  ${metadata.join(" · ")}`,
        ` ${this.#theme.fg("dim", "Folder")}   ${cleanInline(task.cwd)}`,
        ` ${this.#theme.fg("dim", "Log")}      ${cleanInline(task.logPath)}`,
      ].filter((value): value is string => value !== undefined);
    }

    const visible = details.slice(0, rows);
    while (visible.length < rows) {
      visible.push("");
    }
    return visible.map((line) => this.#frame(width, line));
  }

  #logDetailLines(task: TaskSnapshot, rows: number): string[] {
    if (this.#loadingLogs && this.#logsTaskId !== task.id) {
      return [` ${this.#theme.fg("warning", "◐ Loading log tail…")}`];
    }
    if (!this.#logs || this.#logsTaskId !== task.id) {
      return [` ${this.#theme.fg("dim", "No log preview loaded.")}`];
    }
    const output = cleanDisplay(this.#logs.output).split("\n");
    const selected = output.slice(-rows);
    if (output.length > selected.length && selected.length > 0) {
      selected[0] = `… ${plural(output.length - selected.length + 1, "earlier line")} hidden`;
    }
    return selected.map(
      (line) =>
        ` ${this.#theme.fg("borderMuted", ">")} ${this.#theme.fg("toolOutput", line || " ")}`
    );
  }

  #footer(): string {
    if (this.#flash && this.#flash.expiresAt > Date.now()) {
      return ` ${this.#theme.fg(this.#flash.color, this.#flash.text)}`;
    }
    const firstKey = (binding: Parameters<KeybindingsManager["getKeys"]>[0], fallback: string) =>
      keyLabel(this.#keybindings.getKeys(binding)[0] ?? fallback);
    const up = firstKey("tui.select.up", "up");
    const down = firstKey("tui.select.down", "down");
    const confirm = firstKey("tui.select.confirm", "enter");
    const cancel = firstKey("tui.select.cancel", "escape");
    const detailAction = this.#showLogs ? "details" : "logs";
    return ` ${this.#theme.fg("dim", `${up}/${down} or j/k select · ${confirm} ${detailAction} · x stop · r refresh · ${cancel} close`)}`;
  }

  #moveSelection(delta: number): void {
    if (this.#tasks.length === 0) {
      return;
    }
    this.#selectedIndex = clamp(
      this.#selectedIndex + delta,
      0,
      this.#tasks.length - 1
    );
    this.#confirmStopTaskId = undefined;
    this.#flash = undefined;
    if (this.#showLogs) {
      this.#logRequestSequence += 1;
      this.#logs = undefined;
      this.#logsTaskId = undefined;
      void this.#loadLogs(true);
    }
    this.#tui.requestRender();
  }

  #requestStop(): void {
    const task = this.#tasks[this.#selectedIndex];
    if (!task) {
      this.#setFlash("dim", "There is no selected task to stop.");
      return;
    }
    if (task.status !== "running" && task.status !== "stopping") {
      this.#setFlash("dim", `${task.name} is already ${task.status}.`);
      return;
    }
    const now = Date.now();
    if (
      this.#confirmStopTaskId !== task.id ||
      this.#confirmStopUntil <= now
    ) {
      this.#confirmStopTaskId = task.id;
      this.#confirmStopUntil = now + STOP_CONFIRM_MS;
      this.#setFlash(
        "warning",
        `Press x again to stop ${task.name} (${task.id}).`,
        STOP_CONFIRM_MS
      );
      return;
    }
    this.#confirmStopTaskId = undefined;
    try {
      this.#manager.stop(task.id);
      this.#setFlash("success", `Stop requested for ${task.name}.`);
      this.refresh();
    } catch (error) {
      this.#setFlash(
        "error",
        `Could not stop task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  #setFlash(
    color: DashboardFlash["color"],
    text: string,
    duration = 2500
  ): void {
    this.#flash = {
      color,
      expiresAt: Date.now() + duration,
      text: cleanInline(text),
    };
    this.#tui.requestRender();
  }

  async #loadLogs(force = false): Promise<void> {
    const task = this.#tasks[this.#selectedIndex];
    if (!task || this.#disposed) {
      return;
    }
    if (this.#loadingLogs && !force) {
      return;
    }
    const taskId = task.id;
    this.#logRequestSequence += 1;
    const requestSequence = this.#logRequestSequence;
    this.#activeLogRequests += 1;
    this.#loadingLogs = true;
    try {
      const logs = await this.#manager.logs(
        taskId,
        16 * 1024,
        this.#readState.cursor(taskId)
      );
      if (
        this.#disposed ||
        requestSequence !== this.#logRequestSequence ||
        this.#tasks[this.#selectedIndex]?.id !== taskId
      ) {
        return;
      }
      this.#logs = logs;
      this.#logsTaskId = taskId;
      this.#readState.markRead(taskId, logs.nextByte ?? logs.totalBytes);
    } catch (error) {
      if (
        this.#disposed ||
        requestSequence !== this.#logRequestSequence ||
        this.#tasks[this.#selectedIndex]?.id !== taskId
      ) {
        return;
      }
      this.#logs = undefined;
      this.#logsTaskId = undefined;
      this.#setFlash(
        "error",
        `Could not read log: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.#activeLogRequests = Math.max(0, this.#activeLogRequests - 1);
      this.#loadingLogs = this.#activeLogRequests > 0;
      if (!this.#disposed) {
        this.#tui.requestRender();
      }
    }
  }
}
