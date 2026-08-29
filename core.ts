import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

export const MAX_ACTIVE_TASKS = 16;
export const MAX_RECENT_TASKS = 8;
export const MAX_LOG_READ_BYTES = 32 * 1024;
export const MAX_COMPLETION_LOG_BYTES = 2 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const KILL_GRACE_MS = 1000;
export const MAX_WATCHES_PER_TASK = 8;
export const MAX_OUTPUT_PREVIEW_BYTES = 256;
export const MAX_WATCH_PATTERN_BYTES = 512;
export const WATCH_REARM_COOLDOWN_MS = 1000;
export const DEFAULT_SHELL = "sh";
export const BACKGROUND_TASK_SHELL_ENV = "PI_BACKGROUND_TASK_SHELL";
export const BACKGROUND_TASK_SHELL_ARGS_ENV = "PI_BACKGROUND_TASK_SHELL_ARGS";

export type TaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped";

export type CompletionPolicy = "silent" | "notify" | "wake";
export type TaskWatchCondition = "output" | "exit" | "inactivity";
export type TaskWatchStatus = "active" | "fired" | "cancelled" | "expired";

export interface TaskWatchSnapshot {
  id: string;
  taskId: string;
  condition: TaskWatchCondition;
  status: TaskWatchStatus;
  createdAt: number;
  wake: boolean;
  pattern?: string;
  inactivitySeconds?: number;
  endedAt?: number;
  startByte?: number;
  nextByte?: number;
  matchedOutput?: string;
}

export interface TaskOutputEvent {
  task: TaskSnapshot;
  startByte: number;
  nextByte: number;
  preview: string;
  previewTruncated: boolean;
}

export interface TaskWatchEvent {
  task: TaskSnapshot;
  watch: TaskWatchSnapshot;
  output?: string;
  startByte?: number;
  nextByte?: number;
}

export interface CreateTaskWatchInput {
  condition: TaskWatchCondition;
  pattern?: string;
  inactivitySeconds?: number;
  wake?: boolean;
}

export interface TaskSnapshot {
  id: string;
  name: string;
  command: string;
  cwd: string;
  logPath: string;
  status: TaskStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  bytesWritten: number;
  lastOutputAt?: number;
  completionPolicy: CompletionPolicy;
  timeoutSeconds?: number;
  watches?: TaskWatchSnapshot[];
}

export interface StartTaskInput {
  name?: string;
  command: string;
  cwd: string;
  completionPolicy?: CompletionPolicy;
  environment?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
}

export interface TaskLogs {
  task: TaskSnapshot;
  text: string;
  output: string;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  droppedBytes?: number;
  nextByte?: number;
  startByte?: number;
}

export interface TaskCompletion {
  task: TaskSnapshot;
  output?: string;
  outputError?: string;
  outputTruncated?: boolean;
}

type StopReason = "user" | "shutdown" | "timeout" | "output_limit";

type ShellOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type RuntimeWatch = TaskWatchSnapshot & {
  inactivityHandle?: NodeJS.Timeout;
  outputOverlap?: Buffer;
  signature: string;
};

type RuntimeTask = TaskSnapshot & {
  acceptedBytes: number;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stream: WriteStream;
  stopReason?: StopReason;
  outputLimitReached: boolean;
  pendingLogWrites: Set<Promise<void>>;
  finalizing: boolean;
  cleanupPromise?: Promise<string | undefined>;
  completionPromise?: Promise<void>;
  finishedOrder?: number;
  processError?: string;
  shellClosed: Promise<null>;
  shellOutcome?: ShellOutcome;
  closed: Promise<null>;
  resolveClosed: () => void;
  resolveShellClosed: () => void;
  timeoutHandle?: NodeJS.Timeout;
  watchState: Map<string, RuntimeWatch>;
};

export interface BackgroundTaskManagerOptions {
  runtimeDir?: string;
  maxActiveTasks?: number;
  maxRecentTasks?: number;
  maxRetainedTasks?: number;
  maxOutputBytes?: number;
  maxWatchesPerTask?: number;
  watchRearmCooldownMs?: number;
  killGraceMs?: number;
  shell?: string;
  shellArgs?: readonly string[];
  writeLogChunk?: (
    stream: WriteStream,
    data: Buffer,
    callback: (error?: Error | null) => void
  ) => boolean;
  onChange?: () => void;
  onFinished?: (completion: TaskCompletion) => void;
  onOutput?: (event: TaskOutputEvent) => void;
  onStarted?: (task: TaskSnapshot) => void;
  onWatchFired?: (event: TaskWatchEvent) => void;
}

/** Observer callbacks one extension instance binds to a manager. */
export interface BackgroundTaskCallbacks {
  onChange?: () => void;
  onFinished?: (completion: TaskCompletion) => void;
  onOutput?: (event: TaskOutputEvent) => void;
  onStarted?: (task: TaskSnapshot) => void;
  onWatchFired?: (event: TaskWatchEvent) => void;
}

