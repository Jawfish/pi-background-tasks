import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BackgroundTaskManager,
  escapeXml,
  formatModelContext,
  formatTaskList,
  MAX_LOG_READ_BYTES,
  MAX_WATCH_PATTERN_BYTES,
} from "./core.ts";
import type { TaskCompletion } from "./core.ts";
import {
  formatUiDuration,
  renderBackgroundTaskCall,
  renderBackgroundTaskResult,
  renderCompletionMessage,
  sanitizeUiInline,
  TaskDashboardComponent,
} from "./tui.ts";
import type {
  BackgroundTaskToolDetails,
  CompletionDisplayDetails,
} from "./tui.ts";

const WAKE_BATCH_MS = 100;
const MAX_COMPLETION_TASKS = 16;
const MAX_COMPLETION_NAME_BYTES = 384;
const MAX_COMPLETION_ERROR_BYTES = 384;
const MAX_COMPLETION_OUTPUT_BYTES = 768;
export const MAX_COMPLETION_MESSAGE_BYTES = 32 * 1024;

const Parameters = Type.Object({
  action: StringEnum(
    ["start", "status", "logs", "stop", "watch", "unwatch"] as const,
    {
      description: "Operation to perform",
    }
  ),
  afterByte: Type.Optional(
    Type.Integer({
      description:
        "For action=logs, read forward after this byte offset and return a nextByte cursor.",
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 0,
    })
  ),
  command: Type.Optional(
    Type.String({ description: "Shell command for action=start" })
  ),
  condition: Type.Optional(
    StringEnum(["output", "exit", "inactivity"] as const, {
      description: "Condition for action=watch",
    })
  ),
  inactivitySeconds: Type.Optional(
    Type.Integer({
      description: "Quiet period for an inactivity watch",
      maximum: 86_400,
      minimum: 1,
    })
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      description: `Maximum log bytes to return. The hard limit is ${String(MAX_LOG_READ_BYTES)} bytes.`,
      maximum: MAX_LOG_READ_BYTES,
      minimum: 1,
    })
  ),
  name: Type.Optional(
    Type.String({
      description: "Short human-readable name for action=start",
      maxLength: 60,
    })
  ),
  pattern: Type.Optional(
    Type.String({
      description: "Literal UTF-8 text for an output watch",
      maxLength: MAX_WATCH_PATTERN_BYTES,
      minLength: 1,
    })
  ),
  taskId: Type.Optional(
    Type.String({
      description:
        "Task ID or unique prefix for status, logs, or stop. Omit for status to list all tasks.",
    })
  ),
  watchId: Type.Optional(
    Type.String({
      description: "Watch ID or unique prefix for action=unwatch",
    })
  ),
  wake: Type.Optional(
    Type.Boolean({
      description: "For action=watch, wake the model when the watch fires",
    })
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      description: "Optional task timeout for action=start",
      maximum: 86_400,
      minimum: 1,
    })
  ),
  wakeOnExit: Type.Optional(
    Type.Boolean({
      description:
        "For action=start, deliver one automatic continuation when the task completes or fails. Default: false.",
    })
  ),
});

export type CompletionDeliveryState = "pending" | "enqueued" | "observed";

export interface CompletionDeliveryRecord {
  completion: TaskCompletion;
  deliveryId: string;
  state: CompletionDeliveryState;
  wakeAttempted: boolean;
}

export class CompletionDeliveryLedger {
  readonly #records = new Map<string, CompletionDeliveryRecord>();
  readonly #taskDeliveries = new Map<string, string>();
  #sequence = 0;

  add(completion: TaskCompletion): CompletionDeliveryRecord {
    const existingId = this.#taskDeliveries.get(completion.task.id);
    if (existingId) {
      const existing = this.#records.get(existingId);
      if (existing) {
        return existing;
      }
    }
    this.#sequence += 1;
    const deliveryId = `completion:${completion.task.id}:${String(this.#sequence)}`;
    const record: CompletionDeliveryRecord = {
      completion,
      deliveryId,
      state: "pending",
      wakeAttempted: false,
    };
    this.#records.set(deliveryId, record);
    this.#taskDeliveries.set(completion.task.id, deliveryId);
    return record;
  }

