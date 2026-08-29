import { describe, expect, test } from "bun:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { BackgroundTaskManager } from "./core.ts";
import type { TaskCompletion } from "./core.ts";
import backgroundTasksExtension, {
  CompletionDeliveryLedger,
  completionMessage,
  MAX_COMPLETION_MESSAGE_BYTES,
} from "./index.ts";

interface ToolParams {
  action: "start" | "status" | "logs" | "stop";
  command?: string;
  maxBytes?: number;
  name?: string;
  taskId?: string;
  timeoutSeconds?: number;
  wakeOnExit?: boolean;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: { task?: { id: string; status: string }; tasks?: unknown[] };
}

interface RegisteredTool {
  execute: (
    toolCallId: string,
    params: ToolParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext
  ) => Promise<ToolResult>;
}

type EventHandler = (
  event: { messages?: unknown[] },
  ctx: ExtensionContext
) => unknown | Promise<unknown>;

interface HarnessOptions {
  notificationError?: Error;
  sendMessageError?: Error;
}

const createHarness = function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: { message: unknown; options: unknown }[] = [];
  const notifications: string[] = [];
  let sendAttempts = 0;
  const notificationReceived = Promise.withResolvers<null>();
  const statuses: (string | undefined)[] = [];
  let tool: RegisteredTool | undefined;

  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {
      // Command behavior is covered by the dashboard component tests.
    },
    registerMessageRenderer() {
      // Rendering is covered independently from the extension harness.
    },
    registerTool(value: RegisteredTool) {
      tool = value;
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      sendAttempts += 1;
      if (options.sendMessageError) {
        throw options.sendMessageError;
      }
      sentMessages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;
  backgroundTasksExtension(pi);

  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify(message: string) {
        if (options.notificationError) {
          throw options.notificationError;
        }
        notifications.push(message);
        notificationReceived.resolve(null);
      },
      setStatus(_id: string, status: string | undefined) {
        statuses.push(status);
      },
    },
  } as unknown as ExtensionContext;

  const emit = async (event: string, data: { messages?: unknown[] } = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      // Event handlers are ordered and may depend on prior handler effects.
      // oxlint-disable-next-line eslint/no-await-in-loop
      result = (await handler(data, ctx)) ?? result;
    }
    return result;
  };

  const execute = async (params: ToolParams): Promise<ToolResult> => {
    if (!tool) {
      throw new Error("background_task was not registered");
    }
    return await tool.execute(
      crypto.randomUUID(),
      params,
      undefined,
      undefined,
      ctx
    );
  };

  return {
    emit,
    execute,
    notificationReceived: notificationReceived.promise,
    notifications,
    get sendAttempts() {
      return sendAttempts;
    },
    sentMessages,
    statuses,
  };
};

const waitForCompletion = async function waitForCompletion(): Promise<void> {
  await Bun.sleep(250);
};

const fakeCompletion = function fakeCompletion(
  index: number,
  overrides: Partial<TaskCompletion> = {}
): TaskCompletion {
  return {
    output: `FALSE-START${"'".repeat(4096)}TRUE-END`,
    outputTruncated: false,
    task: {
      bytesWritten: 4096,
      command: "true",
      cwd: "/tmp/project",
      error: "'".repeat(4096),
      exitCode: 1,
      id: index.toString(16).padStart(8, "0"),
      logPath: `/tmp/task-${String(index)}.log`,
      name: "'".repeat(60),
      startedAt: 1000,
      status: "failed",
      wakeOnExit: true,
    },
    ...overrides,
  };
};

describe("completion delivery ledger", () => {
  test("tracks stable IDs, wake attempts, and enqueue state", () => {
    const ledger = new CompletionDeliveryLedger();
    const completion = fakeCompletion(1);

    const record = ledger.add(completion);
    expect(record).toMatchObject({
      state: "pending",
      wakeAttempted: false,
    });
    expect(record.deliveryId).toContain(completion.task.id);
    expect(ledger.add(completion).deliveryId).toBe(record.deliveryId);
    expect(ledger.wakeCandidates()).toHaveLength(1);

    ledger.markWakeAttempted([record]);
    expect(record).toMatchObject({
      state: "pending",
      wakeAttempted: true,
    });
    expect(ledger.wakeCandidates()).toHaveLength(0);

    ledger.markEnqueued([record]);
    expect(record.state).toBe("enqueued");
    expect(ledger.unobserved()).toHaveLength(1);

    ledger.markObservedByDeliveryId([record.deliveryId]);
    expect(record.state).toBe("observed");
    expect(ledger.unobserved()).toHaveLength(0);
  });
});

