import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BackgroundTaskManager } from "./core.ts";
import type { BackgroundTaskManagerOptions } from "./core.ts";
import {
  JOURNAL_ENV,
  JOURNAL_SCHEMA_VERSION,
  resolveJournalPath,
  TaskJournal,
  taskKey,
} from "./journal.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await cleanup();
  }
});

const setup = async function setup(
  options: BackgroundTaskManagerOptions = {}
) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-journal-test-"));
  const file = path.join(dir, "state", "journal.sqlite");
  const journal = TaskJournal.open({
    identity: { cwd: dir, piSessionFile: "/s.jsonl", piSessionId: "session-1" },
    path: file,
  });
  const manager = new BackgroundTaskManager({
    killGraceMs: 100,
    runtimeDir: path.join(dir, "logs"),
    ...options,
  });
  manager.setRecorder(journal.recorder(manager.id));
  cleanups.push(async () => {
    await manager.shutdown();
    journal.close();
    await rm(dir, { force: true, recursive: true });
  });
  const query = <T>(sql: string, ...params: (string | number)[]): T[] => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  const start = (command: string, extra: Record<string, unknown> = {}) =>
    manager.start({ command, cwd: dir, origin: "tool", ...extra });
  return { dir, file, journal, manager, query, start };
};

type TaskRow = {
  command: string;
  error: string | null;
  exit_code: number | null;
  finished_by_instance: string | null;
  observation: string;
  origin: string | null;
  signal: string | null;
  started_by_instance: string | null;
  status: string | null;
  terminal_reason: string | null;
  timeout_seconds: number | null;
};

type OutputRow = {
  capture: string;
  committed_bytes: number;
  content: Uint8Array | null;
  file_error: string | null;
  log_error: string | null;
  output_limit_bytes: number;
  output_limit_reached: number;
  size_bytes: number;
};

const outputSql = `SELECT o.*, b.content FROM task_outputs o
  LEFT JOIN output_blobs b USING (sha256) WHERE task_key = ?`;

