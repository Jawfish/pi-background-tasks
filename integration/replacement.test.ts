import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { HANDOFF_LEASE_ENV } from "../index.ts";
import {
  isProcessGroupAlive,
  PiIntegrationHarness,
  waitFor,
} from "./harness.ts";

const INTEGRATION_TIMEOUT_MS = 20_000;

const startProbe = async function startProbe(
  harness: PiIntegrationHarness,
  name: string,
  command = "sleep 30"
) {
  const task = await harness.getService().start({
    command,
    completionPolicy: "silent",
    name,
  });
  expect(task.pid).toBeNumber();
  expect(isProcessGroupAlive(task.pid!)).toBe(true);
  return task;
};

const expectDead = async function expectDead(pid: number): Promise<void> {
  await waitFor(() => !isProcessGroupAlive(pid), `process group ${String(pid)}`);
  expect(isProcessGroupAlive(pid)).toBe(false);
};

describe("background task runtime replacement", () => {
  test(
    "preserves task identity and one callback binding across reload",
    async () => {
      const harness = await PiIntegrationHarness.create();
      const oldService = harness.getService();
      const completionGate = path.join(harness.rootDir, "reload-completion-gate");
      const task = await startProbe(
        harness,
        "Reload probe",
        `while [ ! -f '${completionGate}' ]; do sleep 0.01; done; printf reload-output`
      );

      await harness.session.reload();
      await waitFor(
        () =>
          harness.latestService !== undefined &&
          harness.latestService !== oldService &&
          harness.latestService.isAvailable(),
        "replacement service after reload"
      );

      const newService = harness.getService();
      expect(oldService.isAvailable()).toBe(false);
      expect(() => oldService.list()).toThrow("no longer available");
      const adopted = newService.status(task.id)[0];
      expect(adopted?.id).toBe(task.id);
      expect(adopted?.pid).toBe(task.pid);
      expect(isProcessGroupAlive(task.pid!)).toBe(true);

      await writeFile(completionGate, "release");
      expect((await harness.waitForTask(task.id)).status).toBe("completed");
      const logs = await newService.logs({ taskId: task.id });
      expect(logs.output).toBe("reload-output");
      expect(
        harness.lifecycleEvents.filter(
          (event) => event.type === "finished" && event.task.id === task.id
        )
      ).toHaveLength(1);
      expect(harness.extensionErrors).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "stops process groups for new, resume, fork, and quit",
    async () => {
      const newHarness = await PiIntegrationHarness.create();
      const newTask = await startProbe(newHarness, "New replacement");
      await newHarness.runtime.newSession();
      await expectDead(newTask.pid!);
      expect(newHarness.getService().list()).toEqual([]);

      const resumeHarness = await PiIntegrationHarness.create();
      const resumeTask = await startProbe(resumeHarness, "Resume replacement");
      const target = SessionManager.create(
        resumeHarness.cwd,
        resumeHarness.sessionDir
      );
      target.appendMessage({
        content: "Resume target",
        role: "user",
        timestamp: Date.now(),
      });
      await resumeHarness.runtime.switchSession(target.getSessionFile()!);
      await expectDead(resumeTask.pid!);
      expect(resumeHarness.getService().list()).toEqual([]);

      const forkHarness = await PiIntegrationHarness.create();
      forkHarness.queueResponses([fauxAssistantMessage("Fork point created")]);
      await forkHarness.session.prompt("Fork target");
      const forkEntry = forkHarness.session.sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant"
        )?.id;
      expect(forkEntry).toBeDefined();
      const forkTask = await startProbe(forkHarness, "Fork replacement");
      await forkHarness.runtime.fork(forkEntry!, { position: "at" });
      await expectDead(forkTask.pid!);
      expect(forkHarness.getService().list()).toEqual([]);

      const quitHarness = await PiIntegrationHarness.create();
      const quitTask = await startProbe(quitHarness, "Quit replacement");
      await quitHarness.dispose();
      await expectDead(quitTask.pid!);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "cleans an abandoned reload handoff after its lease",
    async () => {
      const harness = await PiIntegrationHarness.create();
      const task = await startProbe(harness, "Abandoned reload");
      const previousLease = process.env[HANDOFF_LEASE_ENV];
      process.env[HANDOFF_LEASE_ENV] = "25";
      try {
        await harness.session.extensionRunner.emit({
          reason: "reload",
          type: "session_shutdown",
        });
      } finally {
        if (previousLease === undefined) {
          delete process.env[HANDOFF_LEASE_ENV];
        } else {
          process.env[HANDOFF_LEASE_ENV] = previousLease;
        }
      }

      await expectDead(task.pid!);
      expect(harness.latestService?.isAvailable()).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
