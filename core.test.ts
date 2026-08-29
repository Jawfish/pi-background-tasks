import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BACKGROUND_TASK_SHELL_ENV,
  BackgroundTaskManager,
  DEFAULT_SHELL,
  formatModelContext,
  formatTaskList,
} from "./core.ts";
import type {
  BackgroundTaskManagerOptions,
  TaskCompletion,
  TaskSnapshot,
  TaskWatchEvent,
} from "./core.ts";

const managers: BackgroundTaskManager[] = [];
const runtimeDirs: string[] = [];
const linuxTest = process.platform === "linux" ? test : test.skip;

const createManager = async function createManager(
  options: BackgroundTaskManagerOptions = {}
): Promise<BackgroundTaskManager> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-bg-test-"));
  const manager = new BackgroundTaskManager({
    killGraceMs: 100,
    runtimeDir,
    ...options,
  });
  managers.push(manager);
  runtimeDirs.push(runtimeDir);
  await manager.initialize();
  return manager;
};

const waitForTerminal = async function waitForTerminal(
  manager: BackgroundTaskManager,
  taskId: string
): Promise<TaskSnapshot> {
  return await Promise.race([
    manager.wait(taskId),
    sleep(3000).then(() => {
      throw new Error(`Task ${taskId} did not finish`);
    }),
  ]);
};

const pathExists = async function pathExists(
  filePath: string
): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const processIsAlive = async function processIsAlive(
  pid: number
): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf-8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z";
  } catch {
    return false;
  }
};

const waitForLog = async function waitForLog(
  manager: BackgroundTaskManager,
  taskId: string,
  expected: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Polling is intentional here because the child writes asynchronously.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const logs = await manager.logs(taskId);
    if (logs.text.includes(expected)) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(10);
  }
  throw new Error(`Task ${taskId} did not log ${expected}`);
};

const resistantTreeCommand = function resistantTreeCommand(
  finalCommand = "wait"
): string {
  return [
    `sh -c 'trap "" TERM; while :; do sleep 1; done' >/dev/null 2>&1 &`,
    "child=$!",
    `printf 'child=%s\\n' "$child"`,
    `trap 'exit 0' TERM`,
    finalCommand,
  ].join("\n");
};

const readChildPid = async function readChildPid(
  manager: BackgroundTaskManager,
  taskId: string
): Promise<number> {
  await waitForLog(manager, taskId, "child=");
  const logs = await manager.logs(taskId);
  const childPid = Number(
    /^child=(?<pid>\d+)$/mu.exec(logs.output)?.groups?.pid
  );
  expect(childPid).toBeGreaterThan(0);
  return childPid;
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    runtimeDirs
      .splice(0)
      .map((runtimeDir) => rm(runtimeDir, { force: true, recursive: true }))
  );
});