describe("task journal", () => {
  test("records a normal exit with instance identity and full output", async () => {
    const { journal, manager, query, start } = await setup();
    const task = await start("printf hello; sleep 0.1; printf ' world' >&2", {
      timeoutSeconds: 30,
    });
    await manager.wait(task.id);

    const [row] = query<TaskRow>(
      "SELECT * FROM task_outcomes WHERE task_key = ?",
      taskKey(manager.id, task.id)
    );
    expect(row).toMatchObject({
      command: "printf hello; sleep 0.1; printf ' world' >&2",
      exit_code: 0,
      finished_by_instance: journal.instanceId,
      observation: "observed",
      origin: "tool",
      started_by_instance: journal.instanceId,
      status: "completed",
      terminal_reason: "exit",
      timeout_seconds: 30,
    });
    const [instance] = query<Record<string, unknown>>(
      "SELECT * FROM instances"
    );
    expect(instance).toMatchObject({
      instance_id: journal.instanceId,
      pi_session_file: "/s.jsonl",
      pi_session_id: "session-1",
      runtime: "bun",
    });
    expect(instance?.build_hash).toBeString();
    const [output] = query<OutputRow>(outputSql, taskKey(manager.id, task.id));
    expect(output?.capture).toBe("complete");
    expect(Buffer.from(output!.content!).toString()).toBe("hello world");
  });

  test("records timeout and manual stop as distinct terminal reasons", async () => {
    const { manager, query, start } = await setup();
    const timed = await start("sleep 30", { timeoutSeconds: 1 });
    const stopped = await start("sleep 30");
    manager.stop(stopped.id);
    await Promise.all([manager.wait(timed.id), manager.wait(stopped.id)]);

    const rows = query<TaskRow & { task_id: string }>(
      "SELECT * FROM tasks ORDER BY started_at"
    );
    expect(rows.find((row) => row.task_id === timed.id)).toMatchObject({
      error: "Timed out after 1s",
      status: "failed",
      terminal_reason: "timeout",
    });
    expect(rows.find((row) => row.task_id === stopped.id)).toMatchObject({
      status: "stopped",
      terminal_reason: "user",
    });
  });

  test("keeps output of tasks pruned right after they finish", async () => {
    const { manager, query, start } = await setup({
      maxRecentTasks: 1,
      maxRetainedTasks: 1,
    });
    const tasks = await Promise.all(
      ["one", "two", "three"].map((word) => start(`printf ${word}`))
    );
    await Promise.all(tasks.map((task) => manager.wait(task.id)));
    await Bun.sleep(50);
    expect(manager.list()).toHaveLength(1);

    for (const [index, word] of ["one", "two", "three"].entries()) {
      const [output] = query<OutputRow>(
        outputSql,
        taskKey(manager.id, tasks[index]!.id)
      );
      expect(Buffer.from(output!.content!).toString()).toBe(word);
    }
  });

  test("records the output limit separately from the captured bytes", async () => {
    const { manager, query, start } = await setup({ maxOutputBytes: 8 });
    const task = await start("printf 0123456789abcdef; sleep 5");
    await manager.wait(task.id);

    const [row] = query<TaskRow>(
      "SELECT * FROM tasks WHERE task_key = ?",
      taskKey(manager.id, task.id)
    );
    expect(row?.terminal_reason).toBe("output_limit");
    const [output] = query<OutputRow>(outputSql, taskKey(manager.id, task.id));
    expect(output).toMatchObject({
      capture: "complete",
      output_limit_bytes: 8,
      output_limit_reached: 1,
    });
    expect(Buffer.from(output!.content!).toString()).toStartWith("01234567");
    expect(output?.size_bytes).toBe(output!.committed_bytes);
  });

  test("preserves output before shutdown removes the log directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-journal-test-"));
    const file = path.join(dir, "journal.sqlite");
    const journal = TaskJournal.open({ path: file });
    const manager = new BackgroundTaskManager({ killGraceMs: 100 });
    manager.setRecorder(journal.recorder(manager.id));
    const task = await manager.start({
      command: "printf before-shutdown; sleep 30",
      cwd: dir,
    });
    await Bun.sleep(100);
    await manager.shutdown();
    journal.close();

    const db = new Database(file, { readonly: true });
    const row = db
      .prepare(`SELECT t.terminal_reason, t.status, b.content FROM tasks t
        JOIN task_outputs o USING (task_key) JOIN output_blobs b USING (sha256)`)
      .get() as { content: Uint8Array; status: string; terminal_reason: string };
    db.close();
    await rm(dir, { force: true, recursive: true });
    expect(task.logPath.startsWith(tmpdir())).toBe(true);
    expect(row.terminal_reason).toBe("shutdown");
    expect(row.status).toBe("stopped");
    expect(Buffer.from(row.content).toString()).toBe("before-shutdown");
  });

  test("marks capture partial after a log write failure", async () => {
    let writes = 0;
    const { manager, query, start } = await setup({
      writeLogChunk: (stream, data, callback) => {
        writes += 1;
        if (writes > 1) {
          callback(new Error("disk full"));
          return true;
        }
        return stream.write(data, callback);
      },
    });
    const task = await start("printf first; sleep 0.1; printf second; sleep 5");
    await manager.wait(task.id);

    const [output] = query<OutputRow>(outputSql, taskKey(manager.id, task.id));
    expect(output?.capture).toBe("partial");
    expect(output?.log_error).toContain("disk full");
    expect(Buffer.from(output!.content!).toString()).toBe("first");
  });

  test("marks capture missing when the log file cannot be read", async () => {
    const { manager, query, start } = await setup();
    const task = await start("printf gone; sleep 0.2");
    await Bun.sleep(50);
    rmSync(task.logPath);
    await manager.wait(task.id);

    const [output] = query<OutputRow>(outputSql, taskKey(manager.id, task.id));
    expect(output).toMatchObject({ capture: "missing", size_bytes: 0 });
    expect(output?.file_error).toContain("ENOENT");
    const [row] = query<TaskRow>("SELECT * FROM tasks");
    expect(row?.status).toBe("completed");
  });

  test("reports a start without a finish as incomplete observation", async () => {
    const { manager, query, start } = await setup();
    const task = await start("sleep 30");
    // Simulate a crash: the recorder disappears before the task ends.
    manager.setRecorder(undefined);
    manager.stop(task.id);
    await manager.wait(task.id);

    const [row] = query<TaskRow>("SELECT * FROM task_outcomes");
    expect(row).toMatchObject({ observation: "incomplete", status: null });
  });

  test("keeps task identity when a new instance records the finish", async () => {
    const { file, journal, manager, query, start } = await setup();
    const task = await start("sleep 0.2");
    const successor = TaskJournal.open({ path: file });
    manager.setRecorder(successor.recorder(manager.id));
    journal.close();
    await manager.wait(task.id);
    successor.close();

    const rows = query<TaskRow>("SELECT * FROM tasks");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      finished_by_instance: successor.instanceId,
      started_by_instance: journal.instanceId,
      status: "completed",
    });
  });

  test("journal write failures do not change task results", async () => {
    const { file, journal, manager, start } = await setup();
    const db = new Database(file);
    db.exec("DROP VIEW task_outcomes");
    db.exec("DROP TABLE tasks");
    db.close();
    const originalError = console.error;
    console.error = () => {};
    try {
      const task = await start("printf still-works");
      const finished = await manager.wait(task.id);
      expect(finished.status).toBe("completed");
      const logs = await manager.logs(task.id);
      expect(logs.output).toBe("still-works");
    } finally {
      console.error = originalError;
    }
    expect(journal.error).toContain("no such table");
  });

  test("an unusable journal path disables the journal without failing tasks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-journal-test-"));
    const originalError = console.error;
    console.error = () => {};
    const journal = TaskJournal.open({ path: dir });
    console.error = originalError;
    expect(journal.isEnabled).toBe(false);
    expect(journal.error).toContain("Could not open task journal");
    const manager = new BackgroundTaskManager({ runtimeDir: path.join(dir, "l") });
    manager.setRecorder(journal.recorder(manager.id));
    const task = await manager.start({ command: "true", cwd: dir });
    expect((await manager.wait(task.id)).status).toBe("completed");
    await manager.shutdown();
    await rm(dir, { force: true, recursive: true });
  });

  test("migrates forward only and refuses a newer schema", async () => {
    const { file, journal } = await setup();
    journal.close();
    const reopened = TaskJournal.open({ path: file });
    expect(reopened.isEnabled).toBe(true);
    reopened.close();

    const db = new Database(file);
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version
    ).toBe(JOURNAL_SCHEMA_VERSION);
    expect(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode
    ).toBe("wal");
    db.exec(`PRAGMA user_version = ${String(JOURNAL_SCHEMA_VERSION + 1)}`);
    db.close();
    const originalError = console.error;
    console.error = () => {};
    const newer = TaskJournal.open({ path: file });
    console.error = originalError;
    expect(newer.isEnabled).toBe(false);
    expect(newer.error).toContain("newer than supported");
  });

  test("resolves the journal path and the disabled option", () => {
    expect(resolveJournalPath({ [JOURNAL_ENV]: "off" })).toBeUndefined();
    expect(resolveJournalPath({ [JOURNAL_ENV]: "0" })).toBeUndefined();
    expect(resolveJournalPath({ [JOURNAL_ENV]: "/x/j.sqlite" })).toBe(
      "/x/j.sqlite"
    );
    expect(resolveJournalPath({ XDG_STATE_HOME: "/state" })).toBe(
      "/state/pi-background-tasks/journal.sqlite"
    );
  });
});

