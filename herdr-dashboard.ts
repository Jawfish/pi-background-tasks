import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskLogs, TaskOutputEvent, TaskSnapshot } from "./core.ts";

const execFileAsync = promisify(execFile);
const MAX_INCOMING_FRAME = 64 * 1024;
const MAX_PENDING_MESSAGES = 16;
const MAX_TASKS = 24;
const MAX_NAME = 240;
const MAX_COMMAND = 4_000;
const MAX_CWD = 1_000;
const MAX_ERROR = 1_000;
const MAX_OUTPUT_PREVIEW = 8_000;
const MAX_OUTPUT_EVENTS_DURING_LOAD = 256;
const OUTPUT_HYDRATION_QUIET_MS = 250;
const UPDATE_DELAY_MS = 100;
const REPORT_DELAY_MS = 250;
const VIEWER_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_SPLIT_RATIO = 0.62;

interface DashboardTaskSource {
  list(): TaskSnapshot[];
  logs?(
    idOrPrefix: string,
    requestedBytes?: number,
    afterByte?: number
  ): Promise<TaskLogs>;
  stop(idOrPrefix: string): TaskSnapshot;
}

interface ViewerSelection {
  taskId?: string;
}

interface DashboardClient {
  selection: ViewerSelection;
  socket: net.Socket;
}

interface SocketWriteState {
  blocked: boolean;
  pendingMessages: string[];
  pendingSnapshot?: string;
}

interface OutputPreviewState {
  endByte: number;
  hydrateAfter?: number;
  hydrated: boolean;
  observedBytes: number;
  startByte: number;
  text: string;
}

interface PendingOutputEvent {
  endByte: number;
  preview: string;
  previewTruncated: boolean;
  startByte: number;
}

interface OutputEventsDuringLoad {
  droppedThroughByte?: number;
  events: PendingOutputEvent[];
  observedBytes: number;
  previewCharacters: number;
}

export interface BackgroundTasksHerdrDashboardDependencies {
  connectTimeoutMs?: number;
  exec?: (args: string[]) => Promise<string>;
  runtimePath?: () => string;
  viewerPath?: string;
}

export interface BackgroundTasksHerdrSurface {
  connected(): boolean;
  dispose(): Promise<void>;
  ensureStarted(ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean>;
  focus(ctx: ExtensionContext): Promise<boolean>;
  onConnectionChange(listener: (connected: boolean) => void): () => void;
  recordOutput(event: TaskOutputEvent): void;
  refresh(): void;
}

const shortText = (value: unknown, limit: number): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value);
  if (text.length <= limit) {
    return text;
  }
  return `…${text.slice(-(limit - 1))}`;
};

const isActive = (task: TaskSnapshot): boolean =>
  task.status === "running" || task.status === "stopping";

const taskSummary = (task: TaskSnapshot) => ({
  bytesWritten: task.bytesWritten,
  completionPolicy: task.completionPolicy,
  endedAt: task.endedAt,
  error: shortText(task.error, 240),
  exitCode: task.exitCode,
  id: task.id,
  lastOutputAt: task.lastOutputAt,
  name: shortText(task.name, MAX_NAME) ?? task.id,
  pid: task.pid,
  signal: task.signal,
  startedAt: task.startedAt,
  status: task.status,
  watchCount: task.watches?.filter((watch) => watch.status === "active").length ?? 0,
});

const taskDetails = (task: TaskSnapshot, output?: string) => ({
  ...taskSummary(task),
  command: shortText(task.command, MAX_COMMAND),
  cwd: shortText(task.cwd, MAX_CWD),
  error: shortText(task.error, MAX_ERROR),
  output: shortText(output, MAX_OUTPUT_PREVIEW),
  timeoutSeconds: task.timeoutSeconds,
});

const boundOutputPreview = (text: string): string =>
  text.length <= MAX_OUTPUT_PREVIEW
    ? text
    : `…${text.slice(-(MAX_OUTPUT_PREVIEW - 1))}`;