  list(): CompletionDeliveryRecord[] {
    return [...this.#records.values()];
  }

  unobserved(): CompletionDeliveryRecord[] {
    return this.list().filter((record) => record.state !== "observed");
  }

  wakeCandidates(): CompletionDeliveryRecord[] {
    return this.list().filter(
      (record) => record.state === "pending" && !record.wakeAttempted
    );
  }

  markWakeAttempted(records: readonly CompletionDeliveryRecord[]): void {
    for (const record of records) {
      const stored = this.#records.get(record.deliveryId);
      if (stored?.state === "pending") {
        stored.wakeAttempted = true;
      }
    }
  }

  markEnqueued(records: readonly CompletionDeliveryRecord[]): void {
    for (const record of records) {
      const stored = this.#records.get(record.deliveryId);
      if (stored?.state === "pending") {
        stored.state = "enqueued";
      }
    }
  }

  markObservedByDeliveryId(deliveryIds: readonly string[]): void {
    for (const deliveryId of deliveryIds) {
      const record = this.#records.get(deliveryId);
      if (record) {
        record.state = "observed";
      }
    }
  }

  markObservedByTaskId(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const deliveryId = this.#taskDeliveries.get(taskId);
      if (deliveryId) {
        this.markObservedByDeliveryId([deliveryId]);
      }
    }
  }
}

interface BoundedXml {
  text: string;
  truncated: boolean;
}

const deliveryIdsInMessages = function deliveryIdsInMessages(
  messages: readonly unknown[]
): string[] {
  const deliveryIds: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const custom = message as { customType?: unknown; details?: unknown };
    if (
      custom.customType !== "background-task-completion" &&
      custom.customType !== "background-task-completion-fallback"
    ) {
      continue;
    }
    if (!custom.details || typeof custom.details !== "object") {
      continue;
    }
    const ids = (custom.details as { deliveryIds?: unknown }).deliveryIds;
    if (!Array.isArray(ids)) {
      continue;
    }
    deliveryIds.push(
      ...ids.filter((value): value is string => typeof value === "string")
    );
  }
  return deliveryIds;
};

const escapeXmlWithinBytes = function escapeXmlWithinBytes(
  value: string,
  maxBytes: number
): BoundedXml {
  const parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const escaped = escapeXml(character);
    const escapedBytes = Buffer.byteLength(escaped);
    if (bytes + escapedBytes > maxBytes) {
      return { text: parts.join(""), truncated: true };
    }
    parts.push(escaped);
    bytes += escapedBytes;
  }
  return { text: parts.join(""), truncated: false };
};

const escapeXmlTailWithinBytes = function escapeXmlTailWithinBytes(
  value: string,
  maxBytes: number
): BoundedXml {
  const parts: string[] = [];
  const characters = [...value];
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) {
      continue;
    }
    const escaped = escapeXml(character);
    const escapedBytes = Buffer.byteLength(escaped);
    if (bytes + escapedBytes > maxBytes) {
      parts.reverse();
      return { text: parts.join(""), truncated: true };
    }
    parts.push(escaped);
    bytes += escapedBytes;
  }
  parts.reverse();
  return { text: parts.join(""), truncated: false };
};

