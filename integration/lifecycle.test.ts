import { describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PiIntegrationHarness, waitFor } from "./harness.ts";

const INTEGRATION_TIMEOUT_MS = 20_000;
const COMPLETION_MARKER = "<background-task-completion>";
const WATCH_MARKER = "<background-task-watch-events>";
const DROP_COMPLETION_CONTEXT_PATH = fileURLToPath(
  new URL("./fixtures/drop-completion-context.ts", import.meta.url)
);

const contextContains = function contextContains(
  context: Context | undefined,
  value: string
): boolean {
  return context !== undefined && JSON.stringify(context.messages).includes(value);
};

const shellQuote = function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const gatedOutputCommand = function gatedOutputCommand(
  gatePath: string,
  output: string
): string {
  return `while [ ! -f ${shellQuote(gatePath)} ]; do sleep 0.01; done; printf %s ${shellQuote(output)}`;
};

const waitForCalls = async function waitForCalls(
  harness: PiIntegrationHarness,
  count: number
): Promise<void> {
  await waitFor(
    () => harness.faux.state.callCount === count && harness.session.isIdle,
    `${String(count)} settled faux provider calls`
  );
};

const backgroundToolResults = function backgroundToolResults(
  harness: PiIntegrationHarness
): Array<Record<string, unknown>> {
  return harness.session.sessionManager.getEntries().flatMap((entry) => {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "background_task" ||
      typeof entry.message.details !== "object" ||
      entry.message.details === null
    ) {
      return [];
    }
    return [entry.message.details as Record<string, unknown>];
  });
};

