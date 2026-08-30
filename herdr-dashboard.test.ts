import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskSnapshot } from "./core.ts";
import {
  BackgroundTasksHerdrDashboard,
  isHerdrDashboardAvailable,
} from "./herdr-dashboard.ts";

const originalEnvironment = {
  dashboard: process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD,
  herdr: process.env.HERDR_ENV,
  pane: process.env.HERDR_PANE_ID,
};

const context = (cwd = process.cwd()): ExtensionContext =>
  ({ cwd, mode: "tui" }) as ExtensionContext;

const task = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  bytesWritten: 12,
  command: "printf hello; sleep 30",
  completionPolicy: "notify",
  cwd: "/tmp/project",
  id: "abc12345",
  logPath: "/tmp/abc12345.log",
  name: "Build project",
  pid: 1234,
  startedAt: Date.now() - 5000,
  status: "running",
  ...overrides,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for dashboard state");
};

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  delete process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD;
});

afterEach(() => {
  if (originalEnvironment.dashboard === undefined) {
    delete process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD;
  } else {
    process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD =
      originalEnvironment.dashboard;
  }
  if (originalEnvironment.herdr === undefined) {
    delete process.env.HERDR_ENV;
  } else {
    process.env.HERDR_ENV = originalEnvironment.herdr;
  }
  if (originalEnvironment.pane === undefined) {
    delete process.env.HERDR_PANE_ID;
  } else {
    process.env.HERDR_PANE_ID = originalEnvironment.pane;
  }
});

