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
  action: StringEnum(["start", "status", "logs", "stop"] as const, {
    description: "Operation to perform",
  }),
  command: Type.Optional(
    Type.String({ description: "Shell command for action=start" })
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
  taskId: Type.Optional(
    Type.String({
      description:
        "Task ID or unique prefix for status, logs, or stop. Omit for status to list all tasks.",
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
        "For action=start, start one automatic follow-up model turn when the task completes or fails. Default: false.",
    })
  ),
});

interface BoundedXml {
  text: string;
  truncated: boolean;
}

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
  completions: readonly TaskCompletion[]
): string {
  const lines = ["<background-task-completion>"];
  const selected = completions.slice(0, MAX_COMPLETION_TASKS);
  for (const completion of selected) {
    const { task } = completion;
    const name = escapeXmlWithinBytes(task.name, MAX_COMPLETION_NAME_BYTES);
    lines.push(
      `  <task id="${escapeXml(task.id)}">`,
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
  const pendingWake = new Map<string, TaskCompletion>();
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
    if (shuttingDown || pendingWake.size === 0) {
      pendingWake.clear();
      return;
    }
    const completions = [...pendingWake.values()];
    pendingWake.clear();
    const included = completions.slice(0, MAX_COMPLETION_TASKS);
    try {
      pi.sendMessage(
        {
          content: completionMessage(completions),
          customType: "background-task-completion",
          details: {
            omitted: completions.length - included.length,
            tasks: included.map((completion) => ({
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
        { deliverAs: "followUp", triggerTurn: true }
      );
    } catch (error) {
      console.error(
        `[background-tasks] automatic continuation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleFinished = (completion: TaskCompletion): void => {
    const { task } = completion;
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
      ctx.ui.notify(
        `${sanitizeUiInline(task.name)} ${task.status} after ${duration} (${task.id}${terminal}).`,
        task.status === "failed" ? "error" : "info"
      );
    }
    if (
      shuttingDown ||
      !task.wakeOnExit ||
      (task.status !== "completed" && task.status !== "failed")
    ) {
      return;
    }
    pendingWake.set(task.id, completion);
    if (!wakeHandle) {
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
      "Actions: start, status, logs, stop.",
      "Task status is injected before every model call, so status and logs are not polling tools.",
      `Log reads are capped at ${String(MAX_LOG_READ_BYTES)} bytes.`,
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
          return {
            content: [{ text: formatTaskList(tasks), type: "text" as const }],
            details: { tasks },
          };
        }
        case "logs": {
          if (!params.taskId) {
            throw new Error("taskId is required for action=logs");
          }
          const logs = await manager.logs(params.taskId, params.maxBytes);
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
      "Do not poll background_task status or logs merely to wait. Current status is injected before every model call, and wakeOnExit starts a follow-up turn when enabled.",
      "Use background_task logs only when task output is needed. Keep maxBytes modest to protect model context.",
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

  pi.on("context", (event) => ({
    messages: [
      ...event.messages,
      {
        content: formatModelContext(manager.list()),
        customType: "background-task-status",
        display: false,
        role: "custom" as const,
        timestamp: Date.now(),
      },
    ],
  }));

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    currentCtx = ctx;
    await manager.initialize();
    updateUi();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    activeDashboard?.dispose();
    activeDashboard = undefined;
    if (wakeHandle) {
      clearTimeout(wakeHandle);
      wakeHandle = undefined;
    }
    pendingWake.clear();
    await manager.shutdown();
    currentCtx?.ui.setStatus("background-tasks", undefined);
    currentCtx = undefined;
  });
};

export default backgroundTasksExtension;
