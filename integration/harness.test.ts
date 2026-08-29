import { describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  isProcessGroupAlive,
  PiIntegrationHarness,
  waitFor,
} from "./harness.ts";

const INTEGRATION_TIMEOUT_MS = 15_000;

describe("Pi integration harness", () => {
  test(
    "loads the packaged extension with a credential-free local model",
    async () => {
      const harness = await PiIntegrationHarness.create();

      expect(harness.session.extensionRunner.getExtensionPaths()).toContain(
        `${process.cwd()}/index.ts`
      );
      expect(harness.session.getActiveToolNames()).toEqual(["background_task"]);
      expect(harness.session.sessionFile).toStartWith(harness.sessionDir);
      expect(harness.getService().version).toBe("v1");
      expect(harness.session.model?.provider).toStartWith(
        "background-task-test-"
      );

      harness.queueResponses([
        fauxAssistantMessage(
          fauxToolCall("background_task", {
            action: "start",
            command: "printf integration-output",
            completionPolicy: "silent",
            name: "Pi integration smoke",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("integration complete"),
      ]);
      await harness.session.prompt("Start the integration smoke task");

      expect(harness.faux.state.callCount).toBe(2);
      const started = harness.lifecycleEvents.find(
        (event) => event.type === "started"
      );
      expect(started).toBeDefined();
      const task = await harness.waitForTask(started!.task.id);
      expect(task.status).toBe("completed");
      const logs = await harness.getService().logs({ taskId: task.id });
      expect(logs.output).toBe("integration-output");
      expect(
        harness.agentEvents.some(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "background_task" &&
            !event.isError
        )
      ).toBe(true);
      expect(
        harness.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === "background_task"
          )
      ).toBe(true);
      expect(harness.extensionErrors).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "stops tracked process groups during bounded cleanup",
    async () => {
      const harness = await PiIntegrationHarness.create();
      const task = await harness.getService().start({
        command: "sleep 30",
        completionPolicy: "silent",
        name: "Cleanup probe",
      });
      expect(task.pid).toBeNumber();
      expect(isProcessGroupAlive(task.pid!)).toBe(true);

      await harness.dispose();
      await waitFor(
        () => !isProcessGroupAlive(task.pid!),
        "cleanup probe process group"
      );
      expect(isProcessGroupAlive(task.pid!)).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