type LogReadRow = {
  bytes_read: number | null;
  caller: string;
  coalesced_reads: number;
  error: string | null;
  next_byte: number | null;
  requested_after_byte: number | null;
  start_byte: number | null;
  task_key: string | null;
  tool_call_id: string | null;
  truncated: number | null;
};

describe("log read journal", () => {
  test("records forward reads, tail reads, invalid cursors, and invalid IDs", async () => {
    const { manager, query, start } = await setup();
    const task = await start("printf 0123456789");
    await manager.wait(task.id);

    await manager.logs(task.id, 4, 0, { callId: "call-1", caller: "tool" });
    await manager.logs(task.id, 4, 4, { callId: "call-2", caller: "tool" });
    await manager.logs(task.id, 3, undefined, { caller: "service" });
    await manager.logs(task.id, 4, 999, { caller: "tool" });
    await expect(
      manager.logs("zzzz", 4, 0, { callId: "call-3", caller: "tool" })
    ).rejects.toThrow("Unknown background task ID");

    const rows = query<LogReadRow>(
      "SELECT * FROM log_reads WHERE caller != 'completion' ORDER BY read_id"
    );
    const key = taskKey(manager.id, task.id);
    expect(rows).toEqual([
      expect.objectContaining({
        bytes_read: 4,
        next_byte: 4,
        requested_after_byte: 0,
        start_byte: 0,
        task_key: key,
        tool_call_id: "call-1",
        truncated: 1,
      }),
      expect.objectContaining({ next_byte: 8, start_byte: 4, task_key: key }),
      expect.objectContaining({
        caller: "service",
        next_byte: 10,
        requested_after_byte: null,
        start_byte: 7,
      }),
      expect.objectContaining({
        bytes_read: 0,
        next_byte: 10,
        requested_after_byte: 999,
        start_byte: 10,
      }),
      expect.objectContaining({
        error: "Unknown background task ID: zzzz",
        task_key: null,
        tool_call_id: "call-3",
      }),
    ]);
  });

  test("coalesces rapid dashboard reads", async () => {
    const { manager, query, start } = await setup();
    const task = await start("printf x");
    await manager.wait(task.id);
    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await manager.logs(task.id, 10, undefined, { caller: "tui" });
    }
    const rows = query<LogReadRow>(
      "SELECT * FROM log_reads WHERE caller = 'tui'"
    );
    expect(rows).toHaveLength(1);
  });
});