const appendOutputEvent = (
  previous: OutputPreviewState | undefined,
  event: TaskOutputEvent
): OutputPreviewState => {
  if (previous && event.nextByte <= previous.endByte) {
    return {
      ...previous,
      observedBytes: Math.max(
        previous.observedBytes,
        event.task.bytesWritten
      ),
    };
  }
  const separator =
    previous && event.startByte !== previous.endByte ? "…" : "";
  const hydrated =
    (previous?.hydrated ?? false) &&
    !event.previewTruncated &&
    event.startByte === previous?.endByte;
  const deferHydration =
    !hydrated &&
    (previous?.hydrated === true || previous?.hydrateAfter !== undefined);
  return {
    endByte: event.nextByte,
    ...(deferHydration
      ? { hydrateAfter: Date.now() + OUTPUT_HYDRATION_QUIET_MS }
      : {}),
    hydrated,
    observedBytes: Math.max(event.nextByte, event.task.bytesWritten),
    startByte: previous?.startByte ?? event.startByte,
    text: boundOutputPreview(
      `${previous?.text ?? ""}${separator}${event.preview}${event.previewTruncated ? "…" : ""}`
    ),
  };
};

const accumulateOutputEvent = (
  previous: OutputEventsDuringLoad | undefined,
  event: TaskOutputEvent
): OutputEventsDuringLoad => {
  const next: PendingOutputEvent = {
    endByte: event.nextByte,
    preview: event.preview,
    previewTruncated: event.previewTruncated,
    startByte: event.startByte,
  };
  const events = [...(previous?.events ?? []), next];
  let droppedThroughByte = previous?.droppedThroughByte;
  let previewCharacters =
    (previous?.previewCharacters ?? 0) + event.preview.length;
  while (
    events.length > 1 &&
    (events.length > MAX_OUTPUT_EVENTS_DURING_LOAD ||
      previewCharacters > MAX_OUTPUT_PREVIEW)
  ) {
    const dropped = events.shift()!;
    droppedThroughByte = Math.max(
      droppedThroughByte ?? 0,
      dropped.endByte
    );
    previewCharacters -= dropped.preview.length;
  }
  return {
    ...(droppedThroughByte === undefined ? {} : { droppedThroughByte }),
    events,
    observedBytes: Math.max(
      previous?.observedBytes ?? 0,
      event.nextByte,
      event.task.bytesWritten
    ),
    previewCharacters,
  };
};

const isUtf8ContinuationByte = (value: number): boolean =>
  (value & 0xc0) === 0x80;

const mergePendingOutputEvents = (
  hydrated: OutputPreviewState,
  pending: OutputEventsDuringLoad
): OutputPreviewState => {
  let cursor = hydrated.endByte;
  let incomplete = false;
  let text = hydrated.text;
  if (
    pending.droppedThroughByte !== undefined &&
    pending.droppedThroughByte > cursor
  ) {
    incomplete = true;
    text += "\n…\n";
    cursor = pending.droppedThroughByte;
  }
  for (const event of pending.events) {
    if (event.endByte <= cursor) {
      continue;
    }
    if (event.startByte > cursor) {
      incomplete = true;
      text += "\n…\n";
      cursor = event.startByte;
    }
    const preview = Buffer.from(event.preview, "utf8");
    const previewEndByte = event.startByte + preview.length;
    if (previewEndByte > cursor) {
      const requestedOffset = Math.max(0, cursor - event.startByte);
      let offset = requestedOffset;
      while (
        offset < preview.length &&
        isUtf8ContinuationByte(preview[offset]!)
      ) {
        offset += 1;
      }
      if (offset !== requestedOffset) {
        incomplete = true;
      }
      text += preview.subarray(offset).toString("utf8");
    }
    if (event.previewTruncated || event.endByte > previewEndByte) {
      incomplete = true;
      text += "…";
    }
    cursor = event.endByte;
  }
  return {
    endByte: cursor,
    ...(incomplete
      ? { hydrateAfter: Date.now() + OUTPUT_HYDRATION_QUIET_MS }
      : {}),
    hydrated: !incomplete,
    observedBytes: Math.max(
      hydrated.observedBytes,
      pending.observedBytes
    ),
    startByte: hydrated.startByte,
    text: boundOutputPreview(text),
  };
};

const defaultViewerPath = fileURLToPath(
  new URL("./herdr-dashboard-viewer.js", import.meta.url)
);

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const viewerCommand = (
  runtime: string,
  viewerPath: string,
  socketPath: string
): string =>
  [
    shellQuote(runtime),
    shellQuote(viewerPath),
    "--socket",
    shellQuote(socketPath),
  ].join(" ");