describe("BackgroundTaskManager", () => {
  test("runs a command and returns its log", async () => {
    const finished: TaskSnapshot[] = [];
    const manager = await createManager({
      onFinished: (completion) => finished.push(completion.task),
    });
    const started = await manager.start({
      command: "printf 'hello from task'",
      cwd: process.cwd(),
      name: "Greeting",
      wakeOnExit: true,
    });

    const terminal = await waitForTerminal(manager, started.id);
    const logs = await manager.logs(started.id);

    expect(terminal).toMatchObject({
      name: "Greeting",
      status: "completed",
      wakeOnExit: true,
    });
    expect(terminal.lastOutputAt).toBeGreaterThanOrEqual(terminal.startedAt);
    expect(terminal.bytesWritten).toBe(logs.totalBytes);
    expect(logs.text).toContain("hello from task");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.id).toBe(started.id);
  });

  test("reports only committed output and waits for write callbacks", async () => {
    const delayedCallbacks: (() => void)[] = [];
    let releaseWrites = false;
    const manager = await createManager({
      writeLogChunk(stream, data, callback) {
        return stream.write(data, (error) => {
          const complete = () => callback(error);
          if (releaseWrites) {
            complete();
          } else {
            delayedCallbacks.push(complete);
          }
        });
      },
    });
    const started = await manager.start({
      command: "printf first; printf second >&2",
      cwd: process.cwd(),
    });
    let waitResolved = false;
    const waiting = manager.wait(started.id).then((snapshot) => {
      waitResolved = true;
      return snapshot;
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (delayedCallbacks.length > 0) {
        break;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await sleep(5);
    }

    const pending = manager.status(started.id)[0];
    const pendingLogs = await manager.logs(started.id);
    expect(delayedCallbacks.length).toBeGreaterThan(0);
    expect(pending?.lastOutputAt).toBeGreaterThanOrEqual(started.startedAt);
    expect(pending?.bytesWritten).toBe(0);
    expect(pendingLogs.totalBytes).toBe(0);
    expect(waitResolved).toBe(false);

    releaseWrites = true;
    for (const callback of delayedCallbacks.splice(0)) {
      callback();
    }
    const terminal = await waiting;
    const logs = await manager.logs(started.id);

    expect(terminal.status).toBe("completed");
    expect(terminal.bytesWritten).toBe(11);
    expect(logs.totalBytes).toBe(11);
    expect(logs.output).toContain("first");
    expect(logs.output).toContain("second");
  });

  test("truncates names without splitting a Unicode character", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: "true",
      cwd: process.cwd(),
      name: `${"x".repeat(59)}🙂tail`,
    });

    const terminal = await waitForTerminal(manager, started.id);

    expect([...terminal.name]).toHaveLength(60);
    expect(terminal.name).toEndWith("🙂");
    expect(terminal.name).not.toContain("�");
  });

  test("uses a predictable POSIX shell from PATH", async () => {
    expect(DEFAULT_SHELL).toBe("sh");
    const manager = await createManager();
    const started = await manager.start({
      command: "value='shell ok'; printf '%s' \"$value\"",
      cwd: process.cwd(),
    });

    const terminal = await waitForTerminal(manager, started.id);
    const logs = await manager.logs(started.id);

    expect(terminal.status).toBe("completed");
    expect(logs.text).toContain("shell ok");
  });

  test("accepts a shell override through the environment", async () => {
    const previous = process.env[BACKGROUND_TASK_SHELL_ENV];
    let manager: BackgroundTaskManager;
    try {
      process.env[BACKGROUND_TASK_SHELL_ENV] =
        "/definitely/missing/background-task-environment-shell";
      manager = await createManager();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, BACKGROUND_TASK_SHELL_ENV);
      } else {
        process.env[BACKGROUND_TASK_SHELL_ENV] = previous;
      }
    }

    const started = await manager.start({
      command: "true",
      cwd: process.cwd(),
    });
    const terminal = await waitForTerminal(manager, started.id);

    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("ENOENT");
  });

  test("cleans the log after a synchronous spawn failure", async () => {
    const manager = await createManager();
    const runtimeDir = runtimeDirs.at(-1);
    expect(runtimeDir).toBeString();
    if (!runtimeDir) {
      throw new Error("Missing test runtime directory");
    }

    await expect(
      manager.start({ command: "printf '\0'", cwd: process.cwd() })
    ).rejects.toThrow("Failed to start background task");

    expect(await readdir(runtimeDir)).toHaveLength(0);
  });

  test("records command and spawn failures", async () => {
    const manager = await createManager();
    const exited = await manager.start({
      command: "printf 'failure output' >&2; exit 7",
      cwd: process.cwd(),
    });
    const missingShell = await createManager({
      shell: "/definitely/missing/background-task-shell",
    });
    const notSpawned = await missingShell.start({
      command: "true",
      cwd: process.cwd(),
    });

    const [exitFailure, spawnFailure] = await Promise.all([
      waitForTerminal(manager, exited.id),
      waitForTerminal(missingShell, notSpawned.id),
    ]);
    const logs = await manager.logs(exited.id);

    expect(exitFailure.status).toBe("failed");
    expect(exitFailure.exitCode).toBe(7);
    expect(exitFailure.error).toContain("Exited with code 7");
    expect(logs.text).toContain("failure output");
    expect(spawnFailure.status).toBe("failed");
    expect(spawnFailure.error).toContain("ENOENT");
  });

  test("reports external signal termination clearly", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: "kill -TERM $$",
      cwd: process.cwd(),
    });

    const terminal = await waitForTerminal(manager, started.id);

    expect(terminal.status).toBe("failed");
    expect(terminal.signal).toBe("SIGTERM");
    expect(terminal.error).toBe("Terminated by SIGTERM");
  });

  linuxTest(
    "cleans up a TERM-resistant redirected child before completion",
    async () => {
      const manager = await createManager({ killGraceMs: 25 });
      const started = await manager.start({
        command:
          "sh -c 'trap \"\" TERM; while :; do sleep 1; done' >/dev/null 2>&1 & printf '%s\\n' \"$!\"",
        cwd: process.cwd(),
      });

      const terminal = await waitForTerminal(manager, started.id);
      const logs = await manager.logs(started.id);
      const childPid = Number(/^(?<pid>\d+)$/mu.exec(logs.output)?.groups?.pid);

      expect(childPid).toBeGreaterThan(0);
      expect(terminal.status).toBe("completed");
      expect(terminal.exitCode).toBe(0);
      expect(await processIsAlive(childPid)).toBe(false);
    }
  );

  linuxTest("stops the whole background process group", async () => {
    const manager = await createManager({ killGraceMs: 25 });
    const started = await manager.start({
      command: resistantTreeCommand(),
      cwd: process.cwd(),
      name: "Long task",
    });
    const childPid = await readChildPid(manager, started.id);

    const stopping = manager.stop(started.id.slice(0, 4));
    const terminal = await waitForTerminal(manager, started.id);

    expect(stopping.status).toBe("stopping");
    expect(terminal.status).toBe("stopped");
    expect(terminal.exitCode).toBe(0);
    expect(await processIsAlive(childPid)).toBe(false);
    expect(() => manager.stop(started.id)).toThrow("already stopped");
  });

  test("escalates to SIGKILL when a process ignores SIGTERM", async () => {
    const manager = await createManager({ killGraceMs: 25 });
    const started = await manager.start({
      command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done",
      cwd: process.cwd(),
    });
    await waitForLog(manager, started.id, "ready");

    manager.stop(started.id);
    const terminal = await waitForTerminal(manager, started.id);

    expect(terminal.status).toBe("stopped");
    expect(terminal.signal).toBe("SIGKILL");
  });

  linuxTest(
    "cleans resistant descendants when a task times out",
    async () => {
      const manager = await createManager({ killGraceMs: 25 });
      const started = await manager.start({
        command: resistantTreeCommand(),
        cwd: process.cwd(),
        timeoutSeconds: 1,
      });
      const childPid = await readChildPid(manager, started.id);

      const terminal = await waitForTerminal(manager, started.id);

      expect(terminal.status).toBe("failed");
      expect(terminal.error).toBe("Timed out after 1s");
      expect(await processIsAlive(childPid)).toBe(false);
    }
  );

  linuxTest(
    "cleans resistant descendants after the output cap",
    async () => {
      const manager = await createManager({
        killGraceMs: 25,
        maxOutputBytes: 64,
      });
      const started = await manager.start({
        command: resistantTreeCommand(
          `while :; do printf '123456789012345678901234567890'; done`
        ),
        cwd: process.cwd(),
      });

      const terminal = await waitForTerminal(manager, started.id);
      const logs = await manager.logs(started.id);
      const childPid = Number(
        /^child=(?<pid>\d+)$/mu.exec(logs.output)?.groups?.pid
      );

      expect(childPid).toBeGreaterThan(0);
      expect(terminal.status).toBe("failed");
      expect(terminal.error).toContain("Output exceeded 64 bytes");
      expect(logs.totalBytes).toBeGreaterThanOrEqual(64);
      expect(terminal.bytesWritten).toBe(logs.totalBytes);
      expect(logs.text).toContain("background task stopped");
      expect(await processIsAlive(childPid)).toBe(false);
    }
  );

  linuxTest("cleans resistant descendants during shutdown", async () => {
    const manager = await createManager({ killGraceMs: 25 });
    const started = await manager.start({
      command: resistantTreeCommand(),
      cwd: process.cwd(),
    });
    const childPid = await readChildPid(manager, started.id);

    await manager.shutdown();
    const terminal = await manager.wait(started.id);

    expect(terminal.status).toBe("stopped");
    expect(await processIsAlive(childPid)).toBe(false);
  });

  linuxTest("retains process-group cleanup errors", async () => {
    const manager = await createManager({ killGraceMs: 25 });
    const started = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
    });
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -(started.pid ?? 0) && signal === 0) {
        const error = new Error("probe denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return Reflect.apply(
        originalKill,
        process,
        signal === undefined ? [pid] : [pid, signal]
      ) as boolean;
    }) as typeof process.kill;

    let terminal: TaskSnapshot;
    try {
      manager.stop(started.id);
      terminal = await waitForTerminal(manager, started.id);
    } finally {
      process.kill = originalKill;
    }

    expect(terminal.status).toBe("stopped");
    expect(terminal.error).toContain("Could not inspect the process group");
    expect(terminal.error).toContain("Could not confirm process-group cleanup");
  });

  test("registers, inspects, and cancels bounded task watches", async () => {
    const manager = await createManager({ maxWatchesPerTask: 3 });
    const started = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
    });
    const output = manager.watch(started.id, {
      condition: "output",
      pattern: "ready",
      wake: true,
    });
    expect(() =>
      manager.watch(started.id, {
        condition: "output",
        pattern: "ready",
      })
    ).toThrow("identical watch");
    const exit = manager.watch(started.id, { condition: "exit" });
    const inactivity = manager.watch(started.id, {
      condition: "inactivity",
      inactivitySeconds: 5,
    });

    expect(manager.status(started.id)[0]?.watches).toHaveLength(3);
    expect(manager.watchStatus(started.id.slice(0, 4))).toHaveLength(3);
    expect(() =>
      manager.watch(started.id, {
        condition: "output",
        pattern: "another",
      })
    ).toThrow("At most 3 watches");

    const cancelled = manager.unwatch(output.id.slice(0, 4));
    expect(cancelled.status).toBe("cancelled");
    expect(manager.status(started.id)[0]?.watches).toHaveLength(2);
    expect(() => manager.unwatch(output.id)).toThrow("already cancelled");

    manager.stop(started.id);
    await waitForTerminal(manager, started.id);
    expect(manager.watchStatus(started.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: exit.id,
          nextByte: 0,
          startByte: 0,
          status: "fired",
        }),
        expect.objectContaining({ id: inactivity.id, status: "expired" }),
      ])
    );
    expect(() =>
      manager.watch(started.id, { condition: "exit" })
    ).toThrow("because it is stopped");
  });

  test("fires an output watch once across committed chunks", async () => {
    const events: TaskWatchEvent[] = [];
    const fired = Promise.withResolvers<TaskWatchEvent>();
    let logsAtFire: Promise<Awaited<ReturnType<BackgroundTaskManager["logs"]>>>;
    const manager = await createManager({
      onWatchFired(event) {
        events.push(event);
        logsAtFire = manager.logs(event.task.id, 32, event.startByte);
        fired.resolve(event);
      },
    });
    const started = await manager.start({
      command:
        "sleep 0.05; printf rea; sleep 0.05; printf 'dy🙂'; printf 'ready🙂'; sleep 30",
      cwd: process.cwd(),
    });
    const watch = manager.watch(started.id, {
      condition: "output",
      pattern: "ready🙂",
      wake: true,
    });

    const event = await Promise.race([
      fired.promise,
      sleep(2000).then(() => {
        throw new Error("Output watch did not fire");
      }),
    ]);
    const logs = await logsAtFire!;
    await sleep(100);

    expect(event.watch).toMatchObject({
      id: watch.id,
      matchedOutput: "ready🙂",
      nextByte: 9,
      startByte: 0,
      status: "fired",
    });
    expect(event.task.status).toBe("running");
    expect(event.output).toBe("ready🙂");
    expect(logs.output).toContain("ready🙂");
    expect(events).toHaveLength(1);
    expect(manager.watchStatus(started.id)[0]?.status).toBe("fired");

    manager.stop(started.id);
    await waitForTerminal(manager, started.id);
  });

  test("resets inactivity watches when new output arrives", async () => {
    const fired = Promise.withResolvers<TaskWatchEvent>();
    const manager = await createManager({
      onWatchFired: (event) => fired.resolve(event),
    });
    const started = await manager.start({
      command: "sleep 0.04; printf a; sleep 0.04; printf b; sleep 30",
      cwd: process.cwd(),
    });
    const watch = manager.watch(started.id, {
      condition: "inactivity",
      inactivitySeconds: 0.08,
      wake: true,
    });

    const event = await Promise.race([
      fired.promise,
      sleep(2000).then(() => {
        throw new Error("Inactivity watch did not fire");
      }),
    ]);

    expect(event.watch).toMatchObject({
      id: watch.id,
      nextByte: 2,
      startByte: 2,
      status: "fired",
    });
    expect(event.task.status).toBe("running");
    expect(event.task.lastOutputAt).toBeGreaterThan(watch.createdAt);

    manager.stop(started.id);
    await waitForTerminal(manager, started.id);
  });

  test("fires exit watches and expires impossible watches", async () => {
    const events: TaskWatchEvent[] = [];
    const manager = await createManager({
      onWatchFired: (event) => events.push(event),
    });
    const started = await manager.start({
      command: "sleep 0.05; printf done",
      cwd: process.cwd(),
    });
    const exit = manager.watch(started.id, {
      condition: "exit",
      wake: true,
    });
    const output = manager.watch(started.id, {
      condition: "output",
      pattern: "never",
    });
    const inactivity = manager.watch(started.id, {
      condition: "inactivity",
      inactivitySeconds: 30,
    });

    const terminal = await waitForTerminal(manager, started.id);
    const watches = manager.watchStatus(started.id);

    expect(terminal.status).toBe("completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      nextByte: 4,
      startByte: 4,
      task: { status: "completed" },
      watch: { id: exit.id, status: "fired" },
    });
    expect(watches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: output.id, status: "expired" }),
        expect.objectContaining({ id: inactivity.id, status: "expired" }),
      ])
    );
  });

  test("enforces cooldown before rearming a fired watch", async () => {
    const fired = Promise.withResolvers<TaskWatchEvent>();
    const manager = await createManager({
      onWatchFired: (event) => fired.resolve(event),
      watchRearmCooldownMs: 25,
    });
    const started = await manager.start({
      command: "sleep 0.05; printf ready; sleep 30",
      cwd: process.cwd(),
    });
    const first = manager.watch(started.id, {
      condition: "output",
      pattern: "ready",
    });
    await fired.promise;

    expect(() =>
      manager.watch(started.id, {
        condition: "output",
        pattern: "ready",
      })
    ).toThrow("rearm cooldown");
    await sleep(30);
    const rearmed = manager.watch(started.id, {
      condition: "output",
      pattern: "ready",
    });
    expect(rearmed.id).not.toBe(first.id);
    manager.unwatch(rearmed.id);

    manager.stop(started.id);
    await waitForTerminal(manager, started.id);
  });

  test("rejects invalid watch conditions", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
    });

    expect(() =>
      manager.watch(started.id, { condition: "output", pattern: "" })
    ).toThrow("pattern is required");
    expect(() =>
      manager.watch(started.id, {
        condition: "output",
        pattern: "x".repeat(513),
      })
    ).toThrow("limited to 512 bytes");
    expect(() =>
      manager.watch(started.id, {
        condition: "inactivity",
        inactivitySeconds: 0,
      })
    ).toThrow("positive number");
    expect(() =>
      manager.watch(started.id, { condition: "exit", pattern: "bad" })
    ).toThrow("do not accept");

    manager.stop(started.id);
    await waitForTerminal(manager, started.id);
  });

  test("enforces the active limit across concurrent starts", async () => {
    const manager = await createManager({ maxActiveTasks: 2 });
    const attempts = await Promise.allSettled(
      Array.from(
        { length: 3 },
        async () =>
          await manager.start({ command: "sleep 30", cwd: process.cwd() })
      )
    );

    expect(
      attempts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(2);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect(String(rejected?.reason)).toContain(
      "At most 2 background tasks may run at once"
    );
  });

  test("keeps the visible recent list small but retains concurrent results", async () => {
    const manager = await createManager({
      maxActiveTasks: 3,
      maxRecentTasks: 1,
    });
    const started = await Promise.all(
      Array.from(
        { length: 3 },
        async (_, index) =>
          await manager.start({
            command: "true",
            cwd: process.cwd(),
            name: `Concurrent ${String(index)}`,
          })
      )
    );
    await Promise.all(
      started.map(async (task) => await waitForTerminal(manager, task.id))
    );

    expect(manager.list()).toHaveLength(1);
    for (const task of started) {
      expect(manager.status(task.id)).toHaveLength(1);
    }
  });

  test("preserves wake output after task state and logs are pruned", async () => {
    const completions: TaskCompletion[] = [];
    const manager = await createManager({
      maxActiveTasks: 1,
      maxRecentTasks: 1,
      maxRetainedTasks: 1,
      onFinished: (completion) => completions.push(completion),
    });
    const first = await manager.start({
      command: "printf first-output",
      cwd: process.cwd(),
      wakeOnExit: true,
    });
    await waitForTerminal(manager, first.id);
    const second = await manager.start({
      command: "printf second-output",
      cwd: process.cwd(),
      wakeOnExit: true,
    });
    await waitForTerminal(manager, second.id);

    expect(() => manager.status(first.id)).toThrow(
      "Unknown background task ID"
    );
    expect(await pathExists(first.logPath)).toBe(false);
    expect(completions[0]?.output).toContain("first-output");
    expect(completions[1]?.output).toContain("second-output");
  });

  test("prunes old task state and its log", async () => {
    const manager = await createManager({
      maxActiveTasks: 2,
      maxRecentTasks: 2,
      maxRetainedTasks: 2,
    });
    const tasks: TaskSnapshot[] = [];
    for (let index = 0; index < 3; index += 1) {
      // Sequential completion makes the pruning order deterministic.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const task = await manager.start({
        command: "true",
        cwd: process.cwd(),
        name: `Task ${String(index)}`,
      });
      tasks.push(task);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await waitForTerminal(manager, task.id);
    }

    const [oldest] = tasks;
    expect(oldest).toBeDefined();
    if (!oldest) {
      throw new Error("Missing oldest task");
    }
    expect(manager.list()).toHaveLength(2);
    expect(() => manager.status(oldest.id)).toThrow(
      "Unknown background task ID"
    );
    expect(await pathExists(oldest.logPath)).toBe(false);
  });

  test("reads committed output forward with stable UTF-8 cursors", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: "printf 'A🙂BC'",
      cwd: process.cwd(),
    });
    await waitForTerminal(manager, started.id);

    const first = await manager.logs(started.id, 2, 0);
    const second = await manager.logs(started.id, 4, first.nextByte);
    const third = await manager.logs(started.id, 2, second.nextByte);

    expect(first).toMatchObject({
      bytesRead: 1,
      droppedBytes: 0,
      nextByte: 1,
      output: "A",
      startByte: 0,
      totalBytes: 7,
      truncated: true,
    });
    expect(second).toMatchObject({
      bytesRead: 4,
      droppedBytes: 0,
      nextByte: 5,
      output: "🙂",
      startByte: 1,
      truncated: true,
    });
    expect(third).toMatchObject({
      bytesRead: 2,
      nextByte: 7,
      output: "BC",
      startByte: 5,
      truncated: false,
    });
    expect(first.output + second.output + third.output).toBe("A🙂BC");

    const split = await manager.logs(started.id, 8, 2);
    expect(split).toMatchObject({
      droppedBytes: 3,
      nextByte: 7,
      output: "BC",
      startByte: 5,
    });
    expect(split.output).not.toContain("�");

    const pastEnd = await manager.logs(started.id, 8, 100);
    expect(pastEnd).toMatchObject({
      bytesRead: 0,
      droppedBytes: 0,
      nextByte: 7,
      output: "",
      startByte: 7,
      totalBytes: 7,
      truncated: false,
    });
    expect(pastEnd.task.status).toBe("completed");
    expect(pastEnd.text).toContain("no new output");
  });

  test("returns an empty cursor result for an empty log", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: "true",
      cwd: process.cwd(),
    });
    await waitForTerminal(manager, started.id);

    const logs = await manager.logs(started.id, 8, 0);

    expect(logs).toMatchObject({
      bytesRead: 0,
      droppedBytes: 0,
      nextByte: 0,
      output: "",
      startByte: 0,
      totalBytes: 0,
      truncated: false,
    });
  });

  test("returns a valid UTF-8 tail when truncation splits a character", async () => {
    const manager = await createManager();
    const started = await manager.start({
      command: `printf '${"x".repeat(100)}🙂END'`,
      cwd: process.cwd(),
    });
    await waitForTerminal(manager, started.id);

    const splitTail = await manager.logs(started.id, 6);
    const completeTail = await manager.logs(started.id, 7);

    expect(splitTail.text).not.toContain("�");
    expect(splitTail.text).toContain("END");
    expect(completeTail.text).toContain("🙂END");

    const emojiOnly = await manager.start({
      command: "printf '🙂'",
      cwd: process.cwd(),
    });
    await waitForTerminal(manager, emojiOnly.id);
    const continuationOnly = await manager.logs(emojiOnly.id, 1);
    expect(continuationOnly.text).toContain(
      "No complete UTF-8 character in the selected log tail"
    );
    expect(continuationOnly.text).not.toContain("no output yet");
  });

  test("rejects starts after shutdown and removes its temporary directory", async () => {
    const manager = new BackgroundTaskManager();
    managers.push(manager);
    const initializePromise = manager.initialize();
    const shutdownPromise = manager.shutdown();
    const runtimeDir = await initializePromise;

    await shutdownPromise;

    expect(await pathExists(runtimeDir)).toBe(false);
    await expect(
      manager.start({ command: "true", cwd: process.cwd() })
    ).rejects.toThrow("shutting down");
  });

  test("does not recreate its runtime directory when shutdown races a start", async () => {
    const manager = new BackgroundTaskManager();
    managers.push(manager);
    const runtimeDir = await manager.initialize();

    const starting = manager.start({
      command: "sleep 30",
      cwd: process.cwd(),
    });
    const shuttingDown = manager.shutdown();

    await expect(starting).rejects.toThrow("shutting down");
    await shuttingDown;
    expect(await pathExists(runtimeDir)).toBe(false);
  });

  test("rejects ambiguous task ID prefixes", async () => {
    const manager = await createManager({
      maxActiveTasks: 20,
      maxRecentTasks: 1,
      maxRetainedTasks: 20,
    });
    const tasks = await Promise.all(
      Array.from(
        { length: 17 },
        async () =>
          await manager.start({
            command: "true",
            cwd: process.cwd(),
          })
      )
    );
    await Promise.all(
      tasks.map(async (task) => await waitForTerminal(manager, task.id))
    );
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const prefix = task.id.slice(0, 1);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const ambiguous = [...counts].find(([, count]) => count > 1)?.[0];

    expect(ambiguous).toBeString();
    expect(() => manager.status(ambiguous)).toThrow("Ambiguous task ID prefix");
  });
});