describe("Herdr background task dashboard", () => {
  test("requires interactive Herdr and supports a kill switch", () => {
    expect(isHerdrDashboardAvailable(context())).toBe(true);
    expect(
      isHerdrDashboardAvailable({ mode: "rpc" } as ExtensionContext)
    ).toBe(false);
    delete process.env.HERDR_PANE_ID;
    expect(isHerdrDashboardAvailable(context())).toBe(false);
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.PI_BACKGROUND_TASK_HERDR_DASHBOARD = "0";
    expect(isHerdrDashboardAvailable(context())).toBe(false);
  });

  test("opens a right panel, streams tasks, and handles controls", async () => {
    const directory = await mkdtemp(`${tmpdir()}/background-herdr-`);
    const socketPath = `${directory}/dashboard.sock`;
    const calls: string[][] = [];
    const messages: Array<Record<string, unknown>> = [];
    const connectionStates: boolean[] = [];
    let client: net.Socket | undefined;
    let clientBuffer = "";
    let stopCalls = 0;
    const tasks = [
      task(),
      task({
        endedAt: Date.now() - 1000,
        exitCode: 0,
        id: "done1234",
        name: "Finished check",
        status: "completed",
      }),
    ];
    const dashboard = new BackgroundTasksHerdrDashboard(
      {
        list: () => tasks.map((item) => ({ ...item })),
        stop: (id) => {
          stopCalls += 1;
          const selected = tasks.find((item) => item.id === id);
          if (!selected) {
            throw new Error("missing task");
          }
          selected.status = "stopping";
          return { ...selected };
        },
      },
      {
        exec: async (args) => {
          calls.push(args);
          if (args[0] === "pane" && args[1] === "split") {
            return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
          }
          if (args[0] === "pane" && args[1] === "run") {
            client = net.createConnection(socketPath);
            client.setEncoding("utf8");
            client.on("data", (chunk: string) => {
              clientBuffer += chunk;
              for (;;) {
                const newline = clientBuffer.indexOf("\n");
                if (newline < 0) {
                  break;
                }
                const line = clientBuffer.slice(0, newline);
                clientBuffer = clientBuffer.slice(newline + 1);
                if (line.trim()) {
                  messages.push(JSON.parse(line) as Record<string, unknown>);
                }
              }
            });
            await new Promise<void>((resolve) => client?.once("connect", resolve));
            client.write(`${JSON.stringify({ type: "hello", version: 1 })}\n`);
          }
          return "{}";
        },
        runtimePath: () => socketPath,
        viewerPath: "/tmp/background-viewer.js",
      }
    );
    dashboard.onConnectionChange((connected) => {
      connectionStates.push(connected);
    });

    expect(await dashboard.ensureStarted(context(directory))).toBe(true);
    await waitFor(() =>
      messages.some((message) => message.type === "snapshot")
    );
    const firstSnapshot = messages.find(
      (message) => message.type === "snapshot"
    )!;
    expect(firstSnapshot.activeCount).toBe(1);
    expect(firstSnapshot.selectedTaskId).toBe("abc12345");
    expect(firstSnapshot.tasks).toHaveLength(2);
    expect(connectionStates).toEqual([true]);
    expect(
      calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "split" &&
          args.includes("right") &&
          args.includes("0.62") &&
          args.includes("--no-focus")
      )
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "run" &&
          args.join(" ").includes("background-viewer.js")
      )
    ).toBe(true);

    dashboard.recordOutput({
      nextByte: 24,
      preview: "live output",
      previewTruncated: false,
      startByte: 12,
      task: tasks[0]!,
    });
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === "snapshot" &&
          (message.selected as { output?: string } | undefined)?.output ===
            "live output"
      )
    );

    client!.write(
      `${JSON.stringify({ action: "stop-task", id: "stop-1", taskId: "abc12345", type: "action" })}\n`
    );
    await waitFor(() =>
      messages.some(
        (message) => message.type === "action-result" && message.id === "stop-1"
      )
    );
    expect(stopCalls).toBe(1);
    expect(tasks[0]?.status).toBe("stopping");

    client!.write(
      `${JSON.stringify({ action: "focus-parent", id: "focus-1", type: "action" })}\n`
    );
    await waitFor(() =>
      calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === "w1:p1"
      )
    );

    client!.destroy();
    await waitFor(() => connectionStates.includes(false));
    await dashboard.dispose();
    expect(
      calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "close" &&
          args[2] === "w1:p2"
      )
    ).toBe(true);
    await rm(directory, { force: true, recursive: true });
  });

  test("waits for stale teardown before starting a replacement panel", async () => {
    const directory = await mkdtemp(`${tmpdir()}/background-herdr-restart-`);
    const socketPath = `${directory}/dashboard.sock`;
    const calls: string[][] = [];
    const clients: net.Socket[] = [];
    const listBlocked = Promise.withResolvers<void>();
    const releaseList = Promise.withResolvers<void>();
    let blockLists = false;
    let splitCount = 0;
    const dashboard = new BackgroundTasksHerdrDashboard(
      {
        list: () => [task()],
        stop: () => task({ status: "stopping" }),
      },
      {
        exec: async (args) => {
          calls.push(args);
          if (args[0] === "pane" && args[1] === "split") {
            splitCount += 1;
            return JSON.stringify({
              result: { pane: { pane_id: `w1:p${String(splitCount + 1)}` } },
            });
          }
          if (args[0] === "pane" && args[1] === "run") {
            const client = net.createConnection(socketPath);
            clients.push(client);
            await new Promise<void>((resolve) => client.once("connect", resolve));
            client.write(`${JSON.stringify({ type: "hello", version: 1 })}\n`);
          }
          if (args[0] === "agent" && args[1] === "list" && blockLists) {
            listBlocked.resolve();
            await releaseList.promise;
          }
          return "{}";
        },
        runtimePath: () => socketPath,
        viewerPath: "/tmp/background-viewer.js",
      }
    );

    expect(await dashboard.ensureStarted(context(directory))).toBe(true);
    blockLists = true;
    clients[0]!.destroy();
    await listBlocked.promise;

    const replacement = dashboard.ensureStarted(context(directory));
    await Bun.sleep(20);
    expect(splitCount).toBe(1);
    releaseList.resolve();
    expect(await replacement).toBe(true);
    expect(splitCount).toBe(2);
    expect(dashboard.connected()).toBe(true);

    await dashboard.dispose();
    expect(
      calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "close" &&
          args[2] === "w1:p3"
      )
    ).toBe(true);
    await rm(directory, { force: true, recursive: true });
  });

  test("falls back when a connected viewer never sends hello", async () => {
    const directory = await mkdtemp(`${tmpdir()}/background-herdr-stall-`);
    const socketPath = `${directory}/dashboard.sock`;
    let client: net.Socket | undefined;
    const dashboard = new BackgroundTasksHerdrDashboard(
      {
        list: () => [task()],
        stop: () => task({ status: "stopping" }),
      },
      {
        connectTimeoutMs: 20,
        exec: async (args) => {
          if (args[0] === "pane" && args[1] === "split") {
            return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
          }
          if (args[0] === "pane" && args[1] === "run") {
            client = net.createConnection(socketPath);
            await new Promise<void>((resolve) => client?.once("connect", resolve));
          }
          return "{}";
        },
        runtimePath: () => socketPath,
        viewerPath: "/tmp/background-viewer.js",
      }
    );

    expect(await dashboard.ensureStarted(context(directory))).toBe(false);
    expect(client?.destroyed).toBe(true);
    await dashboard.dispose();
    await rm(directory, { force: true, recursive: true });
  });

  test("returns promptly when startup is aborted", async () => {
    const directory = await mkdtemp(`${tmpdir()}/background-herdr-abort-`);
    const socketPath = `${directory}/dashboard.sock`;
    const split = Promise.withResolvers<string>();
    const calls: string[][] = [];
    const dashboard = new BackgroundTasksHerdrDashboard(
      {
        list: () => [task()],
        stop: () => task({ status: "stopping" }),
      },
      {
        exec: async (args) => {
          calls.push(args);
          if (args[0] === "pane" && args[1] === "split") {
            return await split.promise;
          }
          return "{}";
        },
        runtimePath: () => socketPath,
        viewerPath: "/tmp/background-viewer.js",
      }
    );
    const controller = new AbortController();
    const starting = dashboard.ensureStarted(context(directory), controller.signal);
    await waitFor(() =>
      calls.some((args) => args[0] === "pane" && args[1] === "split")
    );
    controller.abort();
    expect(await starting).toBe(false);
    split.resolve(
      JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } })
    );
    await dashboard.dispose();
    expect(
      calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "close" &&
          args[2] === "w1:p2"
      )
    ).toBe(true);
    await rm(directory, { force: true, recursive: true });
  });
});
