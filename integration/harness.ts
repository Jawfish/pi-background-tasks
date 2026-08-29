import { afterEach } from "bun:test";
import {
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { Context, FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKGROUND_TASK_DISCOVERY_CHANNEL,
  BACKGROUND_TASK_SERVICE_CHANNEL,
  isBackgroundTaskServiceAnnouncement,
} from "../service.ts";
import type {
  BackgroundTaskLifecycleEvent,
  BackgroundTaskService,
  BackgroundTaskSnapshot,
} from "../service.ts";

const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const CLEANUP_TIMEOUT_MS = 5000;
const WAIT_INTERVAL_MS = 10;
const DEFAULT_WAIT_MS = 5000;

const activeHarnesses = new Set<PiIntegrationHarness>();
const fallbackProcessGroups = new Set<number>();

const isProcessGroupAlive = function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killProcessGroup = function killProcessGroup(pid: number): void {
  if (!isProcessGroupAlive(pid)) {
    fallbackProcessGroups.delete(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may have exited between the probe and signal.
  }
};

process.once("exit", () => {
  for (const pid of fallbackProcessGroups) {
    killProcessGroup(pid);
  }
});

afterEach(async () => {
  await Promise.allSettled(
    [...activeHarnesses].map(async (harness) => {
      await harness.dispose();
    })
  );
});

const withTimeout = async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const waitFor = async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = DEFAULT_WAIT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Integration state changes asynchronously across real Pi and OS events.
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (await predicate()) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
};

export type IntegrationMode = "json" | "print" | "rpc" | "tui";

export interface PiIntegrationHarnessOptions {
  extensionPathsBefore?: readonly string[];
  mode?: IntegrationMode;
  persistedSession?: boolean;
}

export class PiIntegrationHarness {
  readonly agentEvents: AgentSessionEvent[] = [];
  readonly extensionErrors: ExtensionError[] = [];
  readonly lifecycleEvents: BackgroundTaskLifecycleEvent[] = [];
  readonly modelContexts: Context[] = [];
  readonly rootDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly mode: IntegrationMode;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly modelRuntime: ModelRuntime;
  readonly eventBus: ReturnType<typeof createEventBus>;

  runtime!: AgentSessionRuntime;
  latestService: BackgroundTaskService | undefined;

  #disposed = false;
  #extensionPathsBefore: readonly string[];
  #sessionUnsubscribe: (() => void) | undefined;
  #serviceUnsubscribe: (() => void) | undefined;
  #trackedPids = new Set<number>();

  private constructor(
    rootDir: string,
    modelRuntime: ModelRuntime,
    faux: ReturnType<typeof fauxProvider>,
    eventBus: ReturnType<typeof createEventBus>,
    mode: IntegrationMode,
    extensionPathsBefore: readonly string[]
  ) {
    this.rootDir = rootDir;
    this.cwd = path.join(rootDir, "project");
    this.agentDir = path.join(rootDir, "agent");
    this.sessionDir = path.join(rootDir, "sessions");
    this.modelRuntime = modelRuntime;
    this.faux = faux;
    this.eventBus = eventBus;
    this.mode = mode;
    this.#extensionPathsBefore = extensionPathsBefore;
  }

  static async create(
    options: PiIntegrationHarnessOptions = {}
  ): Promise<PiIntegrationHarness> {
    const rootDir = await mkdtemp(path.join(tmpdir(), "pi-bg-integration-"));
    const agentDir = path.join(rootDir, "agent");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(path.join(rootDir, "project"), { recursive: true }),
      mkdir(path.join(rootDir, "sessions"), { recursive: true }),
    ]);

    const faux = fauxProvider({
      provider: `background-task-test-${path.basename(rootDir)}`,
      tokenSize: { max: 64, min: 64 },
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const eventBus = createEventBus();
    const harness = new PiIntegrationHarness(
      rootDir,
      modelRuntime,
      faux,
      eventBus,
      options.mode ?? "print",
      options.extensionPathsBefore ?? []
    );
    activeHarnesses.add(harness);

    try {
      await harness.#initialize(options.persistedSession ?? true);
      return harness;
    } catch (error) {
      await harness.dispose();
      throw error;
    }
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  queueResponses(responses: FauxResponseStep[]): void {
    this.faux.appendResponses(
      responses.map((response) => async (context, options, state, model) => {
        this.modelContexts.push({
          messages: structuredClone(context.messages),
          systemPrompt: context.systemPrompt,
        });
        return typeof response === "function"
          ? await response(context, options, state, model)
          : response;
      })
    );
  }

  getService(): BackgroundTaskService {
    if (!this.latestService?.isAvailable()) {
      throw new Error("No current background task service is available");
    }
    return this.latestService;
  }

  async waitForTask(
    taskId: string,
    statuses: readonly BackgroundTaskSnapshot["status"][] = [
      "completed",
      "failed",
      "stopped",
    ]
  ): Promise<BackgroundTaskSnapshot> {
    let result: BackgroundTaskSnapshot | undefined;
    await waitFor(() => {
      result = this.getService().status(taskId)[0];
      return result !== undefined && statuses.includes(result.status);
    }, `task ${taskId} to reach ${statuses.join("/")}`);
    return result!;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    activeHarnesses.delete(this);
    this.#collectProcessGroups();
    this.#serviceUnsubscribe?.();
    this.#serviceUnsubscribe = undefined;
    this.#sessionUnsubscribe?.();
    this.#sessionUnsubscribe = undefined;

    let disposeError: unknown;
    if (this.runtime) {
      try {
        await withTimeout(
          this.runtime.dispose(),
          CLEANUP_TIMEOUT_MS,
          "Pi integration runtime cleanup"
        );
      } catch (error) {
        disposeError = error;
      }
    }

    for (const pid of this.#trackedPids) {
      killProcessGroup(pid);
    }
    try {
      await waitFor(
        () => [...this.#trackedPids].every((pid) => !isProcessGroupAlive(pid)),
        "integration process-group cleanup",
        CLEANUP_TIMEOUT_MS
      );
    } catch (error) {
      disposeError ??= error;
    }
    for (const pid of this.#trackedPids) {
      fallbackProcessGroups.delete(pid);
    }
    await rm(this.rootDir, { force: true, recursive: true });

    if (disposeError) {
      throw disposeError;
    }
  }

  async #initialize(persistedSession: boolean): Promise<void> {
    this.eventBus.on(BACKGROUND_TASK_SERVICE_CHANNEL, (data) => {
      if (isBackgroundTaskServiceAnnouncement(data)) {
        this.#bindService(data.service);
      }
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        agentDir: this.agentDir,
        cwd,
        modelRuntime: this.modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [
            ...this.#extensionPathsBefore,
            EXTENSION_PATH,
          ],
          eventBus: this.eventBus,
          noContextFiles: true,
          noPromptTemplates: true,
          noSkills: true,
          noThemes: true,
        },
        settingsManager,
      });
      return {
        ...(await createAgentSessionFromServices({
          model: this.faux.getModel(),
          services,
          sessionManager,
          thinkingLevel: "off",
          tools: ["background_task"],
        })),
        diagnostics: services.diagnostics,
        services,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      agentDir: this.agentDir,
      cwd: this.cwd,
      sessionManager: persistedSession
        ? SessionManager.create(this.cwd, this.sessionDir)
        : SessionManager.inMemory(this.cwd),
    });
    this.runtime.setRebindSession(async (session) => {
      await this.#bindSession(session);
    });
    await this.#bindSession(this.runtime.session);

    this.eventBus.emit(BACKGROUND_TASK_DISCOVERY_CHANNEL, {
      onService: (service: BackgroundTaskService) => {
        this.#bindService(service);
      },
    });
    await waitFor(
      () => this.latestService?.isAvailable() === true,
      "background task service discovery"
    );
  }

  async #bindSession(session: AgentSession): Promise<void> {
    await session.bindExtensions({
      commandContextActions: {
        fork: async (entryId, options) => {
          const result = await this.runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) =>
          await session.navigateTree(targetId, options),
        newSession: async (options) => await this.runtime.newSession(options),
        reload: async () => {
          await session.reload();
        },
        switchSession: async (sessionPath, options) =>
          await this.runtime.switchSession(sessionPath, options),
        waitForIdle: async () => {
          await session.waitForIdle();
        },
      },
      mode: this.mode,
      onError: (error) => {
        this.extensionErrors.push(error);
      },
    });
    this.#sessionUnsubscribe?.();
    this.#sessionUnsubscribe = session.subscribe((event) => {
      this.agentEvents.push(event);
    });
  }

  #bindService(service: BackgroundTaskService): void {
    if (service === this.latestService) {
      return;
    }
    this.#serviceUnsubscribe?.();
    this.latestService = service;
    this.#serviceUnsubscribe = service.subscribe((event) => {
      this.lifecycleEvents.push(event);
      const pid = event.task.pid;
      if (pid !== undefined) {
        this.#trackProcessGroup(pid);
      }
    });
    for (const task of service.list()) {
      if (task.pid !== undefined) {
        this.#trackProcessGroup(task.pid);
      }
    }
  }

  #trackProcessGroup(pid: number): void {
    this.#trackedPids.add(pid);
    fallbackProcessGroups.add(pid);
  }

  #collectProcessGroups(): void {
    const service = this.latestService;
    if (!service?.isAvailable()) {
      return;
    }
    for (const task of service.list()) {
      if (task.pid !== undefined) {
        this.#trackProcessGroup(task.pid);
      }
    }
  }
}

export { isProcessGroupAlive };