describe("background tasks through Pi lifecycles", () => {
  test(
    "starts one new turn when a wake task finishes while Pi is idle",
    async () => {
      const harness = await PiIntegrationHarness.create();
      const completionGate = path.join(harness.rootDir, "idle-completion-gate");
      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "start",
            command: gatedOutputCommand(completionGate, "idle-wake-output"),
            completionPolicy: "wake",
            name: "Idle wake",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The idle task is running"),
        fauxAssistantMessage("The idle completion was handled"),
      ]);

      await harness.session.prompt("Start an idle wake task");
      await writeFile(completionGate, "release");
      await waitForCalls(harness, 3);

      const task = harness.getService().list().find(({ name }) => name === "Idle wake");
      expect(task).toBeDefined();
      expect((await harness.waitForTask(task!.id)).status).toBe("completed");
      expect(
        harness.modelContexts.filter((context) =>
          contextContains(context, COMPLETION_MARKER)
        )
      ).toHaveLength(1);
      expect(
        harness.agentEvents.filter((event) => event.type === "agent_start")
      ).toHaveLength(2);
      expect(harness.faux.getPendingResponseCount()).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "steers one next model call when a wake task finishes during a turn",
    async () => {
      const harness = await PiIntegrationHarness.create();
      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "start",
            command: "printf active-wake-output",
            completionPolicy: "wake",
            name: "Active wake",
          }),
          { stopReason: "toolUse" }
        ),
        async () => {
          await waitFor(
            () => harness.session.agent.hasQueuedMessages(),
            "queued active completion steering"
          );
          return fauxAssistantMessage("The active turn can now finish");
        },
        fauxAssistantMessage("The steered completion was handled"),
      ]);

      await harness.session.prompt("Start an active wake task");
      await waitForCalls(harness, 3);

      const task = harness
        .getService()
        .list()
        .find(({ name }) => name === "Active wake");
      expect(task).toBeDefined();
      expect((await harness.waitForTask(task!.id)).status).toBe("completed");
      expect(contextContains(harness.modelContexts[2], COMPLETION_MARKER)).toBe(
        true
      );
      expect(
        harness.modelContexts.filter((context) =>
          contextContains(context, COMPLETION_MARKER)
        )
      ).toHaveLength(1);
      expect(
        harness.agentEvents.filter((event) => event.type === "agent_start")
      ).toHaveLength(1);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "injects fallback completion context once and removes it after observation",
    async () => {
      const harness = await PiIntegrationHarness.create({
        extensionPathsBefore: [DROP_COMPLETION_CONTEXT_PATH],
      });
      const completionGate = path.join(
        harness.rootDir,
        "fallback-completion-gate"
      );
      expect(harness.session.extensionRunner.getExtensionPaths()[0]).toBe(
        DROP_COMPLETION_CONTEXT_PATH
      );
      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "start",
            command: gatedOutputCommand(completionGate, "fallback-output"),
            completionPolicy: "wake",
            name: "Fallback wake",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The fallback task is running"),
        fauxAssistantMessage("The fallback completion was observed"),
        fauxAssistantMessage("No completion should repeat"),
      ]);

      await harness.session.prompt("Start a fallback wake task");
      await writeFile(completionGate, "release");
      await waitForCalls(harness, 3);
      expect(contextContains(harness.modelContexts[2], COMPLETION_MARKER)).toBe(
        true
      );

      await harness.session.prompt("Continue after observing completion");
      await waitForCalls(harness, 4);
      expect(contextContains(harness.modelContexts[3], COMPLETION_MARKER)).toBe(
        false
      );
      expect(
        harness.modelContexts.filter((context) =>
          contextContains(context, COMPLETION_MARKER)
        )
      ).toHaveLength(1);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "matches one-shot watches and advances committed log cursors",
    async () => {
      const harness = await PiIntegrationHarness.create();
      const outputGate = path.join(harness.rootDir, "watch-output-gate");
      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "start",
            command: gatedOutputCommand(outputGate, "alpha😀omega"),
            completionPolicy: "silent",
            name: "Cursor and watch",
          }),
          { stopReason: "toolUse" }
        ),
        () => {
          const task = harness
            .getService()
            .list()
            .find(({ name }) => name === "Cursor and watch");
          if (!task) {
            throw new Error("The cursor task was not started");
          }
          return fauxAssistantMessage(
            fauxToolCall("background_task", {
              action: "watch",
              condition: "output",
              pattern: "😀ome",
              taskId: task.id,
              wake: true,
            }),
            { stopReason: "toolUse" }
          );
        },
        async () => {
          await writeFile(outputGate, "release");
          await waitFor(
            () => harness.session.agent.hasQueuedMessages(),
            "queued watch steering"
          );
          return fauxAssistantMessage("The watch is armed");
        },
        fauxAssistantMessage("The watch event was handled"),
      ]);

      await harness.session.prompt("Start and watch the cursor task");
      await waitForCalls(harness, 4);

      const task = harness
        .getService()
        .list()
        .find(({ name }) => name === "Cursor and watch");
      expect(task).toBeDefined();
      expect((await harness.waitForTask(task!.id)).status).toBe("completed");
      const watches = harness.getService().watchStatus(task!.id);
      expect(watches).toHaveLength(1);
      expect(watches[0]?.status).toBe("fired");
      expect(watches[0]?.matchedOutput).toBe("😀ome");
      expect(contextContains(harness.modelContexts[3], WATCH_MARKER)).toBe(true);

      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "logs",
            afterByte: 0,
            maxBytes: 9,
            taskId: task!.id,
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The first log page was read"),
      ]);
      await harness.session.prompt("Read the first committed log page");
      await waitForCalls(harness, 6);

      const firstPage = backgroundToolResults(harness).find(
        (details) => details.output === "alpha😀"
      );
      expect(firstPage).toMatchObject({
        bytesRead: 9,
        nextByte: 9,
        output: "alpha😀",
        startByte: 0,
        totalBytes: 14,
        truncated: true,
      });

      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "logs",
            afterByte: firstPage!.nextByte,
            maxBytes: 32,
            taskId: task!.id,
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The second log page was read"),
      ]);
      await harness.session.prompt("Continue from the returned log cursor");
      await waitForCalls(harness, 8);

      const secondPage = backgroundToolResults(harness).find(
        (details) => details.output === "omega"
      );
      expect(secondPage).toMatchObject({
        bytesRead: 5,
        nextByte: 14,
        output: "omega",
        startByte: 9,
        totalBytes: 14,
        truncated: false,
      });
      expect(harness.extensionErrors).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