export const completionMessage = function completionMessage(
  completions: readonly TaskCompletion[],
  deliveryIds: readonly string[] = []
): string {
  const lines = ["<background-task-completion>"];
  const selected = completions.slice(0, MAX_COMPLETION_TASKS);
  for (const [index, completion] of selected.entries()) {
    const { task } = completion;
    const name = escapeXmlWithinBytes(task.name, MAX_COMPLETION_NAME_BYTES);
    const deliveryId = deliveryIds[index];
    const deliveryAttribute = deliveryId
      ? ` delivery-id="${escapeXml(deliveryId)}"`
      : "";
    lines.push(
      `  <task id="${escapeXml(task.id)}"${deliveryAttribute}>`,
      `    <name truncated="${String(name.truncated)}">${name.text}</name>`,
      `    <status>${task.status}</status>`
    );
    if (typeof task.exitCode === "number") {
      lines.push(`    <exit-code>${String(task.exitCode)}</exit-code>`);
    }
    if (task.signal) {
      lines.push(`    <signal>${task.signal}</signal>`);
    }
    if (task.error) {
      const error = escapeXmlWithinBytes(
        task.error,
        MAX_COMPLETION_ERROR_BYTES
      );
      lines.push(
        `    <error truncated="${String(error.truncated)}">${error.text}</error>`
      );
    }
    if (completion.output !== undefined) {
      const output = escapeXmlTailWithinBytes(
        completion.output,
        MAX_COMPLETION_OUTPUT_BYTES
      );
      const truncated = completion.outputTruncated === true || output.truncated;
      lines.push(
        `    <output-tail truncated="${String(truncated)}">${output.text}</output-tail>`
      );
    } else if (completion.outputError) {
      const outputError = escapeXmlWithinBytes(
        completion.outputError,
        MAX_COMPLETION_ERROR_BYTES
      );
      lines.push(
        `    <output-unavailable truncated="${String(outputError.truncated)}">${outputError.text}</output-unavailable>`
      );
    }
    lines.push("  </task>");
  }
  if (selected.length < completions.length) {
    lines.push(
      `  <omitted count="${String(completions.length - selected.length)}">The completion batch exceeded its task limit.</omitted>`
    );
  }
  lines.push(
    "  <guidance>Task states are terminal. A bounded output tail is included when capture succeeds; output-unavailable reports capture failure. Do not call status only to confirm completion. Use logs only if the task remains in current background status and more output is needed.</guidance>",
    "</background-task-completion>"
  );
  const message = lines.join("\n");
  if (Buffer.byteLength(message) <= MAX_COMPLETION_MESSAGE_BYTES) {
    return message;
  }
  return [
    "<background-task-completion>",
    `  <omitted count="${String(completions.length)}">Completion details exceeded the message byte limit.</omitted>`,
    "  <guidance>Task states are terminal. Inspect current background status for retained task details.</guidance>",
    "</background-task-completion>",
  ].join("\n");
};