type WatchRow = {
  condition: string;
  ended_at: number | null;
  inactivity_seconds: number | null;
  matched_output: string | null;
  next_byte: number | null;
  origin: string;
  pattern: string | null;
  start_byte: number | null;
  status: string;
  task_key: string;
  wake: number;
  watch_id: string;
};

describe("watch journal", () => {
  test("records an immediate initial output watch with its match", async () => {
    const { manager, query, start } = await setup();
    const task = await start("printf ready", {
      watch: { condition: "output", pattern: "ready", wake: true },
    });
    await manager.wait(task.id);

    expect(query<WatchRow>("SELECT * FROM watches")).toEqual([
      expect.objectContaining({
        condition: "output",
        matched_output: "ready",
        next_byte: 5,
        origin: "start",
        pattern: "ready",
        start_byte: 0,
        status: "fired",
        task_key: taskKey(manager.id, task.id),
        wake: 1,
      }),
    ]);
  });

  test("records output split across chunks, inactivity, exit, and cancellation", async () => {
    const { manager, query, start } = await setup();
    const task = await start("printf abc-rea; sleep 0.3; printf dy-xyz; sleep 1.6");
    const output = manager.watch(task.id, { condition: "output", pattern: "ready" });
    const quiet = manager.watch(task.id, {
      condition: "inactivity",
      inactivitySeconds: 1,
    });
    const exit = manager.watch(task.id, { condition: "exit" });
    const cancelled = manager.watch(task.id, { condition: "output", pattern: "never" });
    manager.unwatch(cancelled.id);
    expect(() => manager.unwatch(cancelled.id)).toThrow("already cancelled");
    await manager.wait(task.id);

    const rows = new Map(
      query<WatchRow>("SELECT * FROM watches").map((row) => [row.watch_id, row])
    );
    expect(rows.get(output.id)).toMatchObject({
      matched_output: "ready",
      next_byte: 9,
      origin: "watch",
      start_byte: 4,
      status: "fired",
    });
    expect(rows.get(quiet.id)).toMatchObject({
      inactivity_seconds: 1,
      status: "fired",
    });
    expect(rows.get(exit.id)).toMatchObject({ status: "fired" });
    expect(rows.get(cancelled.id)?.status).toBe("cancelled");
  });

  test("records watch expiry on shutdown once", async () => {
    const { journal, manager, query, start } = await setup();
    const task = await start("sleep 30");
    manager.watch(task.id, { condition: "output", pattern: "never" });
    await manager.shutdown();
    journal.close();
    const [row] = query<WatchRow>("SELECT * FROM watches");
    expect(row?.status).toBe("expired");
    expect(row?.ended_at).toBeNumber();
  });
});

