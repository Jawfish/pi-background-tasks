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
export const DEFAULT_SHELL = "sh";
export const BACKGROUND_TASK_SHELL_ENV = "PI_BACKGROUND_TASK_SHELL";

export type TaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped";

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
  wakeOnExit: boolean;
  timeoutSeconds?: number;
}

export interface StartTaskInput {
  name?: string;
  command: string;
  cwd: string;
  wakeOnExit?: boolean;
  timeoutSeconds?: number;
}

export interface TaskLogs {
  task: TaskSnapshot;
  text: string;
  output: string;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
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

type RuntimeTask = TaskSnapshot & {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stream: WriteStream;
  stopReason?: StopReason;
  outputLimitReached: boolean;
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
};

export interface BackgroundTaskManagerOptions {
  runtimeDir?: string;
  maxActiveTasks?: number;
  maxRecentTasks?: number;
  maxRetainedTasks?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  shell?: string;
  onChange?: () => void;
  onFinished?: (completion: TaskCompletion) => void;
}

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
    const wake = task.wakeOnExit ? " wake=on" : "";
    const error = task.error ? ` error=${truncate(task.error, 120)}` : "";
    return `${task.id} ${task.status} ${elapsed}${terminal}${wake}: ${task.name}${error}\n  log: ${task.logPath}`;
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
  const active = tasks.filter((task) => isActiveStatus(task.status));
  const recent = tasks.filter((task) => !isActiveStatus(task.status));
  const lines = ["<background-tasks>"];

  if (active.length === 0) {
    lines.push("Active: none");
  } else {
    lines.push("Active:");
    for (const task of active) {
      const wake = task.wakeOnExit ? ", automatic continuation enabled" : "";
      lines.push(
        `- ${task.id} [${task.status}${wake}] ${escapeXml(task.name)}; log: ${escapeXml(task.logPath)}`
      );
    }
  }

  if (recent.length > 0) {
    lines.push("Recent:");
    for (const task of recent) {
      let terminal = "";
      if (typeof task.exitCode === "number") {
        terminal = `, exit ${String(task.exitCode)}`;
      } else if (task.signal) {
        terminal = `, signal ${task.signal}`;
      }
      lines.push(
        `- ${task.id} [${task.status}${terminal}] ${escapeXml(task.name)}; log: ${escapeXml(task.logPath)}`
      );
    }
  }

  lines.push(
    "Use background_task for start, status, logs, or stop. This is the current status for this model call.",
    "</background-tasks>"
  );
  return lines.join("\n");
};

export class BackgroundTaskManager {
  readonly #tasks = new Map<string, RuntimeTask>();
  readonly #maxActiveTasks: number;
  readonly #maxRecentTasks: number;
  readonly #maxRetainedTasks: number;
  readonly #maxOutputBytes: number;
  readonly #killGraceMs: number;
  readonly #shell: string;
  readonly #onChange: (() => void) | undefined;
  readonly #onFinished: ((completion: TaskCompletion) => void) | undefined;
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
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#shell =
      options.shell ??
      (process.env[BACKGROUND_TASK_SHELL_ENV]?.trim() || DEFAULT_SHELL);
    this.#onChange = options.onChange;
    this.#onFinished = options.onFinished;
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
        child = spawn(this.#shell, ["-c", command], {
          cwd: input.cwd,
          detached: true,
          env: process.env,
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
        pid: child.pid,
        resolveClosed: () => closed.resolve(null),
        resolveShellClosed: () => shellClosed.resolve(null),
        shellClosed: shellClosed.promise,
        startedAt: Date.now(),
        status: "running",
        stream,
        timeoutSeconds,
        wakeOnExit: input.wakeOnExit ?? false,
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
      return BackgroundTaskManager.#snapshot(task);
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
    requestedBytes = MAX_LOG_READ_BYTES
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
      const totalBytes = stats.size;
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

  #newTaskId(): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!this.#tasks.has(id)) {
        return id;
      }
    }
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
      name: task.name,
      pid: task.pid,
      signal: task.signal,
      startedAt: task.startedAt,
      status: task.status,
      timeoutSeconds: task.timeoutSeconds,
      wakeOnExit: task.wakeOnExit,
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
    const remaining = Math.max(0, this.#maxOutputBytes - task.bytesWritten);
    const accepted = buffer.subarray(0, remaining);
    if (accepted.length > 0) {
      task.bytesWritten += accepted.length;
      const canContinue = task.stream.write(accepted);
      if (!canContinue && "pause" in source && "resume" in source) {
        source.pause();
        task.stream.once("drain", () => source.resume());
      }
    }

    if (accepted.length < buffer.length) {
      task.outputLimitReached = true;
      task.error = `Output exceeded ${String(this.#maxOutputBytes)} bytes`;
      task.stream.write(`\n\n[background task stopped: ${task.error}]\n`);
      this.#beginStop(task, "output_limit");
    }
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
    this.#finishedSequence += 1;
    task.finishedOrder = this.#finishedSequence;

    const completion: TaskCompletion = {
      task: BackgroundTaskManager.#snapshot(task),
    };
    if (task.wakeOnExit) {
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
      this.#onFinished?.(completion);
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
      try {
        rmSync(task.logPath, { force: true });
      } catch {
        // Log cleanup is best effort.
      }
    }
  }

  #notifyChange(): void {
    try {
      this.#onChange?.();
    } catch {
      // UI failures must not change process state.
    }
  }
}