describe("completion messages", () => {
  test("bounds escaped output and oversized batches", () => {
    const message = completionMessage(
      Array.from({ length: 32 }, (_, index) => fakeCompletion(index))
    );

    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(
      MAX_COMPLETION_MESSAGE_BYTES
    );
    expect(message).toContain('<output-tail truncated="true">');
    expect(message).toContain("TRUE-END");
    expect(message).not.toContain("FALSE-START");
    expect(message).toContain('<omitted count="16">');
  });

  test("escapes task IDs used in XML attributes", () => {
    const completion = fakeCompletion(1);
    completion.task.id = `bad\"&<id`;

    const message = completionMessage([completion]);

    expect(message).toContain('id="bad&quot;&amp;&lt;id"');
    expect(message).not.toContain('id="bad\"&<id"');
  });

  test("does not claim output exists when capture failed", () => {
    const message = completionMessage([
      fakeCompletion(1, { output: undefined, outputError: "log disappeared" }),
    ]);

    expect(message).toContain("<output-unavailable");
    expect(message).toContain("when capture succeeds");
  });
});

describe("background tasks extension", () => {
  test("registers current task state in every model context", async () => {
    const harness = createHarness();
    await harness.emit("session_start");

    const empty = (await harness.emit("context", {
      messages: [],
    })) as { messages: { content: string }[] };
    expect(empty.messages.at(-1)?.content).toContain("Active: none");

    const started = await harness.execute({
      action: "start",
      command: "sleep 1",
      name: "Context task",
    });
    const id = started.details.task?.id;
    expect(id).toBeString();

    const active = (await harness.emit("context", {
      messages: [],
    })) as { messages: { content: string }[] };
    expect(active.messages.at(-1)?.content).toContain(`${id} [running]`);

    await harness.execute({ action: "stop", taskId: id });
    await waitForCompletion();
    await harness.emit("session_shutdown");
  });

  test("steers batched wake completions into the next model call", async () => {
    const harness = createHarness();
    await harness.emit("session_start");

    await Promise.all([
      harness.execute({
        action: "start",
        command: "sleep 0.05; printf first",
        name: "First task",
        wakeOnExit: true,
      }),
      harness.execute({
        action: "start",
        command: "sleep 0.05; printf second",
        name: "Second task",
        wakeOnExit: true,
      }),
    ]);
    await waitForCompletion();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.options).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
    expect(harness.sentMessages[0]?.message).toMatchObject({
      customType: "background-task-completion",
      display: true,
    });
    const completion = harness.sentMessages[0]?.message as {
      content?: string;
      details?: {
        deliveryIds?: string[];
        tasks?: { deliveryId?: string }[];
      };
    };
    expect(completion.details?.deliveryIds).toHaveLength(2);
    expect(
      completion.details?.deliveryIds?.every((id) =>
        id.startsWith("completion:")
      )
    ).toBe(true);
    expect(
      completion.details?.tasks?.every((task) =>
        task.deliveryId?.startsWith("completion:")
      )
    ).toBe(true);
    expect(completion.content).toContain("delivery-id=");
    expect(completion.content).toContain("<output-tail");
    expect(completion.content).toContain("first");
    expect(completion.content).toContain("second");
    expect(completion.content).not.toContain("<log>");
    expect(harness.notifications).toHaveLength(2);

    const context = (await harness.emit("context", {
      messages: [harness.sentMessages[0]?.message],
    })) as { messages: { content?: string; customType?: string }[] };
    expect(
      context.messages.some(
        (message) =>
          message.customType === "background-task-completion-fallback"
      )
    ).toBe(false);
    expect(context.messages.at(-1)?.content).not.toContain("First task");
    expect(context.messages.at(-1)?.content).not.toContain("Second task");

    await harness.emit("session_shutdown");
  });

  test("keeps one pending record after message enqueue fails", async () => {
    const harness = createHarness({
      sendMessageError: new Error("send failed"),
    });
    await harness.emit("session_start");

    await harness.execute({
      action: "start",
      command: "true",
      name: "Failed send",
      wakeOnExit: true,
    });
    await waitForCompletion();
    await waitForCompletion();

    expect(harness.sendAttempts).toBe(1);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toHaveLength(1);

    const fallback = (await harness.emit("context", {
      messages: [],
    })) as { messages: { content?: string; customType?: string }[] };
    expect(fallback.messages.at(-1)).toMatchObject({
      customType: "background-task-completion-fallback",
    });
    expect(fallback.messages.at(-1)?.content).toContain("Failed send");

    const observed = (await harness.emit("context", {
      messages: [],
    })) as { messages: { customType?: string }[] };
    expect(
      observed.messages.some(
        (message) =>
          message.customType === "background-task-completion-fallback"
      )
    ).toBe(false);

    await harness.emit("session_shutdown");
  });

  test("queues wake delivery before a UI notification failure", async () => {
    const harness = createHarness({
      notificationError: new Error("notify failed"),
    });
    await harness.emit("session_start");

    await harness.execute({
      action: "start",
      command: "true",
      name: "Failed notification",
      wakeOnExit: true,
    });
    await waitForCompletion();

    expect(harness.notifications).toHaveLength(0);
    expect(harness.sendAttempts).toBe(1);
    expect(harness.sentMessages).toHaveLength(1);

    await harness.emit("session_shutdown");
  });

  test("status and logs observe completion before its wake", async () => {
    for (const action of ["status", "logs"] as const) {
      const harness = createHarness();
      await harness.emit("session_start");
      const started = await harness.execute({
        action: "start",
        command: "true",
        name: `Observed by ${action}`,
        wakeOnExit: true,
      });
      await harness.notificationReceived;

      await harness.execute({
        action,
        taskId: started.details.task?.id,
      });
      await waitForCompletion();

      expect(harness.sendAttempts).toBe(0);
      const context = (await harness.emit("context", {
        messages: [],
      })) as { messages: { customType?: string }[] };
      expect(
        context.messages.some(
          (message) =>
            message.customType === "background-task-completion-fallback"
        )
      ).toBe(false);
      await harness.emit("session_shutdown");
    }
  });

  test("does not wake for default tasks or manual stops", async () => {
    const harness = createHarness();
    await harness.emit("session_start");

    await harness.execute({
      action: "start",
      command: "true",
      name: "No wake",
    });
    const longTask = await harness.execute({
      action: "start",
      command: "sleep 10",
      name: "Stopped task",
      wakeOnExit: true,
    });
    await harness.execute({
      action: "stop",
      taskId: longTask.details.task?.id,
    });
    await waitForCompletion();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.statuses).toContain("bg: 1 running");

    const context = (await harness.emit("context", {
      messages: [],
    })) as { messages: { content: string }[] };
    expect(context.messages.at(-1)?.content).toContain("No wake");
    expect(context.messages.at(-1)?.content).toContain("Stopped task");

    await harness.emit("session_shutdown");
  });

  test("cancels a queued automatic continuation during shutdown", async () => {
    const harness = createHarness();
    await harness.emit("session_start");

    await harness.execute({
      action: "start",
      command: "true",
      name: "Finishes before shutdown",
      wakeOnExit: true,
    });
    await harness.notificationReceived;
    await harness.emit("session_shutdown");
    await waitForCompletion();

    expect(harness.sentMessages).toHaveLength(0);
  });

  test("clears UI and context when manager shutdown fails", async () => {
    const harness = createHarness();
    await harness.emit("session_start");
    const originalShutdown = BackgroundTaskManager.prototype.shutdown;
    BackgroundTaskManager.prototype.shutdown = async () => {
      throw new Error("manager shutdown failed");
    };

    try {
      await expect(harness.emit("session_shutdown")).rejects.toThrow(
        "manager shutdown failed"
      );
      expect(harness.statuses.at(-1)).toBeUndefined();
      const context = (await harness.emit("context", {
        messages: [],
      })) as { messages: unknown[] };
      expect(context.messages).toHaveLength(0);
    } finally {
      BackgroundTaskManager.prototype.shutdown = originalShutdown;
      await harness.emit("session_shutdown");
    }
  });

  test("clears UI and context when runtime removal fails", async () => {
    const harness = createHarness();
    await harness.emit("session_start");
    const originalShutdown = BackgroundTaskManager.prototype.shutdown;
    BackgroundTaskManager.prototype.shutdown = async function shutdown() {
      await originalShutdown.call(this);
      throw new Error("runtime removal failed");
    };

    try {
      await expect(harness.emit("session_shutdown")).rejects.toThrow(
        "runtime removal failed"
      );
      expect(harness.statuses.at(-1)).toBeUndefined();
      const context = (await harness.emit("context", {
        messages: [],
      })) as { messages: unknown[] };
      expect(context.messages).toHaveLength(0);
    } finally {
      BackgroundTaskManager.prototype.shutdown = originalShutdown;
    }
  });
});