const parseShellArguments = function parseShellArguments(
  value: string | undefined
): string[] {
  if (value === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${BACKGROUND_TASK_SHELL_ARGS_ENV} must be a JSON string array`,
      { cause: error }
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((argument) => typeof argument === "string")
  ) {
    throw new Error(
      `${BACKGROUND_TASK_SHELL_ARGS_ENV} must be a JSON string array`
    );
  }
  return parsed;
};

const isActiveStatus = function isActiveStatus(status: TaskStatus): boolean {
  return status === "running" || status === "stopping";
};

const cleanName = function cleanName(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");
  return [...normalized].slice(0, 60).join("");
};

export const deriveTaskName = function deriveTaskName(command: string): string {
  const name = cleanName(command).split(" ").slice(0, 5).join(" ");
  return name || "Background task";
};

const formatDuration = function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
};

const truncate = function truncate(value: string, maxLength: number): string {
  const characters = [...value];
  if (characters.length <= maxLength) {
    return value;
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
};

const appendError = function appendError(
  current: string | undefined,
  next: string
): string {
  return current ? `${current}; ${next}` : next;
};

export const escapeXml = function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
};

export const formatTaskList = function formatTaskList(
  tasks: readonly TaskSnapshot[],
  now = Date.now()
): string {
  if (tasks.length === 0) {
    return "No background tasks.";
  }

  const active = tasks.filter((task) => isActiveStatus(task.status));
  const recent = tasks.filter((task) => !isActiveStatus(task.status));
  const line = (task: TaskSnapshot): string => {
    const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt);
    let terminal = "";
    if (typeof task.exitCode === "number") {
      terminal = ` exit=${String(task.exitCode)}`;
    } else if (task.signal) {
      terminal = ` signal=${task.signal}`;
    }
    const policy = ` policy=${task.completionPolicy}`;
    const watches = task.watches?.length
      ? ` watches=${String(task.watches.length)}`
      : "";
    const error = task.error ? ` error=${truncate(task.error, 120)}` : "";
    return `${task.id} ${task.status} ${elapsed}${terminal}${policy}${watches}: ${task.name}${error}\n  log: ${task.logPath}`;
  };

  return [
    active.length > 0
      ? `Active:\n${active.map(line).join("\n")}`
      : "Active: none",
    recent.length > 0
      ? `Recent:\n${recent.map(line).join("\n")}`
      : "Recent: none",
  ].join("\n\n");
};

export const formatModelContext = function formatModelContext(
  tasks: readonly TaskSnapshot[]
): string {
  if (tasks.length === 0) {
    return "";
  }

  const active = tasks.filter((task) => isActiveStatus(task.status));
  const failures = tasks.filter((task) => task.status === "failed");
  if (active.length === 0 && failures.length === 0) {
    return "";
  }
  const lines = ["<background-tasks>"];

  if (active.length > 0) {
    lines.push("Active:");
    for (const task of active) {
      const policy = `, completion policy ${task.completionPolicy}`;
      const activeWatches =
        task.watches?.filter((watch) => watch.status === "active").length ?? 0;
      const watches = activeWatches
        ? `, ${String(activeWatches)} active ${activeWatches === 1 ? "watch" : "watches"}`
        : "";
      lines.push(
        `- ${task.id} [${task.status}${policy}${watches}] ${escapeXml(task.name)}`
      );
    }
  }

  if (failures.length > 0) {
    lines.push("Unacknowledged failures:");
    for (const task of failures) {
      let terminal = "";
      if (typeof task.exitCode === "number") {
        terminal = `, exit ${String(task.exitCode)}`;
      } else if (task.signal) {
        terminal = `, signal ${task.signal}`;
      }
      const error = task.error
        ? `; error: ${escapeXml(truncate(task.error, 240))}`
        : "";
      lines.push(
        `- ${task.id} [failed${terminal}] ${escapeXml(task.name)}${error}`
      );
    }
  }

  lines.push(
    "Use background_task for status or logs only when details are needed; do not poll.",
    "</background-tasks>"
  );
  return lines.join("\n");
};

export class BackgroundTaskManager {
  readonly #tasks = new Map<string, RuntimeTask>();
  readonly #watches = new Map<string, RuntimeWatch>();
  readonly #watchCooldowns = new Map<string, number>();
  readonly #maxActiveTasks: number;
  readonly #maxRecentTasks: number;
  readonly #maxRetainedTasks: number;
  readonly #maxOutputBytes: number;
  readonly #maxWatchesPerTask: number;
  readonly #watchRearmCooldownMs: number;
  readonly #killGraceMs: number;
  readonly #shell: string;
  readonly #shellArgs: readonly string[];
  readonly #writeLogChunk: (
    stream: WriteStream,
    data: Buffer,
    callback: (error?: Error | null) => void
  ) => boolean;
  #callbacks: BackgroundTaskCallbacks = {};
  readonly #ownsRuntimeDir: boolean;
  #runtimeDir: string | undefined;
  #initializePromise: Promise<string> | undefined;
  #pendingStarts = 0;
  #finishedSequence = 0;
  #shuttingDown = false;

  constructor(options: BackgroundTaskManagerOptions = {}) {
    this.#runtimeDir = options.runtimeDir;
    this.#ownsRuntimeDir = options.runtimeDir === undefined;
    this.#maxActiveTasks = options.maxActiveTasks ?? MAX_ACTIVE_TASKS;
    this.#maxRecentTasks = options.maxRecentTasks ?? MAX_RECENT_TASKS;
    this.#maxRetainedTasks = Math.max(
      this.#maxRecentTasks,
      options.maxRetainedTasks ?? this.#maxActiveTasks
    );
    this.#maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.#maxWatchesPerTask =
      options.maxWatchesPerTask ?? MAX_WATCHES_PER_TASK;
    this.#watchRearmCooldownMs =
      options.watchRearmCooldownMs ?? WATCH_REARM_COOLDOWN_MS;
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#shell =
      options.shell ??
      (process.env[BACKGROUND_TASK_SHELL_ENV]?.trim() || DEFAULT_SHELL);
    this.#shellArgs = [
      ...(options.shellArgs ??
        parseShellArguments(process.env[BACKGROUND_TASK_SHELL_ARGS_ENV])),
    ];
    this.#writeLogChunk =
      options.writeLogChunk ??
      ((stream, data, callback) => stream.write(data, callback));
    this.#callbacks = {
      onChange: options.onChange,
      onFinished: options.onFinished,
      onOutput: options.onOutput,
      onStarted: options.onStarted,
      onWatchFired: options.onWatchFired,
    };
  }

  async initialize(): Promise<string> {
    if (!this.#initializePromise) {
      this.#initializePromise = (async () => {
        if (this.#runtimeDir) {
          await mkdir(this.#runtimeDir, { recursive: true });
          return this.#runtimeDir;
        }
        const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-background-"));
        this.#runtimeDir = runtimeDir;
        return runtimeDir;
      })();
    }
    const initializePromise = this.#initializePromise;
    try {
      return await initializePromise;
    } catch (error) {
      this.#initializePromise = undefined;
      throw error;
    }
  }

  isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Replace every observer callback so only the newest owner is notified. */
  bindCallbacks(callbacks: BackgroundTaskCallbacks): void {
    this.#callbacks = { ...callbacks };
  }

  /** Stop notifying the current owner without changing task state. */
  detachCallbacks(): void {
    this.#callbacks = {};
  }

  list(): TaskSnapshot[] {
    const active = [...this.#tasks.values()].filter((task) =>
      isActiveStatus(task.status)
    );
    const recent = [...this.#tasks.values()]
      .filter((task) => !isActiveStatus(task.status))
      .toSorted(
        (left, right) => (right.finishedOrder ?? 0) - (left.finishedOrder ?? 0)
      )
      .slice(0, this.#maxRecentTasks);
    return [...active, ...recent].map((task) =>
      BackgroundTaskManager.#snapshot(task)
    );
  }

  status(idOrPrefix?: string): TaskSnapshot[] {
    if (!idOrPrefix?.trim()) {
      return this.list();
    }
    return [BackgroundTaskManager.#snapshot(this.#resolve(idOrPrefix))];
  }

  watch(
    idOrPrefix: string,
    input: CreateTaskWatchInput
  ): TaskWatchSnapshot {
    const task = this.#resolve(idOrPrefix);
    if (!isActiveStatus(task.status)) {
      throw new Error(`Cannot watch task ${task.id} because it is ${task.status}`);
    }
    const pattern = input.pattern;
    const inactivitySeconds = input.inactivitySeconds;
    if (input.condition === "output") {
      if (!pattern) {
        throw new Error("pattern is required for an output watch");
      }
      if (Buffer.byteLength(pattern) > MAX_WATCH_PATTERN_BYTES) {
        throw new Error(
          `Watch patterns are limited to ${String(MAX_WATCH_PATTERN_BYTES)} bytes`
        );
      }
      if (inactivitySeconds !== undefined) {
        throw new Error("inactivitySeconds is valid only for inactivity watches");
      }
    } else if (input.condition === "inactivity") {
      if (
        typeof inactivitySeconds !== "number" ||
        !Number.isFinite(inactivitySeconds) ||
        inactivitySeconds <= 0
      ) {
        throw new Error(
          "inactivitySeconds must be a positive number for an inactivity watch"
        );
      }
      if (pattern !== undefined) {
        throw new Error("pattern is valid only for output watches");
      }
    } else if (input.condition === "exit") {
      if (pattern !== undefined || inactivitySeconds !== undefined) {
        throw new Error("Exit watches do not accept a pattern or inactivitySeconds");
      }
    } else {
      throw new Error(`Unsupported watch condition: ${String(input.condition)}`);
    }

    const active = [...task.watchState.values()].filter(
      (watch) => watch.status === "active"
    );
    if (active.length >= this.#maxWatchesPerTask) {
      throw new Error(
        `At most ${String(this.#maxWatchesPerTask)} watches may be active for one task`
      );
    }
    if (
      active.some(
        (watch) =>
          watch.condition === input.condition &&
          watch.pattern === pattern &&
          watch.inactivitySeconds === inactivitySeconds
      )
    ) {
      throw new Error("An identical watch is already active for this task");
    }
    const signature = BackgroundTaskManager.#watchSignature(task.id, input);
    const lastFiredAt = this.#watchCooldowns.get(signature);
    if (
      lastFiredAt !== undefined &&
      Date.now() - lastFiredAt < this.#watchRearmCooldownMs
    ) {
      throw new Error("An identical watch is still in its rearm cooldown");
    }

    const id = this.#newWatchId();
    const watch: RuntimeWatch = {
      condition: input.condition,
      createdAt: Date.now(),
      id,
      inactivitySeconds,
      outputOverlap:
        input.condition === "output" ? Buffer.alloc(0) : undefined,
      pattern,
      signature,
      status: "active",
      taskId: task.id,
      wake: input.wake ?? false,
    };
    task.watchState.set(id, watch);
    this.#watches.set(id, watch);
    if (watch.condition === "inactivity") {
      this.#scheduleInactivityWatch(task, watch);
    }
    this.#notifyChange();
    return BackgroundTaskManager.#watchSnapshot(watch);
  }

  unwatch(idOrPrefix: string): TaskWatchSnapshot {
    const watch = this.#resolveWatch(idOrPrefix);
    if (watch.status !== "active") {
      throw new Error(`Watch ${watch.id} is already ${watch.status}`);
    }
    if (watch.inactivityHandle) {
      clearTimeout(watch.inactivityHandle);
      watch.inactivityHandle = undefined;
    }
    watch.status = "cancelled";
    watch.endedAt = Date.now();
    this.#notifyChange();
    return BackgroundTaskManager.#watchSnapshot(watch);
  }

  watchStatus(taskIdOrPrefix?: string): TaskWatchSnapshot[] {
    const watches = taskIdOrPrefix?.trim()
      ? [...this.#resolve(taskIdOrPrefix).watchState.values()]
      : [...this.#watches.values()];
    return watches.map((watch) => BackgroundTaskManager.#watchSnapshot(watch));
  }

  async start(input: StartTaskInput): Promise<TaskSnapshot> {
    if (process.platform === "win32") {
      throw new Error("background_task currently supports POSIX systems only");
    }
    if (this.#shuttingDown) {
      throw new Error("Cannot start a task while Pi is shutting down");
    }

    const command = input.command.trim();
    if (!command) {
      throw new Error("command is required for action=start");
    }
    const activeCount = [...this.#tasks.values()].filter((task) =>
      isActiveStatus(task.status)
    ).length;
    if (activeCount + this.#pendingStarts >= this.#maxActiveTasks) {
      throw new Error(
        `At most ${String(this.#maxActiveTasks)} background tasks may run at once`
      );
    }

    this.#pendingStarts += 1;
    try {
      const runtimeDir = await this.initialize();
      if (this.#shuttingDown) {
        throw new Error("Cannot start a task while Pi is shutting down");
      }
      const id = this.#newTaskId();
      const logPath = path.join(runtimeDir, `${id}.log`);
      const logFile = await open(logPath, "a");
      if (this.#shuttingDown) {
        await logFile.close();
        throw new Error("Cannot start a task while Pi is shutting down");
      }
      const stream = logFile.createWriteStream({ encoding: "utf-8" });

      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(this.#shell, [...this.#shellArgs, "-c", command], {
          cwd: input.cwd,
          detached: true,
          env: input.environment ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const streamClosed = finished(stream);
        stream.destroy();
        try {
          await streamClosed;
        } catch {
          // The spawn error below is the useful failure.
        }
        try {
          rmSync(logPath, { force: true });
        } catch {
          // Cleanup is best effort.
        }
        throw new Error(
          `Failed to start background task: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      const closed = Promise.withResolvers<null>();
      const shellClosed = Promise.withResolvers<null>();
      const timeoutSeconds =
        typeof input.timeoutSeconds === "number" &&
        Number.isFinite(input.timeoutSeconds) &&
        input.timeoutSeconds > 0
          ? Math.max(1, Math.floor(input.timeoutSeconds))
          : undefined;
      const task: RuntimeTask = {
        acceptedBytes: 0,
        bytesWritten: 0,
        child,
        closed: closed.promise,
        command,
        cwd: input.cwd,
        finalizing: false,
        id,
        logPath,
        name: cleanName(input.name ?? "") || deriveTaskName(command),
        outputLimitReached: false,
        pendingLogWrites: new Set(),
        pid: child.pid,
        resolveClosed: () => closed.resolve(null),
        resolveShellClosed: () => shellClosed.resolve(null),
        shellClosed: shellClosed.promise,
        startedAt: Date.now(),
        status: "running",
        stream,
        timeoutSeconds,
        completionPolicy: input.completionPolicy ?? "notify",
        watchState: new Map(),
      };
      this.#tasks.set(id, task);

      stream.on("error", (error) => {
        if (!isActiveStatus(task.status)) {
          return;
        }
        task.error = appendError(
          task.error,
          `Log write failed: ${error.message}`
        );
        this.#beginStop(task, "output_limit");
      });
      child.stdout.on("data", (data: Buffer | string) => {
        this.#writeOutput(task, data, child.stdout);
      });
      child.stderr.on("data", (data: Buffer | string) => {
        this.#writeOutput(task, data, child.stderr);
      });
      child.once("error", (error) => {
        task.processError = error.message;
      });
      child.once("close", (code, signal) => {
        task.shellOutcome = { code, signal };
        task.resolveShellClosed();
        if (task.status === "running") {
          task.status = "stopping";
          if (task.timeoutHandle) {
            clearTimeout(task.timeoutHandle);
            task.timeoutHandle = undefined;
          }
          this.#notifyChange();
        }
        void this.#finishAfterCleanup(task);
      });

      if (timeoutSeconds !== undefined) {
        task.timeoutHandle = setTimeout(() => {
          if (!isActiveStatus(task.status)) {
            return;
          }
          task.error = `Timed out after ${String(timeoutSeconds)}s`;
          this.#beginStop(task, "timeout");
        }, timeoutSeconds * 1000);
        task.timeoutHandle.unref();
      }

      this.#notifyChange();
      const snapshot = BackgroundTaskManager.#snapshot(task);
      try {
        this.#callbacks.onStarted?.(snapshot);
      } catch {
        // A start observer failure must not change task state.
      }
      return snapshot;
    } finally {
      this.#pendingStarts -= 1;
    }
  }

  stop(idOrPrefix: string): TaskSnapshot {
    const task = this.#resolve(idOrPrefix);
    if (!isActiveStatus(task.status)) {
      throw new Error(`Task ${task.id} is already ${task.status}`);
    }
    if (task.status === "running") {
      this.#beginStop(task, "user");
    }
    return BackgroundTaskManager.#snapshot(task);
  }

  async logs(
    idOrPrefix: string,
    requestedBytes = MAX_LOG_READ_BYTES,
    afterByte?: number
  ): Promise<TaskLogs> {
    const task = this.#resolve(idOrPrefix);
    const maxBytes = Math.max(
      1,
      Math.min(
        MAX_LOG_READ_BYTES,
        Number.isFinite(requestedBytes)
          ? Math.floor(requestedBytes)
          : MAX_LOG_READ_BYTES
      )
    );
    const file = await open(task.logPath, "r");
    try {
      const stats = await file.stat();
      const totalBytes = Math.min(stats.size, task.bytesWritten);
      if (afterByte !== undefined) {
        const requestedStart = Math.min(
          totalBytes,
          Math.max(
            0,
            Number.isFinite(afterByte) ? Math.floor(afterByte) : 0
          )
        );
        let startByte = requestedStart;
        if (startByte < totalBytes) {
          const boundary = Buffer.alloc(
            Math.min(3, totalBytes - startByte)
          );
          await file.read(boundary, 0, boundary.length, startByte);
          while (
            startByte - requestedStart < boundary.length &&
            BackgroundTaskManager.#isUtf8Continuation(
              boundary[startByte - requestedStart]
            )
          ) {
            startByte += 1;
          }
        }
        const droppedBytes = startByte - requestedStart;
        const availableBytes = totalBytes - startByte;
        const readCapacity = Math.min(availableBytes, maxBytes + 3);
        const candidate = Buffer.alloc(readCapacity);
        if (readCapacity > 0) {
          await file.read(candidate, 0, readCapacity, startByte);
        }
        let bytesRead = BackgroundTaskManager.#completeUtf8PrefixLength(
          candidate,
          maxBytes
        );
        if (bytesRead === 0 && candidate.length > 0 && readCapacity === availableBytes) {
          bytesRead = Math.min(candidate.length, maxBytes);
        }
        const output = candidate.subarray(0, bytesRead).toString("utf-8");
        const nextByte = startByte + bytesRead;
        const truncated = nextByte < totalBytes;
        const range = `[Bytes ${String(startByte)}-${String(nextByte)} of ${String(totalBytes)}${droppedBytes > 0 ? `; skipped ${String(droppedBytes)} split UTF-8 ${droppedBytes === 1 ? "byte" : "bytes"}` : ""}]`;
        const body = output || "(no new output)";
        return {
          bytesRead,
          droppedBytes,
          nextByte,
          output,
          startByte,
          task: BackgroundTaskManager.#snapshot(task),
          text: `${range}\n\n${body}\n\nFull log: ${task.logPath}`,
          totalBytes,
          truncated,
        };
      }

      const bytesRead = Math.min(totalBytes, maxBytes);
      const buffer = Buffer.alloc(bytesRead);
      if (bytesRead > 0) {
        await file.read(
          buffer,
          0,
          bytesRead,
          Math.max(0, totalBytes - bytesRead)
        );
      }
      const truncated = totalBytes > bytesRead;
      const prefix = truncated
        ? `[Showing last ${String(bytesRead)} of ${String(totalBytes)} bytes]\n\n`
        : "";
      const decoded = BackgroundTaskManager.#decodeLogTail(buffer, truncated);
      const body =
        decoded ||
        (totalBytes === 0
          ? "(no output yet)"
          : "[No complete UTF-8 character in the selected log tail]");
      return {
        bytesRead,
        output: `${prefix}${body}`,
        task: BackgroundTaskManager.#snapshot(task),
        text: `${prefix}${body}\n\nFull log: ${task.logPath}`,
        totalBytes,
        truncated,
      };
    } finally {
      await file.close();
    }
  }

  async wait(idOrPrefix: string): Promise<TaskSnapshot> {
    const task = this.#resolve(idOrPrefix);
    await task.closed;
    return BackgroundTaskManager.#snapshot(task);
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    this.#shuttingDown = true;
    const initializePromise = this.#initializePromise;
    if (initializePromise) {
      try {
        await initializePromise;
      } catch {
        // There is no runtime directory to clean up after initialization fails.
      }
    }
    const active = [...this.#tasks.values()].filter((task) =>
      isActiveStatus(task.status)
    );
    for (const task of active) {
      this.#beginStop(task, "shutdown");
    }

    await Promise.all(active.map((task) => task.closed));

    if (this.#ownsRuntimeDir && this.#runtimeDir) {
      await rm(this.#runtimeDir, { force: true, recursive: true });
      this.#runtimeDir = undefined;
      this.#initializePromise = undefined;
    }
  }

  static #watchSignature(
    taskId: string,
    input: CreateTaskWatchInput
  ): string {
    return JSON.stringify([
      taskId,
      input.condition,
      input.pattern ?? null,
      input.inactivitySeconds ?? null,
    ]);
  }

  #newWatchId(): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!this.#watches.has(id)) {
        return id;
      }
    }
  }

  #newTaskId(): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!this.#tasks.has(id)) {
        return id;
      }
    }
  }

  #resolveWatch(idOrPrefix: string): RuntimeWatch {
    const query = idOrPrefix.trim();
    if (!query) {
      throw new Error("watchId is required");
    }
    const exact = this.#watches.get(query);
    if (exact) {
      return exact;
    }
    const matches = [...this.#watches.values()].filter((watch) =>
      watch.id.startsWith(query)
    );
    const [match] = matches;
    if (matches.length === 1 && match) {
      return match;
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous watch ID prefix: ${query}`);
    }
    throw new Error(`Unknown watch ID: ${query}`);
  }

  #resolve(idOrPrefix: string): RuntimeTask {
    const query = idOrPrefix.trim();
    if (!query) {
      throw new Error("taskId is required");
    }
    const exact = this.#tasks.get(query);
    if (exact) {
      return exact;
    }
    const matches = [...this.#tasks.values()].filter((task) =>
      task.id.startsWith(query)
    );
    const [match] = matches;
    if (matches.length === 1 && match) {
      return match;
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous task ID prefix: ${query}`);
    }
    throw new Error(`Unknown background task ID: ${query}`);
  }

  static #isUtf8Continuation(byte: number | undefined): boolean {
    return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
  }

  static #completeUtf8PrefixLength(buffer: Buffer, maxBytes: number): number {
    let offset = 0;
    while (offset < buffer.length) {
      const first = buffer[offset];
      let sequenceLength = 1;
      if (first !== undefined && first >= 0xc2 && first <= 0xdf) {
        sequenceLength = 2;
      } else if (first !== undefined && first >= 0xe0 && first <= 0xef) {
        sequenceLength = 3;
      } else if (first !== undefined && first >= 0xf0 && first <= 0xf4) {
        sequenceLength = 4;
      }
      if (offset + sequenceLength > buffer.length) {
        break;
      }
      if (
        sequenceLength > 1 &&
        !buffer
          .subarray(offset + 1, offset + sequenceLength)
          .every((byte) => BackgroundTaskManager.#isUtf8Continuation(byte))
      ) {
        sequenceLength = 1;
      }
      const nextOffset = offset + sequenceLength;
      if (nextOffset > maxBytes && offset > 0) {
        break;
      }
      offset = nextOffset;
      if (offset >= maxBytes) {
        break;
      }
    }
    return offset;
  }

  static #decodeLogTail(buffer: Buffer, truncated: boolean): string {
    if (!truncated) {
      return buffer.toString("utf-8");
    }
    let offset = 0;
    while (offset < buffer.length && offset < 3) {
      const byte = buffer[offset];
      if (byte === undefined || byte < 0x80 || byte > 0xbf) {
        break;
      }
      offset += 1;
    }
    return buffer.subarray(offset).toString("utf-8");
  }

  static #watchSnapshot(watch: RuntimeWatch): TaskWatchSnapshot {
    return {
      condition: watch.condition,
      createdAt: watch.createdAt,
      endedAt: watch.endedAt,
      id: watch.id,
      inactivitySeconds: watch.inactivitySeconds,
      matchedOutput: watch.matchedOutput,
      nextByte: watch.nextByte,
      pattern: watch.pattern,
      startByte: watch.startByte,
      status: watch.status,
      taskId: watch.taskId,
      wake: watch.wake,
    };
  }

  static #snapshot(task: RuntimeTask): TaskSnapshot {
    return {
      bytesWritten: task.bytesWritten,
      command: task.command,
      cwd: task.cwd,
      endedAt: task.endedAt,
      error: task.error,
      exitCode: task.exitCode,
      id: task.id,
      logPath: task.logPath,
      lastOutputAt: task.lastOutputAt,
      name: task.name,
      pid: task.pid,
      signal: task.signal,
      startedAt: task.startedAt,
      status: task.status,
      timeoutSeconds: task.timeoutSeconds,
      completionPolicy: task.completionPolicy,
      watches: [...task.watchState.values()]
        .toSorted((left, right) => {
          if (left.status === "active" && right.status !== "active") {
            return -1;
          }
          if (left.status !== "active" && right.status === "active") {
            return 1;
          }
          return (
            (right.endedAt ?? right.createdAt) -
            (left.endedAt ?? left.createdAt)
          );
        })
        .slice(0, MAX_WATCHES_PER_TASK)
        .map((watch) => BackgroundTaskManager.#watchSnapshot(watch)),
    };
  }

  #writeOutput(
    task: RuntimeTask,
    data: Buffer | string,
    source: NodeJS.ReadableStream
  ): void {
    if (!isActiveStatus(task.status) || task.outputLimitReached) {
      return;
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
    const remaining = Math.max(0, this.#maxOutputBytes - task.acceptedBytes);
    const accepted = buffer.subarray(0, remaining);
    if (accepted.length > 0) {
      task.acceptedBytes += accepted.length;
      task.lastOutputAt = Date.now();
      this.#resetInactivityWatches(task);
      const canContinue = this.#writeLog(task, accepted, true);
      if (!canContinue && "pause" in source && "resume" in source) {
        source.pause();
        task.stream.once("drain", () => source.resume());
      }
    }

    if (accepted.length < buffer.length) {
      task.outputLimitReached = true;
      task.error = `Output exceeded ${String(this.#maxOutputBytes)} bytes`;
      this.#writeLog(
        task,
        Buffer.from(`\n\n[background task stopped: ${task.error}]\n`)
      );
      this.#beginStop(task, "output_limit");
    }
  }

  #writeLog(
    task: RuntimeTask,
    data: Buffer,
    matchOutput = false
  ): boolean {
    const settled = Promise.withResolvers<void>();
    task.pendingLogWrites.add(settled.promise);
    const callback = (error?: Error | null): void => {
      if (!error) {
        const startByte = task.bytesWritten;
        task.bytesWritten += data.length;
        if (matchOutput) {
          this.#matchOutputWatches(task, data, startByte);
          this.#notifyOutput(task, data, startByte);
        }
      }
      task.pendingLogWrites.delete(settled.promise);
      settled.resolve();
    };
    try {
      return this.#writeLogChunk(task.stream, data, callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  #notifyOutput(task: RuntimeTask, data: Buffer, startByte: number): void {
    if (!this.#callbacks.onOutput) {
      return;
    }
    const previewBytes = BackgroundTaskManager.#completeUtf8PrefixLength(
      data,
      MAX_OUTPUT_PREVIEW_BYTES
    );
    const decodedPreview = data.subarray(0, previewBytes).toString("utf-8");
    const encodedPreview = Buffer.from(decodedPreview, "utf-8");
    const boundedPreviewBytes =
      BackgroundTaskManager.#completeUtf8PrefixLength(
        encodedPreview,
        MAX_OUTPUT_PREVIEW_BYTES
      );
    try {
      this.#callbacks.onOutput({
        nextByte: startByte + data.length,
        preview: encodedPreview
          .subarray(0, boundedPreviewBytes)
          .toString("utf-8"),
        previewTruncated:
          previewBytes < data.length || boundedPreviewBytes < encodedPreview.length,
        startByte,
        task: BackgroundTaskManager.#snapshot(task),
      });
    } catch {
      // An output observer failure must not change task state.
    }
  }

  #matchOutputWatches(
    task: RuntimeTask,
    data: Buffer,
    startByte: number
  ): void {
    for (const watch of task.watchState.values()) {
      if (
        watch.status !== "active" ||
        watch.condition !== "output" ||
        !watch.pattern
      ) {
        continue;
      }
      const pattern = Buffer.from(watch.pattern, "utf-8");
      const overlap = watch.outputOverlap ?? Buffer.alloc(0);
      const combined = Buffer.concat([overlap, data]);
      const combinedStart = startByte - overlap.length;
      const matchIndex = combined.indexOf(pattern);
      if (matchIndex >= 0) {
        watch.startByte = combinedStart + matchIndex;
        watch.nextByte = watch.startByte + pattern.length;
        watch.matchedOutput = watch.pattern;
        this.#fireWatch(task, watch, watch.pattern);
        continue;
      }
      const overlapBytes = Math.min(pattern.length - 1, combined.length);
      watch.outputOverlap = combined.subarray(combined.length - overlapBytes);
    }
  }

  #fireWatch(task: RuntimeTask, watch: RuntimeWatch, output?: string): void {
    if (watch.status !== "active") {
      return;
    }
    if (watch.inactivityHandle) {
      clearTimeout(watch.inactivityHandle);
      watch.inactivityHandle = undefined;
    }
    watch.status = "fired";
    watch.endedAt = Date.now();
    watch.outputOverlap = undefined;
    this.#watchCooldowns.set(watch.signature, watch.endedAt);
    const event: TaskWatchEvent = {
      nextByte: watch.nextByte,
      output,
      startByte: watch.startByte,
      task: BackgroundTaskManager.#snapshot(task),
      watch: BackgroundTaskManager.#watchSnapshot(watch),
    };
    this.#notifyChange();
    try {
      this.#callbacks.onWatchFired?.(event);
    } catch {
      // A watch callback failure must not change task state.
    }
  }

  #resetInactivityWatches(task: RuntimeTask): void {
    if (task.status !== "running") {
      return;
    }
    for (const watch of task.watchState.values()) {
      if (watch.status === "active" && watch.condition === "inactivity") {
        this.#scheduleInactivityWatch(task, watch);
      }
    }
  }

  #scheduleInactivityWatch(
    task: RuntimeTask,
    watch: RuntimeWatch
  ): void {
    if (watch.inactivityHandle) {
      clearTimeout(watch.inactivityHandle);
    }
    const quietSince = task.lastOutputAt ?? watch.createdAt;
    const durationMs = (watch.inactivitySeconds ?? 0) * 1000;
    const delay = Math.max(0, quietSince + durationMs - Date.now());
    watch.inactivityHandle = setTimeout(() => {
      watch.inactivityHandle = undefined;
      if (watch.status !== "active") {
        return;
      }
      if (this.#shuttingDown || task.status !== "running") {
        this.#expireWatch(watch);
        return;
      }
      const latestOutput = task.lastOutputAt ?? watch.createdAt;
      if (latestOutput + durationMs > Date.now()) {
        this.#scheduleInactivityWatch(task, watch);
        return;
      }
      watch.startByte = task.bytesWritten;
      watch.nextByte = task.bytesWritten;
      this.#fireWatch(task, watch);
    }, delay);
    watch.inactivityHandle.unref();
  }

  #expireWatch(watch: RuntimeWatch, endedAt = Date.now()): void {
    if (watch.inactivityHandle) {
      clearTimeout(watch.inactivityHandle);
      watch.inactivityHandle = undefined;
    }
    watch.outputOverlap = undefined;
    watch.status = "expired";
    watch.endedAt = endedAt;
  }

  #finishAfterCleanup(task: RuntimeTask): Promise<void> {
    task.completionPromise ??= this.#completeTask(task);
    return task.completionPromise;
  }

  async #completeTask(task: RuntimeTask): Promise<void> {
    const cleanupError = await this.#cleanupProcessGroup(task);
    await Promise.race([task.shellClosed, sleep(250)]);
    const outcome = task.shellOutcome;
    const closeError = outcome
      ? undefined
      : "Command shell did not close after process-group cleanup";
    const code = outcome?.code ?? null;
    const signal = outcome?.signal ?? null;
    const terminal = BackgroundTaskManager.#terminalState(task, code, signal);
    const finalError = [
      terminal.error,
      task.processError,
      cleanupError,
      closeError,
    ].reduce<string | undefined>(
      (current, error) =>
        error === undefined ? current : appendError(current, error),
      undefined
    );
    const finalStatus =
      finalError && terminal.status === "completed"
        ? "failed"
        : terminal.status;
    await this.#finalize(task, finalStatus, code, signal, finalError);
  }

  #cleanupProcessGroup(task: RuntimeTask): Promise<string | undefined> {
    task.cleanupPromise ??= this.#stopProcessGroup(task);
    return task.cleanupPromise;
  }

  async #stopProcessGroup(task: RuntimeTask): Promise<string | undefined> {
    let cleanupError: string | undefined;
    try {
      if (!BackgroundTaskManager.#processGroupExists(task)) {
        return undefined;
      }
    } catch (error) {
      cleanupError = `Could not inspect the process group: ${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      BackgroundTaskManager.#signal(task, "SIGTERM");
    } catch (error) {
      cleanupError = appendError(
        cleanupError,
        `Could not stop process group: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      if (await this.#waitForProcessGroupExit(task, this.#killGraceMs)) {
        return cleanupError;
      }
    } catch (error) {
      cleanupError = appendError(
        cleanupError,
        `Could not inspect the process group: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      BackgroundTaskManager.#signal(task, "SIGKILL");
    } catch (error) {
      cleanupError = appendError(
        cleanupError,
        `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      if (await this.#waitForProcessGroupExit(task, 250)) {
        return cleanupError;
      }
    } catch (error) {
      return appendError(
        cleanupError,
        `Could not confirm process-group cleanup: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return appendError(
      cleanupError,
      `Process group ${String(task.pid ?? "unknown")} remained after SIGKILL`
    );
  }

  async #waitForProcessGroupExit(
    task: RuntimeTask,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!BackgroundTaskManager.#processGroupExists(task)) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await sleep(Math.min(10, remaining));
    }
  }

  static #processGroupExists(task: RuntimeTask): boolean {
    const { pid } = task.child;
    if (!pid) {
      return false;
    }
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  #beginStop(task: RuntimeTask, reason: StopReason): void {
    if (!isActiveStatus(task.status) || task.status === "stopping") {
      return;
    }
    task.status = "stopping";
    task.stopReason = reason;
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = undefined;
    }
    this.#notifyChange();
    void this.#finishAfterCleanup(task);
  }

  static #signal(task: RuntimeTask, signal: NodeJS.Signals): void {
    const { pid } = task.child;
    if (!pid) {
      throw new Error(`Task ${task.id} has no process ID`);
    }
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "ESRCH") {
        return;
      }
    }
    if (!task.child.kill(signal)) {
      const { exitCode, signalCode } = task.child;
      if (exitCode !== null || signalCode !== null) {
        return;
      }
      throw new Error(`Could not send ${signal} to task ${task.id}`);
    }
  }

  static #terminalState(
    task: RuntimeTask,
    code: number | null,
    signal: NodeJS.Signals | null
  ): { status: Exclude<TaskStatus, "running" | "stopping">; error?: string } {
    if (task.stopReason === "user" || task.stopReason === "shutdown") {
      return { status: "stopped" };
    }
    if (task.stopReason === "timeout" || task.stopReason === "output_limit") {
      return {
        error:
          task.error ??
          (task.stopReason === "timeout"
            ? "Task timed out"
            : "Task exceeded its output limit"),
        status: "failed",
      };
    }
    if (code === 0) {
      return { status: "completed" };
    }
    if (signal) {
      return { error: `Terminated by ${signal}`, status: "failed" };
    }
    if (code !== null) {
      return { error: `Exited with code ${String(code)}`, status: "failed" };
    }
    return { error: "Process exited without a status", status: "failed" };
  }

  async #finalize(
    task: RuntimeTask,
    status: Exclude<TaskStatus, "running" | "stopping">,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string
  ): Promise<void> {
    if (task.finalizing || !isActiveStatus(task.status)) {
      return;
    }
    task.finalizing = true;
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = undefined;
    }

    let finalStatus = status;
    let finalError = error;
    try {
      task.stream.end();
      await finished(task.stream);
      await Promise.all(task.pendingLogWrites);
    } catch (streamError) {
      finalStatus = "failed";
      finalError = appendError(
        finalError,
        `Log finalization failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`
      );
    }

    task.status = finalStatus;
    task.exitCode = code;
    task.signal = signal;
    task.error = finalError;
    task.endedAt = Date.now();
    for (const watch of task.watchState.values()) {
      if (watch.status !== "active") {
        continue;
      }
      if (watch.condition === "exit") {
        watch.startByte = task.bytesWritten;
        watch.nextByte = task.bytesWritten;
        this.#fireWatch(task, watch);
      } else {
        this.#expireWatch(watch, task.endedAt);
      }
    }
    this.#finishedSequence += 1;
    task.finishedOrder = this.#finishedSequence;

    const completion: TaskCompletion = {
      task: BackgroundTaskManager.#snapshot(task),
    };
    if (task.completionPolicy === "wake") {
      try {
        const logs = await this.logs(task.id, MAX_COMPLETION_LOG_BYTES);
        completion.output = logs.output;
        completion.outputTruncated = logs.truncated;
      } catch (logError) {
        completion.outputError =
          logError instanceof Error ? logError.message : String(logError);
      }
    }

    task.resolveClosed();
    this.#prune();
    this.#notifyChange();
    try {
      this.#callbacks.onFinished?.(completion);
    } catch {
      // A notification failure must not change process state.
    }
  }

  #prune(): void {
    const removable = [...this.#tasks.values()]
      .filter((task) => !isActiveStatus(task.status))
      .toSorted(
        (left, right) => (right.finishedOrder ?? 0) - (left.finishedOrder ?? 0)
      )
      .slice(this.#maxRetainedTasks);
    for (const task of removable) {
      this.#tasks.delete(task.id);
      for (const watch of task.watchState.values()) {
        this.#watches.delete(watch.id);
        this.#watchCooldowns.delete(watch.signature);
      }
      try {
        rmSync(task.logPath, { force: true });
      } catch {
        // Log cleanup is best effort.
      }
    }
  }

  #notifyChange(): void {
    try {
      this.#callbacks.onChange?.();
    } catch {
      // UI failures must not change process state.
    }
  }
}