describe("node runtime", () => {
  test("writes the journal through node:sqlite", async () => {
    const node = Bun.which("node");
    if (!node) {
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "pi-journal-node-"));
    cleanups.push(() => rm(dir, { force: true, recursive: true }));
    const file = path.join(dir, "journal.sqlite");
    const script = `
      import { BackgroundTaskManager } from ${JSON.stringify(path.resolve("core.ts"))};
      import { TaskJournal } from ${JSON.stringify(path.resolve("journal.ts"))};
      const journal = TaskJournal.open({ path: ${JSON.stringify(file)} });
      if (!journal.isEnabled) throw new Error(journal.error);
      const manager = new BackgroundTaskManager();
      manager.setRecorder(journal.recorder(manager.id));
      const task = await manager.start({ command: "printf node-ok", cwd: ${JSON.stringify(dir)} });
      await manager.wait(task.id);
      await manager.shutdown();
      journal.close();
    `;
    const child = Bun.spawn(
      [node, "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", script],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const db = new Database(file, { readonly: true });
    const row = db
      .prepare(`SELECT i.runtime, t.status, b.content FROM tasks t
        JOIN instances i ON i.instance_id = t.started_by_instance
        JOIN task_outputs USING (task_key) JOIN output_blobs b USING (sha256)`)
      .get() as { content: Uint8Array; runtime: string; status: string };
    db.close();
    expect(row.runtime).toBe("node");
    expect(row.status).toBe("completed");
    expect(Buffer.from(row.content).toString()).toBe("node-ok");
  }, 20_000);
});

describe("busy database", () => {
  const openBusyJournal = async function openBusyJournal() {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-journal-busy-"));
    const file = path.join(dir, "journal.sqlite");
    const journal = TaskJournal.open({ backoffMs: 1, path: file });
    cleanups.push(async () => {
      journal.close();
      await rm(dir, { force: true, recursive: true });
    });
    const query = <T>(sql: string): T[] => {
      const db = new Database(file, { readonly: true });
      try {
        return db.prepare(sql).all() as T[];
      } finally {
        db.close();
      }
    };
    return { file, journal, query };
  };

  test("keeps writes in order and commits them once the lock clears", async () => {
    const { file, journal, query } = await openBusyJournal();
    const blocker = new Database(file);
    blocker.exec("BEGIN IMMEDIATE");
    journal.action({ action: "first", isError: false, source: "tool" });
    journal.action({ action: "second", isError: false, source: "tool" });
    blocker.exec("ROLLBACK");
    blocker.close();
    await journal.flush();

    expect(
      query<{ action: string }>("SELECT action FROM actions ORDER BY action_id")
    ).toEqual([{ action: "first" }, { action: "second" }]);
    expect(journal.isEnabled).toBe(true);
  });

  test("records a write that stayed busy as a dropped record on the next write", async () => {
    const { file, journal, query } = await openBusyJournal();
    const blocker = new Database(file);
    blocker.exec("BEGIN IMMEDIATE");
    journal.action({ action: "lost", isError: false, source: "tool" });
    await journal.flush();
    blocker.exec("ROLLBACK");
    blocker.close();
    journal.action({ action: "kept", isError: false, source: "tool" });
    await journal.flush();

    expect(query<{ action: string }>("SELECT action FROM actions")).toEqual([
      { action: "kept" },
    ]);
    expect(
      query<{ location: string; reason: string }>(
        "SELECT location, reason FROM journal_errors"
      )
    ).toEqual([{ location: "action", reason: "busy_dropped" }]);
  }, 20_000);

  test("a failed write disables the journal and records why", async () => {
    const { file, journal, query } = await openBusyJournal();
    const db = new Database(file);
    db.exec("DROP TABLE actions");
    db.close();
    const originalError = console.error;
    console.error = () => {};
    try {
      journal.action({ action: "x", isError: false, source: "tool" });
    } finally {
      console.error = originalError;
    }

    expect(journal.isEnabled).toBe(false);
    const [instance] = query<{ disabled_reason: string | null }>(
      "SELECT disabled_reason FROM instances"
    );
    expect(instance?.disabled_reason).toContain("no such table");
  });
});
