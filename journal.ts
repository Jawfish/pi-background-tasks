import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

import type {
  BackgroundTaskRecorder,
  TaskLogReadRecord,
  TaskOutputCapture,
  TaskSnapshot,
  TaskTerminalReason,
  TaskWatchOrigin,
  TaskWatchSnapshot,
} from "./core.ts";

/** Journal path, or one of DISABLED_VALUES to turn the journal off. */
export const JOURNAL_ENV = "PI_BACKGROUND_TASK_JOURNAL";
const DISABLED_VALUES = new Set(["0", "off", "false", "disabled", "none"]);
const BUSY_TIMEOUT_MS = 250;
/** A dashboard reads logs on every new chunk; keep at most one row per interval. */
export const TUI_LOG_READ_INTERVAL_MS = 1000;

/**
 * Forward-only migrations. Never edit a shipped step; append a new one.
 * PRAGMA user_version stores the number of applied steps.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE instances (
      instance_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      pi_session_id TEXT,
      pi_session_file TEXT,
      cwd TEXT,
      build_version TEXT,
      build_hash TEXT,
      runtime TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      process_id INTEGER NOT NULL
    )`,
    `CREATE TABLE tasks (
      task_key TEXT PRIMARY KEY,
      manager_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      started_by_instance TEXT,
      finished_by_instance TEXT,
      origin TEXT,
      name TEXT,
      command TEXT,
      cwd TEXT,
      completion_policy TEXT,
      timeout_seconds INTEGER,
      pid INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      status TEXT,
      terminal_reason TEXT,
      exit_code INTEGER,
      signal TEXT,
      error TEXT
    )`,
    `CREATE TABLE output_blobs (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      content BLOB NOT NULL
    )`,
    `CREATE TABLE task_outputs (
      task_key TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      capture TEXT NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER NOT NULL,
      committed_bytes INTEGER NOT NULL,
      output_limit_bytes INTEGER NOT NULL,
      output_limit_reached INTEGER NOT NULL,
      log_error TEXT,
      file_error TEXT
    )`,
    `CREATE TABLE actions (
      action_id INTEGER PRIMARY KEY,
      instance_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      source TEXT NOT NULL,
      action TEXT,
      tool_call_id TEXT,
      arguments TEXT,
      is_error INTEGER NOT NULL,
      outcome TEXT,
      task_key TEXT,
      watch_key TEXT
    )`,
    "CREATE INDEX actions_task ON actions (task_key)",
    "CREATE INDEX actions_tool_call ON actions (tool_call_id)",
    `CREATE TABLE log_reads (
      read_id INTEGER PRIMARY KEY,
      instance_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      caller TEXT NOT NULL,
      tool_call_id TEXT,
      task_query TEXT NOT NULL,
      task_key TEXT,
      requested_after_byte INTEGER,
      requested_max_bytes INTEGER,
      start_byte INTEGER,
      next_byte INTEGER,
      bytes_read INTEGER,
      total_bytes INTEGER,
      truncated INTEGER,
      dropped_bytes INTEGER,
      coalesced_reads INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )`,
    "CREATE INDEX log_reads_task ON log_reads (task_key)",
    `CREATE TABLE watches (
      watch_key TEXT PRIMARY KEY,
      manager_id TEXT NOT NULL,
      watch_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      registered_by_instance TEXT NOT NULL,
      ended_by_instance TEXT,
      origin TEXT NOT NULL,
      condition TEXT NOT NULL,
      wake INTEGER NOT NULL,
      pattern TEXT,
      inactivity_seconds INTEGER,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      ended_at INTEGER,
      matched_output TEXT,
      start_byte INTEGER,
      next_byte INTEGER
    )`,
    "CREATE INDEX watches_task ON watches (task_key)",
    `CREATE TABLE deliveries (
      delivery_key TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      task_key TEXT NOT NULL,
      watch_key TEXT,
      decided_at INTEGER NOT NULL,
      notify TEXT NOT NULL,
      wake_requested INTEGER NOT NULL
    )`,
    `CREATE TABLE delivery_events (
      event_id INTEGER PRIMARY KEY,
      delivery_key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      batch_id TEXT,
      via TEXT,
      error TEXT
    )`,
    "CREATE INDEX delivery_events_delivery ON delivery_events (delivery_key)",
    `CREATE VIEW task_outcomes AS
      SELECT t.*,
        CASE WHEN t.ended_at IS NULL THEN 'incomplete' ELSE 'observed' END
          AS observation,
        t.ended_at - t.started_at AS duration_ms
      FROM tasks t`,
  ],
];

export const JOURNAL_SCHEMA_VERSION = MIGRATIONS.length;

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlInput = SqlValue | boolean | undefined;

interface SqlStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): unknown;
}

interface SqlDatabase {
  close(): void;
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

export type JournalDriver = "bun" | "node";

const require = createRequire(import.meta.url);

const openDatabase = function openDatabase(
  file: string,
  driver: JournalDriver
): SqlDatabase {
  if (driver === "bun") {
    const { Database } = require("bun:sqlite") as {
      Database: new (file: string, options: { create: boolean }) => SqlDatabase;
    };
    return new Database(file, { create: true });
  }
  // Node 22 warns that SQLite is experimental; that noise must not reach Pi's UI.
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(
    this: NodeJS.Process,
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (file: string) => SqlDatabase;
    };
    return new DatabaseSync(file);
  } finally {
    process.emitWarning = emitWarning;
  }
};

const toSql = function toSql(value: SqlInput): SqlValue {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
};

const errorText = function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
};

export const taskKey = function taskKey(
  managerId: string,
  taskId: string
): string {
  return `${managerId}/${taskId}`;
};

export const watchKey = taskKey;

/** Resolve the journal file, or undefined when the journal is disabled. */
export const resolveJournalPath = function resolveJournalPath(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configured = env[JOURNAL_ENV]?.trim();
  if (configured && DISABLED_VALUES.has(configured.toLowerCase())) {
    return undefined;
  }
  if (configured) {
    return path.resolve(configured);
  }
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "pi-background-tasks", "journal.sqlite");
};