const responsePaneId = (output: string): string | undefined => {
  try {
    const parsed = JSON.parse(output) as {
      result?: { pane?: { pane_id?: unknown } };
    };
    return typeof parsed.result?.pane?.pane_id === "string"
      ? parsed.result.pane.pane_id
      : undefined;
  } catch {
    return undefined;
  }
};

const defaultHerdrExec = async (args: string[]): Promise<string> => {
  const result = await execFileAsync(
    process.env.HERDR_BIN_PATH ?? "herdr",
    args,
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    }
  );
  return String(result.stdout);
};

export const isHerdrDashboardAvailable = (ctx: ExtensionContext): boolean =>
  process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD !== "0" &&
  process.env.HERDR_ENV === "1" &&
  Boolean(process.env.HERDR_PANE_ID) &&
  ctx.mode === "tui";

export class BackgroundTasksHerdrDashboard
  implements BackgroundTasksHerdrSurface
{
  readonly #clients = new Set<DashboardClient>();
  readonly #connectionListeners = new Set<(connected: boolean) => void>();
  readonly #connectTimeoutMs: number;
  readonly #exec: (args: string[]) => Promise<string>;
  readonly #outputEventsDuringLoad = new Map<
    string,
    OutputEventsDuringLoad
  >();
  readonly #outputHydrationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #outputLoads = new Map<string, Promise<void>>();
  readonly #outputPreviews = new Map<string, OutputPreviewState>();
  readonly #runtimePath?: () => string;
  readonly #sockets = new Set<net.Socket>();
  readonly #source: DashboardTaskSource;
  readonly #viewerPath: string;
  readonly #writeStates = new WeakMap<net.Socket, SocketWriteState>();
  #disposed = false;
  #generation = 0;
  readonly #instanceId = crypto.randomUUID();
  readonly #reportSource = `pi-background-tasks:${this.#instanceId}`;
  #paneId?: string;
  #reportInFlight = false;
  #reportPending = false;
  #reportSeq = Date.now() * 1_000;
  #reportTimer?: ReturnType<typeof setTimeout>;
  #server?: net.Server;
  #socketDirectory?: string;
  #socketPath?: string;
  #starting?: Promise<boolean>;
  #startupWaiters = 0;
  #stopping = false;
  #teardown?: Promise<void>;
  #updateTimer?: ReturnType<typeof setTimeout>;
  readonly #waiters = new Set<(connected: boolean) => void>();

  constructor(
    source: DashboardTaskSource,
    dependencies: BackgroundTasksHerdrDashboardDependencies = {}
  ) {
    this.#connectTimeoutMs =
      dependencies.connectTimeoutMs ?? VIEWER_CONNECT_TIMEOUT_MS;
    this.#exec = dependencies.exec ?? defaultHerdrExec;
    this.#runtimePath = dependencies.runtimePath;
    this.#source = source;
    this.#viewerPath = dependencies.viewerPath ?? defaultViewerPath;
  }

  connected(): boolean {
    return this.#clients.size > 0;
  }

  surfacePaneId(): string | undefined {
    return this.#paneId;
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  async ensureStarted(
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<boolean> {
    const teardown = this.#teardown;
    if (teardown) {
      await teardown.catch(() => {});
    }
    if (this.#disposed || !isHerdrDashboardAvailable(ctx) || signal?.aborted) {
      return false;
    }
    if (this.connected() && !this.#starting) {
      return true;
    }
    if (!this.#starting) {
      const generation = ++this.#generation;
      const startup = this.#start(ctx, generation).finally(() => {
        if (this.#starting === startup) {
          this.#starting = undefined;
        }
      });
      this.#starting = startup;
    }
    return this.#waitForStartup(this.#starting, signal);
  }

  async focus(ctx: ExtensionContext): Promise<boolean> {
    if (!(await this.ensureStarted(ctx))) {
      return false;
    }
    await this.#refreshPaneId();
    if (!this.#paneId) {
      return false;
    }
    try {
      await this.#exec(["agent", "focus", this.#paneId]);
      return true;
    } catch {
      return false;
    }
  }

  recordOutput(event: TaskOutputEvent): void {
    if (!this.connected() && !this.#starting) {
      return;
    }
    const previous = this.#outputPreviews.get(event.task.id);
    if (this.#outputLoads.has(event.task.id) || !previous?.hydrated) {
      this.#outputEventsDuringLoad.set(
        event.task.id,
        accumulateOutputEvent(
          this.#outputEventsDuringLoad.get(event.task.id),
          event
        )
      );
      if (!this.#outputLoads.has(event.task.id)) {
        this.#outputPreviews.set(
          event.task.id,
          appendOutputEvent(previous, event)
        );
        this.#scheduleSnapshot();
      }
      return;
    }
    if (event.startByte < previous.endByte) {
      if (event.nextByte > previous.endByte) {
        this.#outputEventsDuringLoad.set(
          event.task.id,
          accumulateOutputEvent(undefined, event)
        );
        this.#loadOutputPreview(event.task);
      }
      return;
    }
    this.#outputPreviews.set(
      event.task.id,
      appendOutputEvent(previous, event)
    );
    this.#scheduleSnapshot();
  }

  #loadOutputPreview(task: TaskSnapshot): void {
    if (
      this.#disposed ||
      !this.#source.logs ||
      task.bytesWritten <= 0 ||
      this.#outputLoads.has(task.id)
    ) {
      return;
    }
    this.#clearOutputHydrationTimer(task.id);
    const generation = this.#generation;
    let load: Promise<void>;
    load = this.#source
      .logs(task.id, MAX_OUTPUT_PREVIEW)
      .then((logs) => {
        if (
          !this.#current(generation) ||
          this.#outputLoads.get(task.id) !== load
        ) {
          return;
        }
        const pending = this.#outputEventsDuringLoad.get(task.id);
        this.#outputEventsDuringLoad.delete(task.id);
        const previous = this.#outputPreviews.get(task.id);
        const observedBytes = Math.max(
          task.bytesWritten,
          previous?.observedBytes ?? 0
        );
        let hydrated: OutputPreviewState;
        if (
          previous?.hydrated &&
          logs.totalBytes < previous.endByte
        ) {
          hydrated = {
            ...previous,
            observedBytes,
          };
        } else {
          const unavailable =
            logs.totalBytes < task.bytesWritten
              ? "\n… newer output unavailable."
              : "";
          hydrated = {
            endByte: logs.totalBytes,
            hydrated: true,
            observedBytes,
            startByte: Math.max(0, logs.totalBytes - logs.bytesRead),
            text: boundOutputPreview(`${logs.output}${unavailable}`),
          };
        }
        this.#outputPreviews.set(
          task.id,
          pending
            ? mergePendingOutputEvents(hydrated, pending)
            : hydrated
        );
      })
      .catch(() => {
        // Output may be pruned between the task snapshot and this bounded read.
        if (
          !this.#current(generation) ||
          this.#outputLoads.get(task.id) !== load
        ) {
          return;
        }
        const pending = this.#outputEventsDuringLoad.get(task.id);
        this.#outputEventsDuringLoad.delete(task.id);
        const previous = this.#outputPreviews.get(task.id);
        const pendingStartByte =
          pending?.events[0]?.startByte ?? task.bytesWritten;
        const unavailable: OutputPreviewState = previous?.hydrated
          ? {
              ...previous,
              observedBytes: Math.max(
                previous.observedBytes,
                task.bytesWritten
              ),
              text: boundOutputPreview(
                `${previous.text}\n… output preview unavailable.`
              ),
            }
          : {
              endByte: Math.min(task.bytesWritten, pendingStartByte),
              hydrated: true,
              observedBytes: task.bytesWritten,
              startByte: 0,
              text: "Output preview unavailable.\n",
            };
        this.#outputPreviews.set(
          task.id,
          pending
            ? mergePendingOutputEvents(unavailable, pending)
            : unavailable
        );
      })
      .finally(() => {
        if (this.#outputLoads.get(task.id) === load) {
          this.#outputLoads.delete(task.id);
          this.#scheduleSnapshot();
        }
      });
    this.#outputLoads.set(task.id, load);
  }

  refresh(): void {
    this.#scheduleSnapshot();
    this.#scheduleAgentReport();
  }

  #clearOutputHydrationTimer(taskId: string): void {
    const timer = this.#outputHydrationTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.#outputHydrationTimers.delete(taskId);
    }
  }

  #scheduleOutputHydration(taskId: string, deadline: number): void {
    this.#clearOutputHydrationTimer(taskId);
    const timer = setTimeout(() => {
      if (this.#outputHydrationTimers.get(taskId) === timer) {
        this.#outputHydrationTimers.delete(taskId);
        this.#scheduleSnapshot();
      }
    }, Math.max(0, deadline - Date.now()));
    timer.unref?.();
    this.#outputHydrationTimers.set(taskId, timer);
  }

  #scheduleSnapshot(): void {
    if (this.connected() && !this.#updateTimer) {
      this.#updateTimer = setTimeout(() => {
        this.#updateTimer = undefined;
        this.#sendAllSnapshots();
      }, UPDATE_DELAY_MS);
      this.#updateTimer.unref?.();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#generation += 1;
    const startup = this.#starting;
    const teardown = this.#teardown;
    if (teardown) {
      await teardown.catch(() => {});
    }
    await this.#stopSurface(true);
    if (startup) {
      await startup.catch(() => false);
    }
    await this.#stopSurface(true);
    this.#connectionListeners.clear();
  }

  #current(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #waitForStartup(
    startup: Promise<boolean>,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.#startupWaiters += 1;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean, aborted = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#startupWaiters = Math.max(0, this.#startupWaiters - 1);
        if (
          aborted &&
          this.#startupWaiters === 0 &&
          this.#starting === startup
        ) {
          this.#generation += 1;
          void this.#stopSurface(true).catch(() => {});
        }
        resolve(value);
      };
      const onAbort = (): void => finish(false, true);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void startup.then((value) => finish(value), () => finish(false));
    });
  }

  async #refreshPaneId(): Promise<void> {
    if (!this.#paneId) {
      return;
    }
    try {
      const output = await this.#exec(["agent", "list"]);
      const parsed = JSON.parse(output) as {
        result?: {
          agents?: Array<{
            pane_id?: unknown;
            tokens?: Record<string, unknown>;
          }>;
        };
      };
      const match = parsed.result?.agents?.find(
        (agent) =>
          agent.tokens?.background_tasks_instance === this.#instanceId
      );
      if (typeof match?.pane_id === "string") {
        this.#paneId = match.pane_id;
      }
    } catch {
      // Keep using the known pane id if identity lookup is unavailable.
    }
  }

  async #start(ctx: ExtensionContext, generation: number): Promise<boolean> {
    await this.#stopSurface(Boolean(this.#paneId));
    if (!this.#current(generation)) {
      return false;
    }
    try {
      await this.#startServer();
      if (!this.#current(generation)) {
        await this.#stopSurface(false);
        return false;
      }
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (!parentPaneId) {
        return false;
      }
      const output = await this.#exec([
        "pane",
        "split",
        "--pane",
        parentPaneId,
        "--direction",
        "right",
        "--ratio",
        String(DEFAULT_SPLIT_RATIO),
        "--cwd",
        ctx.cwd,
        "--no-focus",
      ]);
      const paneId = responsePaneId(output);
      if (!this.#current(generation)) {
        if (paneId) {
          try {
            await this.#exec(["pane", "close", paneId]);
          } catch {
            // The pane may already have closed.
          }
        }
        await this.#stopSurface(false);
        return false;
      }
      if (!paneId) {
        throw new Error("Herdr pane split did not return a pane id");
      }
      this.#paneId = paneId;
      await this.#exec(["pane", "rename", paneId, "Background tasks"]);
      if (!this.#current(generation)) {
        await this.#stopSurface(true);
        return false;
      }
      const command = viewerCommand(
        process.env.PI_BACKGROUND_TASK_NODE ?? "node",
        this.#viewerPath,
        this.#socketPath ?? ""
      );
      await this.#exec(["pane", "run", paneId, command]);
      if (!this.#current(generation)) {
        await this.#stopSurface(true);
        return false;
      }
      const connected = await this.#waitForViewer(this.#connectTimeoutMs);
      if (!connected || !this.#current(generation)) {
        await this.#stopSurface(true);
        return false;
      }
      await this.#reportMetadata();
      if (!this.#current(generation)) {
        return false;
      }
      await this.#reportAgent();
      return this.#current(generation);
    } catch {
      await this.#stopSurface(true);
      return false;
    }
  }

  async #startServer(): Promise<void> {
    if (this.#server) {
      return;
    }
    let socketPath: string;
    if (this.#runtimePath) {
      socketPath = this.#runtimePath();
    } else {
      const socketDirectory = await mkdtemp("/tmp/pi-background-");
      await chmod(socketDirectory, 0o700);
      this.#socketDirectory = socketDirectory;
      socketPath = `${socketDirectory}/dashboard.sock`;
    }
    const server = net.createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    server.unref();
    this.#server = server;
    this.#socketPath = socketPath;
    server.on("error", () => {
      if (this.#server === server && !this.#stopping) {
        this.#beginTeardown(true);
      }
    });
    await chmod(socketPath, 0o600);
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    this.#writeStates.set(socket, {
      blocked: false,
      pendingMessages: [],
    });
    socket.setEncoding("utf8");
    let buffer = "";
    let client: DashboardClient | undefined;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > MAX_INCOMING_FRAME) {
            buffer = "";
            socket.destroy();
          }
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_INCOMING_FRAME) {
          buffer = "";
          socket.destroy();
          return;
        }
        if (!line.trim()) {
          continue;
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!client && this.#messageType(message) === "hello") {
          client = { selection: {}, socket };
          const wasConnected = this.connected();
          this.#clients.add(client);
          if (!wasConnected) {
            this.#publishConnection(true);
          }
          for (const waiter of this.#waiters) {
            waiter(true);
          }
          this.#waiters.clear();
          this.#sendSnapshot(client);
          this.#scheduleAgentReport();
          continue;
        }
        if (client) {
          void this.#handleMessage(client, message);
        }
      }
    });
    socket.on("close", () => {
      this.#sockets.delete(socket);
      if (!client && this.#sockets.size === 0) {
        for (const waiter of this.#waiters) {
          waiter(false);
        }
        this.#waiters.clear();
      }
      if (client) {
        const wasConnected = this.connected();
        this.#clients.delete(client);
        if (wasConnected && !this.connected()) {
          this.#publishConnection(false);
          if (!this.#stopping) {
            const disconnectedPaneId = this.#paneId;
            const disconnectedGeneration = this.#generation;
            setTimeout(() => {
              if (
                !this.connected() &&
                !this.#stopping &&
                this.#paneId === disconnectedPaneId &&
                this.#generation === disconnectedGeneration
              ) {
                this.#beginTeardown(true);
              }
            }, 50).unref?.();
          }
        }
        this.#scheduleAgentReport();
      }
    });
    socket.on("error", () => socket.destroy());
  }

  #publishConnection(connected: boolean): void {
    for (const listener of this.#connectionListeners) {
      try {
        listener(connected);
      } catch {
        // Connection observers only maintain the optional footer fallback.
      }
    }
  }

  #messageType(message: unknown): string | undefined {
    if (typeof message !== "object" || message === null) {
      return undefined;
    }
    const type = (message as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }

  async #handleMessage(
    client: DashboardClient,
    message: unknown
  ): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const input = message as Record<string, unknown>;
    if (input.type === "select") {
      client.selection = {
        taskId: typeof input.taskId === "string" ? input.taskId : undefined,
      };
      this.#sendSnapshot(client);
      return;
    }
    if (input.type !== "action" || typeof input.action !== "string") {
      return;
    }
    const requestId =
      typeof input.id === "string" ? input.id : crypto.randomUUID();
    try {
      await this.#runAction(input.action, input);
      this.#send(client.socket, {
        id: requestId,
        ok: true,
        type: "action-result",
      });
      this.#sendAllSnapshots();
    } catch (error) {
      this.#send(client.socket, {
        error: error instanceof Error ? error.message : String(error),
        id: requestId,
        ok: false,
        type: "action-result",
      });
    }
  }

  async #runAction(
    action: string,
    input: Record<string, unknown>
  ): Promise<void> {
    if (action === "close-dashboard") {
      setTimeout(() => this.#beginTeardown(true), 50).unref?.();
      return;
    }
    if (action === "focus-parent") {
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (!parentPaneId) {
        throw new Error("The parent Herdr pane is unavailable");
      }
      await this.#exec(["agent", "focus", parentPaneId]);
      return;
    }
    if (action === "refresh") {
      return;
    }
    if (action !== "stop-task") {
      throw new Error(`Unknown dashboard action: ${action}`);
    }
    const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
    if (!taskId) {
      throw new Error("A background task is not selected");
    }
    const task = this.#source.list().find((candidate) => candidate.id === taskId);
    if (!task || !isActive(task)) {
      throw new Error("The selected background task is no longer active");
    }
    this.#source.stop(task.id);
  }

  #sendAllSnapshots(): void {
    for (const client of this.#clients) {
      this.#sendSnapshot(client);
    }
  }

  #sendSnapshot(client: DashboardClient): void {
    const tasks = this.#source.list().slice(0, MAX_TASKS);
    const retained = new Set(tasks.map((task) => task.id));
    for (const taskId of this.#outputPreviews.keys()) {
      if (!retained.has(taskId)) {
        this.#outputPreviews.delete(taskId);
      }
    }
    for (const taskId of this.#outputEventsDuringLoad.keys()) {
      if (!retained.has(taskId)) {
        this.#outputEventsDuringLoad.delete(taskId);
      }
    }
    for (const taskId of this.#outputLoads.keys()) {
      if (!retained.has(taskId)) {
        this.#outputLoads.delete(taskId);
      }
    }
    for (const taskId of this.#outputHydrationTimers.keys()) {
      if (!retained.has(taskId)) {
        this.#clearOutputHydrationTimer(taskId);
      }
    }
    const selected =
      tasks.find((task) => task.id === client.selection.taskId) ?? tasks[0];
    client.selection = { taskId: selected?.id };
    if (selected) {
      const preview = this.#outputPreviews.get(selected.id);
      if (!preview) {
        this.#loadOutputPreview(selected);
      } else if (
        !preview.hydrated ||
        preview.observedBytes < selected.bytesWritten
      ) {
        const hydrateAfter = preview.hydrateAfter;
        if (
          isActive(selected) &&
          hydrateAfter !== undefined &&
          hydrateAfter > Date.now()
        ) {
          this.#scheduleOutputHydration(selected.id, hydrateAfter);
        } else {
          this.#loadOutputPreview(selected);
        }
      }
    }
    this.#send(
      client.socket,
      {
        activeCount: tasks.filter(isActive).length,
        now: Date.now(),
        paneId: this.#paneId,
        parentPaneId: process.env.HERDR_PANE_ID,
        selected: selected
          ? taskDetails(
              selected,
              this.#outputPreviews.get(selected.id)?.text
            )
          : undefined,
        selectedTaskId: selected?.id,
        tasks: tasks.map(taskSummary),
        type: "snapshot",
      },
      true
    );
  }

  #send(socket: net.Socket, value: unknown, snapshot = false): void {
    if (socket.destroyed) {
      return;
    }
    const encoded = `${JSON.stringify(value)}\n`;
    const state = this.#writeStates.get(socket) ?? {
      blocked: false,
      pendingMessages: [],
    };
    this.#writeStates.set(socket, state);
    if (state.blocked) {
      if (snapshot) {
        state.pendingSnapshot = encoded;
      } else if (state.pendingMessages.length < MAX_PENDING_MESSAGES) {
        state.pendingMessages.push(encoded);
      } else {
        socket.destroy();
      }
      return;
    }
    this.#writeEncoded(socket, state, encoded);
  }

  #writeEncoded(
    socket: net.Socket,
    state: SocketWriteState,
    encoded: string
  ): boolean {
    try {
      if (socket.write(encoded)) {
        return true;
      }
    } catch {
      socket.destroy();
      return false;
    }
    state.blocked = true;
    socket.once("drain", () => this.#flushWrites(socket, state));
    return false;
  }

  #flushWrites(socket: net.Socket, state: SocketWriteState): void {
    if (socket.destroyed) {
      return;
    }
    state.blocked = false;
    while (state.pendingMessages.length > 0) {
      const message = state.pendingMessages.shift();
      if (message && !this.#writeEncoded(socket, state, message)) {
        return;
      }
    }
    const snapshot = state.pendingSnapshot;
    state.pendingSnapshot = undefined;
    if (snapshot) {
      this.#writeEncoded(socket, state, snapshot);
    }
  }

  #waitForViewer(timeoutMs: number): Promise<boolean> {
    if (this.connected()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (connected: boolean): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        resolve(connected);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.#waiters.add(finish);
    });
  }

  #scheduleAgentReport(): void {
    if (!this.#paneId) {
      return;
    }
    if (this.#reportInFlight) {
      this.#reportPending = true;
      return;
    }
    if (this.#reportTimer) {
      return;
    }
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = undefined;
      this.#reportInFlight = true;
      void this.#reportAgent().finally(() => {
        this.#reportInFlight = false;
        if (this.#reportPending) {
          this.#reportPending = false;
          this.#scheduleAgentReport();
        }
      });
    }, REPORT_DELAY_MS);
    this.#reportTimer.unref?.();
  }

  async #reportMetadata(): Promise<void> {
    if (!this.#paneId) {
      return;
    }
    try {
      await this.#exec([
        "pane",
        "report-metadata",
        this.#paneId,
        "--source",
        this.#reportSource,
        "--display-agent",
        "Background tasks",
        "--title",
        "Background tasks",
        "--token",
        "background_tasks_dashboard=interactive",
        "--token",
        `background_tasks_instance=${this.#instanceId}`,
      ]);
    } catch {
      // Metadata is optional and never affects task execution.
    }
  }

  async #reportAgent(): Promise<void> {
    if (!this.#paneId) {
      return;
    }
    await this.#refreshPaneId();
    if (!this.#paneId) {
      return;
    }
    const active = this.#source.list().filter(isActive);
    const state = active.length > 0 ? "working" : "idle";
    const message =
      active.length > 0
        ? `${String(active.length)} active ${active.length === 1 ? "task" : "tasks"}`
        : "ready";
    this.#reportSeq += 1;
    try {
      await this.#exec([
        "pane",
        "report-agent",
        this.#paneId,
        "--source",
        this.#reportSource,
        "--agent",
        "background-tasks",
        "--state",
        state,
        "--message",
        message,
        "--seq",
        String(this.#reportSeq),
      ]);
    } catch {
      // Herdr display failures never affect background tasks.
    }
  }

  #beginTeardown(closePane: boolean): void {
    if (this.#teardown) {
      return;
    }
    this.#generation += 1;
    const startup = this.#starting;
    const teardown = (async () => {
      if (startup) {
        await startup.catch(() => false);
      }
      await this.#stopSurface(closePane);
    })().finally(() => {
      if (this.#teardown === teardown) {
        this.#teardown = undefined;
      }
    });
    this.#teardown = teardown;
    void teardown.catch(() => {});
  }

  async #stopSurface(closePane: boolean): Promise<void> {
    this.#stopping = true;
    try {
      if (this.#updateTimer) {
        clearTimeout(this.#updateTimer);
        this.#updateTimer = undefined;
      }
      if (this.#reportTimer) {
        clearTimeout(this.#reportTimer);
        this.#reportTimer = undefined;
      }
      this.#reportPending = false;
      for (const waiter of this.#waiters) {
        waiter(false);
      }
      this.#waiters.clear();
      const wasConnected = this.connected();
      for (const client of this.#clients) {
        this.#send(client.socket, { type: "shutdown" });
      }
      for (const socket of this.#sockets) {
        socket.destroy();
      }
      this.#clients.clear();
      this.#sockets.clear();
      for (const timer of this.#outputHydrationTimers.values()) {
        clearTimeout(timer);
      }
      this.#outputHydrationTimers.clear();
      this.#outputEventsDuringLoad.clear();
      this.#outputLoads.clear();
      this.#outputPreviews.clear();
      if (wasConnected) {
        this.#publishConnection(false);
      }
      const server = this.#server;
      this.#server = undefined;
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const socketPath = this.#socketPath;
      const socketDirectory = this.#socketDirectory;
      this.#socketPath = undefined;
      this.#socketDirectory = undefined;
      if (socketDirectory) {
        await rm(socketDirectory, { force: true, recursive: true });
      } else if (socketPath) {
        await rm(socketPath, { force: true });
      }
      if (closePane && this.#paneId) {
        await this.#refreshPaneId();
      }
      const paneId = this.#paneId;
      this.#paneId = undefined;
      if (closePane && paneId) {
        try {
          await this.#exec([
            "pane",
            "release-agent",
            paneId,
            "--source",
            this.#reportSource,
            "--agent",
            "background-tasks",
            "--seq",
            String(++this.#reportSeq),
          ]);
        } catch {
          // The pane may already have closed.
        }
        try {
          await this.#exec(["pane", "close", paneId]);
        } catch {
          // The pane may already have closed.
        }
      }
    } finally {
      this.#stopping = false;
    }
  }
}