const backgroundTasksExtension = function backgroundTasksExtension(
  pi: ExtensionAPI
): void {
  let currentCtx: ExtensionContext | undefined;
  let shuttingDown = false;
  let wakeHandle: NodeJS.Timeout | undefined;
  let activeDashboard: TaskDashboardComponent | undefined;
  const deliveryLedger = new CompletionDeliveryLedger();
  // Callbacks close over the manager, so initialization follows their definitions.
  // oxlint-disable-next-line eslint/prefer-const
  let manager: BackgroundTaskManager;

  const updateUi = (): void => {
    const ctx = currentCtx;
    if (!ctx?.hasUI) {
      return;
    }
    const tasks = manager.list();
    const running = tasks.filter((task) => task.status === "running").length;
    const stopping = tasks.filter((task) => task.status === "stopping").length;
    const activeCount = running + stopping;
    const parts = [
      running > 0 ? `${String(running)} running` : undefined,
      stopping > 0 ? `${String(stopping)} stopping` : undefined,
    ].filter((part): part is string => part !== undefined);
    ctx.ui.setStatus(
      "background-tasks",
      activeCount > 0 ? `bg: ${parts.join(" · ")}` : undefined
    );
    activeDashboard?.refresh();
  };

  const flushWake = (): void => {
    wakeHandle = undefined;
    if (shuttingDown) {
      return;
    }
    const candidates = deliveryLedger.wakeCandidates();
    let wakeRequested = false;
    for (
      let offset = 0;
      offset < candidates.length;
      offset += MAX_COMPLETION_TASKS
    ) {
      if (shuttingDown) {
        return;
      }
      const records = candidates.slice(offset, offset + MAX_COMPLETION_TASKS);
      deliveryLedger.markWakeAttempted(records);
      const completions = records.map((record) => record.completion);
      const triggerTurn: boolean = !wakeRequested;
      try {
        pi.sendMessage(
          {
            content: completionMessage(
              completions,
              records.map((record) => record.deliveryId)
            ),
            customType: "background-task-completion",
            details: {
              deliveryIds: records.map((record) => record.deliveryId),
              omitted: 0,
              tasks: records.map(({ completion, deliveryId }) => ({
                deliveryId,
                error: completion.task.error,
                exitCode: completion.task.exitCode,
                id: completion.task.id,
                name: completion.task.name,
                output: completion.output,
                outputError: completion.outputError,
                outputTruncated: completion.outputTruncated,
                signal: completion.task.signal,
                status: completion.task.status,
              })),
            },
            display: true,
          },
          { deliverAs: "steer", triggerTurn }
        );
        deliveryLedger.markEnqueued(records);
        wakeRequested ||= triggerTurn;
      } catch (error) {
        console.error(
          `[background-tasks] automatic continuation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  const handleFinished = (completion: TaskCompletion): void => {
    const { task } = completion;
    const shouldWake =
      !shuttingDown &&
      task.wakeOnExit &&
      (task.status === "completed" || task.status === "failed");
    if (shouldWake) {
      deliveryLedger.add(completion);
    }

    const ctx = currentCtx;
    if (!shuttingDown && ctx?.hasUI) {
      const duration = formatUiDuration(
        (task.endedAt ?? Date.now()) - task.startedAt
      );
      const terminal =
        typeof task.exitCode === "number"
          ? `, exit ${String(task.exitCode)}`
          : task.signal
            ? `, ${task.signal}`
            : "";
      try {
        ctx.ui.notify(
          `${sanitizeUiInline(task.name)} ${task.status} after ${duration} (${task.id}${terminal}).`,
          task.status === "failed" ? "error" : "info"
        );
      } catch (error) {
        console.error(
          `[background-tasks] completion notification failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (shouldWake && !wakeHandle) {
      wakeHandle = setTimeout(flushWake, WAKE_BATCH_MS);
      wakeHandle.unref();
    }
  };

  manager = new BackgroundTaskManager({
    onChange: updateUi,
    onFinished: handleFinished,
  });

  pi.registerMessageRenderer<CompletionDisplayDetails>(
    "background-task-completion",
    (message, options, theme) =>
      renderCompletionMessage(message, options, theme)
  );

  pi.registerTool<typeof Parameters, BackgroundTaskToolDetails>({
    description: [
      "Manage session-scoped background shell tasks.",
      "Actions: start, status, logs, stop, watch, unwatch.",
      "Task status is injected before every model call, so status and logs are not polling tools.",
      `Log reads are capped at ${String(MAX_LOG_READ_BYTES)} bytes. Reuse nextByte as afterByte for incremental reads.`,
    ].join(" "),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentCtx = ctx;
      switch (params.action) {
        case "start": {
          if (!params.command) {
            throw new Error("command is required for action=start");
          }
          const task = await manager.start({
            command: params.command,
            cwd: ctx.cwd,
            name: params.name,
            timeoutSeconds: params.timeoutSeconds,
            wakeOnExit: params.wakeOnExit ?? false,
          });
          const continuation = task.wakeOnExit
            ? "Automatic continuation: enabled. Do not poll or sleep to wait."
            : "Automatic continuation: disabled. The current status will still appear on each model call.";
          return {
            content: [
              {
                text: [
                  `Started ${task.name} (${task.id})`,
                  `PID: ${String(task.pid ?? "unknown")}`,
                  `Log: ${task.logPath}`,
                  continuation,
                ].join("\n"),
                type: "text" as const,
              },
            ],
            details: { task },
          };
        }
        case "status": {
          const tasks = manager.status(params.taskId);
          deliveryLedger.markObservedByTaskId(
            tasks
              .filter(
                (task) =>
                  task.status === "completed" || task.status === "failed"
              )
              .map((task) => task.id)
          );
          return {
            content: [{ text: formatTaskList(tasks), type: "text" as const }],
            details: { tasks },
          };
        }
        case "logs": {
          if (!params.taskId) {
            throw new Error("taskId is required for action=logs");
          }
          const logs = await manager.logs(
            params.taskId,
            params.maxBytes,
            params.afterByte
          );
          if (
            logs.task.status === "completed" ||
            logs.task.status === "failed"
          ) {
            deliveryLedger.markObservedByTaskId([logs.task.id]);
          }
          return {
            content: [{ text: logs.text, type: "text" as const }],
            details: logs,
          };
        }
        case "stop": {
          if (!params.taskId) {
            throw new Error("taskId is required for action=stop");
          }
          const task = manager.stop(params.taskId);
          return {
            content: [
              {
                text: `Stopping ${task.name} (${task.id}).`,
                type: "text" as const,
              },
            ],
            details: { task },
          };
        }
        case "watch": {
          if (!params.taskId) {
            throw new Error("taskId is required for action=watch");
          }
          if (!params.condition) {
            throw new Error("condition is required for action=watch");
          }
          const watch = manager.watch(params.taskId, {
            condition: params.condition,
            inactivitySeconds: params.inactivitySeconds,
            pattern: params.pattern,
            wake: params.wake,
          });
          return {
            content: [
              {
                text: `Watching ${watch.taskId} for ${watch.condition} (${watch.id}).`,
                type: "text" as const,
              },
            ],
            details: { watch },
          };
        }
        case "unwatch": {
          if (!params.watchId) {
            throw new Error("watchId is required for action=unwatch");
          }
          const watch = manager.unwatch(params.watchId);
          return {
            content: [
              {
                text: `Cancelled ${watch.condition} watch ${watch.id}.`,
                type: "text" as const,
              },
            ],
            details: { watch },
          };
        }
        default: {
          const unsupported: never = params.action;
          throw new Error(
            `Unsupported background_task action: ${String(unsupported)}`
          );
        }
      }
    },
    label: "Background Task",
    name: "background_task",
    parameters: Parameters,
    renderCall(args, theme, context) {
      return renderBackgroundTaskCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderBackgroundTaskResult(result, options, theme, context);
    },
    promptGuidelines: [
      "Use background_task with action=start for commands that should run without blocking the agent.",
      "Set background_task wakeOnExit=true only when the agent must continue automatically after that task completes or fails.",
      "Do not poll background_task status or logs merely to wait. Current active status is injected before every model call, and wakeOnExit steers completion into the next model call or starts a turn when idle.",
      "Use background_task logs only when task output is needed. Keep maxBytes modest to protect model context, and reuse a returned nextByte as afterByte for incremental reads.",
      "Use one-shot watches for output, exit, or inactivity conditions instead of polling. Cancel an active watch with action=unwatch.",
    ],
    promptSnippet:
      "Start, inspect, read, or stop session-scoped background shell tasks",
  });

  pi.registerCommand("background-tasks", {
    description: "Open the interactive background task monitor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/background-tasks requires TUI mode", "error");
        return;
      }

      let dashboard: TaskDashboardComponent | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => {
            dashboard = new TaskDashboardComponent({
              keybindings,
              manager,
              onClose: () => done(),
              theme,
              tui,
            });
            activeDashboard = dashboard;
            return dashboard;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              margin: 1,
              maxHeight: "90%",
              minWidth: 44,
              width: "90%",
            },
          }
        );
      } finally {
        dashboard?.dispose();
        if (activeDashboard === dashboard) {
          activeDashboard = undefined;
        }
      }
    },
  });

  pi.on("context", (event) => {
    if (shuttingDown) {
      return { messages: event.messages };
    }
    deliveryLedger.markObservedByDeliveryId(
      deliveryIdsInMessages(event.messages)
    );
    const fallback = deliveryLedger
      .unobserved()
      .slice(0, MAX_COMPLETION_TASKS);
    const messages = [
      ...event.messages,
      {
        content: formatModelContext(
          manager.list().filter(
            (task) =>
              !task.wakeOnExit ||
              (task.status !== "completed" && task.status !== "failed")
          )
        ),
        customType: "background-task-status",
        display: false,
        role: "custom" as const,
        timestamp: Date.now(),
      },
    ];
    if (fallback.length > 0) {
      messages.push({
        content: completionMessage(
          fallback.map((record) => record.completion),
          fallback.map((record) => record.deliveryId)
        ),
        customType: "background-task-completion-fallback",
        details: {
          deliveryIds: fallback.map((record) => record.deliveryId),
        },
        display: false,
        role: "custom" as const,
        timestamp: Date.now(),
      });
      deliveryLedger.markObservedByDeliveryId(
        fallback.map((record) => record.deliveryId)
      );
    }
    return { messages };
  });

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    currentCtx = ctx;
    await manager.initialize();
    updateUi();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const dashboard = activeDashboard;
    const ctx = currentCtx;
    activeDashboard = undefined;
    if (wakeHandle) {
      clearTimeout(wakeHandle);
      wakeHandle = undefined;
    }

    try {
      dashboard?.dispose();
    } finally {
      try {
        await manager.shutdown();
      } finally {
        currentCtx = undefined;
        ctx?.ui.setStatus("background-tasks", undefined);
      }
    }
  });
};

export default backgroundTasksExtension;