let cachedBuild: { hash?: string; version?: string } | undefined;

const buildIdentity = function buildIdentity(): {
  hash?: string;
  version?: string;
} {
  if (cachedBuild) {
    return cachedBuild;
  }
  const hash = createHash("sha256");
  let hasSource = false;
  for (const file of ["core.ts", "index.ts", "journal.ts", "service.ts", "tui.ts"]) {
    try {
      hash.update(readFileSync(new URL(`./${file}`, import.meta.url)));
      hasSource = true;
    } catch {
      // A missing source file only weakens the build fingerprint.
    }
  }
  let version: string | undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8")
    ) as { version?: unknown };
    version = typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    // The version is optional identity.
  }
  cachedBuild = {
    hash: hasSource ? hash.digest("hex").slice(0, 16) : undefined,
    version,
  };
  return cachedBuild;
};

export interface JournalIdentity {
  cwd?: string;
  piSessionFile?: string;
  piSessionId?: string;
}

export interface JournalActionRecord {
  action?: string;
  arguments?: unknown;
  at?: number;
  isError: boolean;
  managerId?: string;
  outcome?: string;
  source: "tool" | "service" | "tui";
  taskId?: string;
  toolCallId?: string;
  watchId?: string;
}

export type DeliveryNotifyResult =
  | "shown"
  | "failed"
  | "silent"
  | "no-ui"
  | "suppressed";

export interface JournalDeliveryDecision {
  deliveryKey: string;
  kind: "completion" | "watch";
  managerId: string;
  notify: DeliveryNotifyResult;
  taskId: string;
  wakeRequested: boolean;
  watchId?: string;
}

export type DeliveryEventName =
  | "enqueue-attempted"
  | "enqueued"
  | "enqueue-failed"
  | "fallback-injected"
  | "observed";

export interface JournalDeliveryEvent {
  batchId?: string;
  deliveryKey: string;
  error?: string;
  event: DeliveryEventName;
  via?: string;
}