describe("task formatting", () => {
  const task: TaskSnapshot = {
    bytesWritten: 0,
    command: "true",
    cwd: "/tmp/project",
    id: "abc12345",
    logPath: "/tmp/task.log",
    name: "Build <main>",
    startedAt: 1000,
    status: "running",
    wakeOnExit: true,
  };

  test("injects active status and escapes model-controlled names", () => {
    const context = formatModelContext([task]);

    expect(context).toContain("abc12345 [running");
    expect(context).toContain("Build &lt;main&gt;");
    expect(context).toContain("automatic continuation enabled");
  });

  test("formats an empty and populated task list", () => {
    expect(formatTaskList([])).toBe("No background tasks.");
    expect(formatTaskList([task], 2000)).toContain(
      "abc12345 running 1s wake=on"
    );
  });

  test("shows a stop signal instead of a null exit code", () => {
    const stopped: TaskSnapshot = {
      ...task,
      endedAt: 2000,
      exitCode: null,
      signal: "SIGTERM",
      status: "stopped",
    };

    expect(formatTaskList([stopped], 2000)).toContain("signal=SIGTERM");
    expect(formatTaskList([stopped], 2000)).not.toContain("exit=null");
    expect(formatModelContext([stopped])).toContain("signal SIGTERM");
  });
});