export interface OpenJournalOptions {
  driver?: JournalDriver;
  identity?: JournalIdentity;
  /** Journal file. Undefined disables the journal. */
  path: string | undefined;
}

/**
 * Append-only SQLite history of background tasks. Every write is best effort:
 * a journal error is logged once and never reaches a task or tool result.
 */
export class TaskJournal {
  readonly instanceId = randomUUID();
  readonly path: string | undefined;
  #db: SqlDatabase | undefined;
  #error: string | undefined;
  #hasReportedWriteError = false;
  readonly #tuiReads = new Map<string, { at: number; skipped: number }>();

  private constructor(filePath: string | undefined) {
    this.path = filePath;
  }

  /** Open a journal. Open failures produce a disabled journal with an error. */
  static open(options: OpenJournalOptions): TaskJournal {
    const journal = new TaskJournal(options.path);
    if (options.path === undefined) {
      return journal;
    }
    try {
      journal.#db = TaskJournal.#connect(
        options.path,
        options.driver ?? (process.versions.bun ? "bun" : "node")
      );
      journal.#insertInstance(options.identity ?? {});
    } catch (error) {
      try {
        journal.#db?.close();
      } catch {
        // The open error below is the useful failure.
      }
      journal.#db = undefined;
      journal.#error = `Could not open task journal ${options.path}: ${errorText(error)}`;
      console.error(`[background-tasks] ${journal.#error}`);
    }
    return journal;
  }

  static disabled(): TaskJournal {
    return new TaskJournal(undefined);
  }

  get isEnabled(): boolean {
    return this.#db !== undefined;
  }

  /** Open or write failure, if any. */
  get error(): string | undefined {
    return this.#error;
  }

  close(): void {
    const db = this.#db;
    this.#db = undefined;
    try {
      db?.close();
    } catch {
      // Closing is best effort.
    }
  }

  static #connect(file: string, driver: JournalDriver): SqlDatabase {
    mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    const db = openDatabase(file, driver);
    try {
      chmodSync(file, 0o600);
      db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      TaskJournal.#migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  static #migrate(db: SqlDatabase): void {
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version?: number })
        .user_version ?? 0
    );
    if (version > MIGRATIONS.length) {
      throw new Error(
        `journal schema ${String(version)} is newer than supported schema ${String(MIGRATIONS.length)}`
      );
    }
    if (version === MIGRATIONS.length) {
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have migrated while this one waited for the lock.
      const current = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number })
          .user_version ?? 0
      );
      for (const [index, statements] of MIGRATIONS.entries()) {
        if (index < current) {
          continue;
        }
        for (const statement of statements) {
          db.exec(statement);
        }
      }
      db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  #insertInstance(identity: JournalIdentity): void {
    const build = buildIdentity();
    this.#run(
      `INSERT INTO instances (instance_id, started_at, pi_session_id, pi_session_file,
        cwd, build_version, build_hash, runtime, runtime_version, process_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.instanceId,
      Date.now(),
      identity.piSessionId,
      identity.piSessionFile,
      identity.cwd,
      build.version,
      build.hash,
      process.versions.bun ? "bun" : "node",
      process.versions.bun ?? process.versions.node,
      process.pid
    );
  }

  #run(sql: string, ...params: SqlInput[]): void {
    const db = this.#db;
    if (!db) {
      return;
    }
    db.prepare(sql).run(...params.map(toSql));
  }

  /** Run one best-effort write; failures are reported once and swallowed. */
  #write(write: () => void): void {
    if (!this.#db) {
      return;
    }
    try {
      write();
    } catch (error) {
      this.#error = `Task journal write failed: ${errorText(error)}`;
      if (!this.#hasReportedWriteError) {
        this.#hasReportedWriteError = true;
        console.error(`[background-tasks] ${this.#error}`);
      }
    }
  }

  #transaction(write: () => void): void {
    const db = this.#db;
    if (!db) {
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Recorder that journals one manager's task history. */
  recorder(managerId: string): BackgroundTaskRecorder {
    return {
      logRead: (read) => {
        this.#write(() => this.#logRead(managerId, read));
      },
      outputFinalized: (capture) => {
        this.#write(() => this.#outputFinalized(managerId, capture));
      },
      taskFinished: (task, reason) => {
        this.#write(() => this.#taskFinished(managerId, task, reason));
      },
      taskStarted: (task, origin) => {
        this.#write(() => this.#taskStarted(managerId, task, origin));
      },
      watchEnded: (watch) => {
        this.#write(() => this.#watchEnded(managerId, watch));
      },
      watchRegistered: (watch, origin) => {
        this.#write(() => this.#watchRegistered(managerId, watch, origin));
      },
    };
  }

  #taskStarted(
    managerId: string,
    task: TaskSnapshot,
    origin: string | undefined
  ): void {
    this.#run(
      `INSERT INTO tasks (task_key, manager_id, task_id, started_by_instance, origin,
        name, command, cwd, completion_policy, timeout_seconds, pid, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_key) DO UPDATE SET
        started_by_instance = excluded.started_by_instance,
        origin = excluded.origin, name = excluded.name,
        command = excluded.command, cwd = excluded.cwd,
        completion_policy = excluded.completion_policy,
        timeout_seconds = excluded.timeout_seconds, pid = excluded.pid,
        started_at = excluded.started_at`,
      taskKey(managerId, task.id),
      managerId,
      task.id,
      this.instanceId,
      origin,
      task.name,
      task.command,
      task.cwd,
      task.completionPolicy,
      task.timeoutSeconds,
      task.pid,
      task.startedAt
    );
  }

  #taskFinished(
    managerId: string,
    task: TaskSnapshot,
    reason: TaskTerminalReason
  ): void {
    // Upsert so a finish is kept even if its start row was never written.
    this.#run(
      `INSERT INTO tasks (task_key, manager_id, task_id, finished_by_instance, name,
        command, cwd, completion_policy, timeout_seconds, pid, started_at, ended_at,
        status, terminal_reason, exit_code, signal, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_key) DO UPDATE SET
        finished_by_instance = excluded.finished_by_instance,
        ended_at = excluded.ended_at, status = excluded.status,
        terminal_reason = excluded.terminal_reason,
        exit_code = excluded.exit_code, signal = excluded.signal,
        error = excluded.error`,
      taskKey(managerId, task.id),
      managerId,
      task.id,
      this.instanceId,
      task.name,
      task.command,
      task.cwd,
      task.completionPolicy,
      task.timeoutSeconds,
      task.pid,
      task.startedAt,
      task.endedAt,
      task.status,
      reason,
      task.exitCode,
      task.signal,
      task.error
    );
  }

  #outputFinalized(managerId: string, capture: TaskOutputCapture): void {
    let content: Buffer | undefined;
    let fileError: string | undefined;
    try {
      const data = readFileSync(capture.logPath);
      // Bytes past the committed count were never acknowledged by the writer.
      content = data.subarray(0, capture.committedBytes);
      if (data.length < capture.committedBytes) {
        fileError = `Log holds ${String(data.length)} of ${String(capture.committedBytes)} committed bytes`;
      }
    } catch (error) {
      fileError = errorText(error);
    }
    let state = "complete";
    if (content === undefined) {
      state = "missing";
    } else if (fileError || capture.logError) {
      state = "partial";
    }
    const sha256 = content
      ? createHash("sha256").update(content).digest("hex")
      : undefined;
    this.#transaction(() => {
      if (content && sha256) {
        this.#run(
          "INSERT OR IGNORE INTO output_blobs (sha256, size_bytes, content) VALUES (?, ?, ?)",
          sha256,
          content.length,
          content
        );
      }
      this.#run(
        `INSERT OR REPLACE INTO task_outputs (task_key, instance_id, recorded_at, capture,
          sha256, size_bytes, committed_bytes, output_limit_bytes, output_limit_reached,
          log_error, file_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskKey(managerId, capture.taskId),
        this.instanceId,
        Date.now(),
        state,
        sha256,
        content?.length ?? 0,
        capture.committedBytes,
        capture.outputLimitBytes,
        capture.isOutputLimitReached,
        capture.logError,
        fileError
      );
    });
  }

  #logRead(managerId: string, read: TaskLogReadRecord): void {
    let coalesced = 0;
    if (read.caller === "tui" && !read.error) {
      const key = read.taskId ?? read.query;
      const previous = this.#tuiReads.get(key);
      if (previous && read.at - previous.at < TUI_LOG_READ_INTERVAL_MS) {
        previous.skipped += 1;
        return;
      }
      coalesced = previous?.skipped ?? 0;
      this.#tuiReads.set(key, { at: read.at, skipped: 0 });
    }
    this.#run(
      `INSERT INTO log_reads (instance_id, at, caller, tool_call_id, task_query, task_key,
        requested_after_byte, requested_max_bytes, start_byte, next_byte, bytes_read,
        total_bytes, truncated, dropped_bytes, coalesced_reads, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.instanceId,
      read.at,
      read.caller,
      read.callId,
      read.query,
      read.taskId === undefined ? undefined : taskKey(managerId, read.taskId),
      read.requestedAfterByte,
      read.requestedMaxBytes,
      read.startByte,
      read.nextByte,
      read.bytesRead,
      read.totalBytes,
      read.truncated,
      read.droppedBytes,
      coalesced,
      read.error
    );
  }

  #watchRegistered(
    managerId: string,
    watch: TaskWatchSnapshot,
    origin: TaskWatchOrigin
  ): void {
    this.#run(
      `INSERT OR IGNORE INTO watches (watch_key, manager_id, watch_id, task_key,
        registered_by_instance, origin, condition, wake, pattern, inactivity_seconds,
        created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      watchKey(managerId, watch.id),
      managerId,
      watch.id,
      taskKey(managerId, watch.taskId),
      this.instanceId,
      origin,
      watch.condition,
      watch.wake,
      watch.pattern,
      watch.inactivitySeconds,
      watch.createdAt,
      watch.status
    );
  }

  #watchEnded(managerId: string, watch: TaskWatchSnapshot): void {
    // The status guard records exactly one end per watch.
    this.#run(
      `UPDATE watches SET status = ?, ended_at = ?, ended_by_instance = ?,
        matched_output = ?, start_byte = ?, next_byte = ?
       WHERE watch_key = ? AND status = 'active'`,
      watch.status,
      watch.endedAt,
      this.instanceId,
      watch.matchedOutput,
      watch.startByte,
      watch.nextByte,
      watchKey(managerId, watch.id)
    );
  }

  action(record: JournalActionRecord): void {
    this.#write(() => {
      const hasManager = record.managerId !== undefined;
      this.#run(
        `INSERT INTO actions (instance_id, at, source, action, tool_call_id, arguments,
          is_error, outcome, task_key, watch_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.instanceId,
        record.at ?? Date.now(),
        record.source,
        record.action,
        record.toolCallId,
        record.arguments === undefined ? undefined : JSON.stringify(record.arguments),
        record.isError,
        record.outcome,
        hasManager && record.taskId
          ? taskKey(record.managerId!, record.taskId)
          : undefined,
        hasManager && record.watchId
          ? watchKey(record.managerId!, record.watchId)
          : undefined
      );
    });
  }

  deliveryDecided(decision: JournalDeliveryDecision): void {
    this.#write(() => {
      this.#run(
        `INSERT OR IGNORE INTO deliveries (delivery_key, instance_id, kind, task_key,
          watch_key, decided_at, notify, wake_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        decision.deliveryKey,
        this.instanceId,
        decision.kind,
        taskKey(decision.managerId, decision.taskId),
        decision.watchId === undefined
          ? undefined
          : watchKey(decision.managerId, decision.watchId),
        Date.now(),
        decision.notify,
        decision.wakeRequested
      );
    });
  }

  deliveryEvent(event: JournalDeliveryEvent): void {
    this.#write(() => {
      this.#run(
        `INSERT INTO delivery_events (delivery_key, instance_id, at, event, batch_id, via, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.deliveryKey,
        this.instanceId,
        Date.now(),
        event.event,
        event.batchId,
        event.via,
        event.error
      );
    });
  }
}
