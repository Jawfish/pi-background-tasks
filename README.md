# Background tasks for Pi

Run session-owned POSIX shell commands without blocking Pi. The extension gives
the model task status before each model call. It can notify or continue the
model when work finishes.

## Install the extension

Install the extension from Git for your Pi user:

```sh
pi install git:github.com/Jawfish/pi-background-tasks
```

Append `@<commit-or-tag>` to pin a revision. Try it for one Pi run without
changing your settings:

```sh
pi -e git:github.com/Jawfish/pi-background-tasks
```

Update unpinned Git-installed extensions or remove this one with Pi's package
commands:

```sh
pi update --extensions
pi remove git:github.com/Jawfish/pi-background-tasks
```

A pinned revision remains fixed during updates. Install the same source with a
new `@<commit-or-tag>` to move the pin.

A local checkout can be installed by absolute or relative path:

```sh
pi install /absolute/path/to/pi-background-tasks
```

The package requires Node.js 22 or later. It supports POSIX systems such as
Linux and macOS. It does not support Windows.

## Start and manage tasks

The extension adds one `background_task` tool. The tool has six actions:
`start`, `status`, `logs`, `stop`, `watch`, and `unwatch`.

Start a task with a name, working directory, timeout, and completion policy:

```json
{
  "action": "start",
  "command": "bun test",
  "name": "API tests",
  "cwd": "packages/api",
  "timeoutSeconds": 900,
  "completionPolicy": "wake"
}
```

A relative `cwd` starts from Pi's current working directory. The directory must
exist when the task starts. `timeoutSeconds` must be an integer from 1 through
86400.

A start can atomically register one initial watch. Use this for readiness output
that a fast process could emit before a later tool call can register a watch:

```json
{
  "action": "start",
  "command": "bun run dev",
  "name": "Development server",
  "completionPolicy": "silent",
  "watch": {
    "condition": "output",
    "pattern": "Listening on",
    "wake": true
  }
}
```

The initial watch uses the same output, exit, and inactivity conditions as the
`watch` action. It is registered before task output can be observed.

List all tasks or inspect one task:

```json
{"action":"status"}
{"action":"status","taskId":"a12bc34d"}
```

Stop a task:

```json
{"action":"stop","taskId":"a12bc34d"}
```

A task ID and watch ID can be a full ID or a unique prefix. The tool rejects an
ambiguous prefix.

## Read logs with byte cursors

Read at most 32 KiB in one call. A call without `afterByte` returns a bounded
log tail:

```json
{"action":"logs","taskId":"a12bc34d","maxBytes":16000}
```

For a forward read, start at byte zero and use the returned `nextByte` in the
next call:

```json
{"action":"logs","taskId":"a12bc34d","afterByte":0,"maxBytes":8192}
{"action":"logs","taskId":"a12bc34d","afterByte":8192,"maxBytes":8192}
```

Do not assume that the second cursor is always 8192. Use the `nextByte` value
from the first result. Results also include `startByte`, `bytesRead`,
`totalBytes`, and `truncated`. A read never returns a split UTF-8 prefix. If a
requested cursor points inside a UTF-8 character, `droppedBytes` reports the
skipped continuation bytes.

Task output becomes visible only after the log writer commits it. This rule
keeps cursor reads and watches on the same byte sequence.

## Watch task events

Watches are one-shot conditions. Use them instead of polling `status` or
`logs`. One task can have at most eight watches.

An output watch matches literal UTF-8 text committed after registration. It can
match across output chunks. The pattern limit is 512 bytes. Use the nested
`watch` field on `start` when readiness output could be emitted immediately.

```json
{
  "action": "watch",
  "taskId": "a12bc34d",
  "condition": "output",
  "pattern": "Listening on",
  "wake": true
}
```

An exit watch fires when the task reaches a terminal state:

```json
{"action":"watch","taskId":"a12bc34d","condition":"exit","wake":true}
```

An inactivity watch resets after each accepted output chunk. The quiet period
must be an integer from 1 through 86400 seconds.

```json
{
  "action": "watch",
  "taskId": "a12bc34d",
  "condition": "inactivity",
  "inactivitySeconds": 60,
  "wake": false
}
```

Set `wake` to `true` when the model must continue after the watch fires. Pi can
still show a UI notification when `wake` is false.

Cancel an active watch with its watch ID:

```json
{"action":"unwatch","watchId":"d45ef678"}
```

## Choose a completion policy

`completionPolicy` controls what happens when a task ends:

- `silent` omits the automatic notification and model continuation.
- `notify` alerts the user in supported UI modes. It does not start a model
  turn. This is the default.
- `wake` alerts the user and sends one model continuation after a completed or
  failed task.

A wake message steers the current agent run when Pi is active. It starts a new
turn when Pi is idle. Completions within 100 milliseconds share one
continuation. A manual stop does not cause a continuation. Session shutdown
also suppresses new continuations.

A wake message contains a bounded output tail from before log pruning. The
model-facing message is at most 32 KiB and describes at most 16 tasks. The
extension keeps a failed task or an undelivered event in temporary context until
the model or a tool call observes it.

Saved tool calls that use the old `wakeOnExit` field remain valid. `true` maps
to `wake`, and `false` maps to `notify`. New calls must use
`completionPolicy`. A call cannot set both fields.

## Understand shell execution

The default launch vector is `sh -c <command>`, with `sh` resolved from
`PATH`, instead of the interactive login shell. The extension passes quoting,
escapes, pipelines, and redirection to that shell without changes.

Tasks inherit Pi's environment and user permissions. Each task also receives
fresh Pi session metadata when the value exists:

- `PI_SESSION_ID`
- `PI_SESSION_FILE`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_REASONING_LEVEL`

Set `PI_BACKGROUND_TASK_SHELL` to select another POSIX shell. Set
`PI_BACKGROUND_TASK_SHELL_ARGS` to a JSON array of arguments that must appear
before `-c`.

Run Bash without profile or startup files:

```sh
export PI_BACKGROUND_TASK_SHELL=bash
export PI_BACKGROUND_TASK_SHELL_ARGS='["--noprofile","--norc"]'
```

The extension deliberately has no resource-priority subsystem. Put standard
POSIX priority tools directly in the command when a background job should yield
CPU time:

```sh
nice -n 10 bun test
```

On Linux, `ionice` can additionally request idle I/O priority:

```sh
nice -n 10 ionice -c 3 bun test
```

Put quote-heavy or multiline programs in a script file or a quoted heredoc.
Do not use literal `\uXXXX` text as a replacement for shell quoting.

## Monitor tasks in the TUI

While tasks are active, Pi shows a live summary above the input editor with each
task's state, elapsed time, output size, completion policy, quiet time, and
active watch count. The summary disappears when no task is running or stopping.

Run `/background-tasks` to open the task monitor. It shows task state, elapsed
time, quiet duration after 30 seconds without output, process details, watches,
and the selected task's live committed-output tail in one responsive view.

- Use the configured up and down keys, or `j` and `k`, to select a task.
- Press Enter or `l` to expand the output area or return to the balanced view.
- Press `r` to refresh task state and the output tail.
- Press `x` twice to stop a running task.
- Press Escape or the configured cancel key to close the monitor.

After loading a selected task, the monitor reads again only when that task has
new committed bytes. It keeps read cursors when it closes and reopens and
preserves the newest part of long output lines. It shortens paths under the home directory and removes terminal
control sequences from command text and logs before rendering them.

## Know what survives a session change

`/reload` keeps live tasks for the same Pi session. The replacement extension
adopts the manager, logs, watches, delivery state, failures, and dashboard
cursors. The replacement delivers a task that finishes during reload once.

The old instance grants a 15-second handoff lease. If no replacement claims the
manager before the lease ends, the old instance stops all managed process
groups and deletes the log directory. Set
`PI_BACKGROUND_TASK_HANDOFF_LEASE_MS` to change the lease in milliseconds.

All other session replacement events stop tasks. This rule includes `new`,
`resume`, `fork`, and `quit`. Tasks do not survive a Pi process restart. The
extension does not restore task state in a later Pi process. The task journal
keeps history only.

## Share the manager with another extension

Other Pi extensions can use the session's manager through the versioned `v1`
event-bus service. The public types live in `service.ts`.

```typescript
import {
  BACKGROUND_TASK_DISCOVERY_CHANNEL,
  BACKGROUND_TASK_SERVICE_CHANNEL,
  isBackgroundTaskServiceAnnouncement,
} from "@jawfish/pi-background-tasks/service.ts";
import type {
  BackgroundTaskService,
} from "@jawfish/pi-background-tasks/service.ts";

let tasks: BackgroundTaskService | undefined;
const accept = (service: BackgroundTaskService): void => {
  tasks = service;
};
const stopAnnouncements = pi.events.on(
  BACKGROUND_TASK_SERVICE_CHANNEL,
  (data) => {
    if (isBackgroundTaskServiceAnnouncement(data)) {
      accept(data.service);
    }
  }
);
pi.events.emit(BACKGROUND_TASK_DISCOVERY_CHANNEL, { onService: accept });
```

The service supports start, list, status, logs, stop, watch, unwatch, and watch
status. A start request can include one optional initial `watch`. `subscribe`
emits immutable `started`, `output-committed`, `watch-fired`, and `finished`
events. It does not expose child processes, file
handles, or Pi objects.

Call returned unsubscribe functions during consumer shutdown. A service becomes
unavailable when its provider reloads or its session ends. Discover the
replacement instead of keeping a stale service.

The `v1` channel names, version value, and current field meanings are stable.
Consumers must ignore unknown optional fields and event types. A breaking
change uses a new `v2` channel set. The service will expose `v1` and `v2`
together for a documented transition period before it removes `v1`.

## Inspect the task journal

The extension records task history in a local SQLite journal. The default
file is `$XDG_STATE_HOME/pi-background-tasks/journal.sqlite`, or
`~/.local/state/pi-background-tasks/journal.sqlite` when `XDG_STATE_HOME` is
not set. Set `PI_BACKGROUND_TASK_JOURNAL` to another file path, or to `off` to
disable the journal.

The journal uses WAL mode, so several Pi processes can share one file. SQLite
waits for a lock synchronously, so the lock timeout is 0 and a locked write
retries on a timer instead of stalling Pi. Schema migrations are forward-only. A journal
with a newer schema is not changed; the extension disables its journal for
that session. A journal error never changes a task or a tool result.

Writes are synchronous while the database is free. When another process holds
the lock, the write and every later write wait in order and retry with doubling
backoff (25 ms first). A write that is still busy after 8 retries (about 6 s)
is dropped,
and the next successful write adds a `journal_errors` row with reason
`busy_dropped`. Any other write failure disables the journal for that
instance, reports the error on stderr, and records `disabled_at` and
`disabled_reason` on its `instances` row when it still can.

The journal contains commands, arguments, and complete command output. The
file mode is `0600`. Treat the file as sensitive.

### Tables

Keys are stable across `/reload`. A `task_key` is `<manager-id>/<task-id>`,
and a `watch_key` is `<manager-id>/<watch-id>`. The manager moves to the
replacement instance during reload, so a task keeps its key when a new
instance records its finish.

| Table | Contents |
| --- | --- |
| `instances` | One row per extension instance: Pi session ID and file, cwd, package version, source hash, runtime, process ID, and `disabled_at` and `disabled_reason` when the journal stopped recording. |
| `journal_errors` | Records the journal could not write: `location` (the record kind), `reason` (`busy_dropped`), and the error message. |
| `tasks` | One row per task: origin (`tool` or `service`), command, cwd, policy, timeout, PID, start and end times, status, `terminal_reason`, exit code, signal, and error. |
| `task_outputs` | Output capture for each task: `capture` (`complete`, `partial`, or `missing`), committed and stored sizes, output limit, and log or file errors. |
| `output_blobs` | Content-addressed committed output, keyed by SHA-256. |
| `actions` | Each `background_task` call, including calls Pi rejects before execution, and each service or dashboard action that changes state. It has the arguments, the model-visible outcome, and valid task and watch links. |
| `log_reads` | Each log read: caller, tool call ID, requested and returned cursors, bytes, truncation, and error. Dashboard reads are limited to one row per task each second; `coalesced_reads` counts skipped reads. |
| `watches` | Watch registration (`start` or `watch` origin), condition, wake, pattern or interval, one end state, the matched output, and its byte cursors. |
| `deliveries` | One notification and wake decision for each finished task or fired watch. `notify` is `shown`, `failed`, `silent`, `no-ui`, or `suppressed`. |
| `delivery_events` | Wake delivery steps: `enqueue-attempted`, `enqueued`, `enqueue-failed`, `fallback-injected`, and `observed` with `via` (`context`, `fallback`, `tool:status`, or `tool:logs`). A shared `batch_id` marks one continuation message. |

`terminal_reason` is `exit`, `user`, `shutdown`, `timeout`, `output_limit`, or
`log_failure`. The `task_outcomes` view adds `duration_ms` and `observation`.
A task that started but has no recorded finish has `observation =
'incomplete'` and no status. For example, this occurs when Pi crashes. Do not
read it as a failure.

The journal stores only bytes that the log writer committed. A capture is
`partial` when a log write failed or the log is shorter than the committed
size. It is `missing` when the log could not be read. Capture state does not
change the task outcome.

An `observed` event means that the delivery entered model context or a tool
result. It does not prove that the model acted on it. An enqueued continuation
is not an observation.

### Example queries

Task outcomes, with incomplete observation kept separate:

```sql
SELECT observation, status, terminal_reason, count(*) AS tasks
FROM task_outcomes
GROUP BY observation, status, terminal_reason
ORDER BY tasks DESC;
```

Output sizes and missing output evidence:

```sql
SELECT t.name, o.capture, o.size_bytes, o.output_limit_reached,
  coalesce(o.log_error, o.file_error) AS problem
FROM tasks t LEFT JOIN task_outputs o USING (task_key)
WHERE o.task_key IS NULL OR o.capture != 'complete' OR o.output_limit_reached
ORDER BY t.started_at DESC;
```

Status polling while a task runs:

```sql
SELECT t.name, count(a.action_id) AS status_calls
FROM tasks t
JOIN instances ti ON ti.instance_id = t.started_by_instance
JOIN actions a
  ON a.source = 'tool' AND a.action = 'status'
  AND a.at BETWEEN t.started_at AND coalesce(t.ended_at, a.at)
JOIN instances ai ON ai.instance_id = a.instance_id
  AND ai.pi_session_id = ti.pi_session_id
GROUP BY t.task_key
HAVING status_calls > 2
ORDER BY status_calls DESC;
```

Log read patterns: rereads of bytes already returned, and tail reads:

```sql
SELECT task_key,
  count(*) AS reads,
  sum(requested_after_byte IS NULL) AS tail_reads,
  sum(requested_after_byte < (
    SELECT max(p.next_byte) FROM log_reads p
    WHERE p.task_key = r.task_key AND p.caller = r.caller
      AND p.read_id < r.read_id AND p.requested_after_byte IS NOT NULL
  )) AS rereads
FROM log_reads r
WHERE caller = 'tool' AND task_key IS NOT NULL
GROUP BY task_key;
```

Watch use by condition and end state:

```sql
SELECT condition, origin, status, count(*) AS watches
FROM watches
GROUP BY condition, origin, status;
```

Missed readiness: a later output watch whose pattern already occurred in
committed output before registration:

```sql
SELECT w.watch_key, w.pattern, w.status
FROM watches w
JOIN task_outputs o USING (task_key)
JOIN output_blobs b USING (sha256)
WHERE w.condition = 'output' AND w.origin = 'watch'
  AND instr(CAST(b.content AS TEXT), w.pattern) > 0
  AND w.status != 'fired';
```

Wake deliveries that were never observed:

```sql
SELECT d.delivery_key, d.kind, d.decided_at,
  group_concat(e.event, ' > ') AS events
FROM deliveries d
LEFT JOIN delivery_events e USING (delivery_key)
WHERE d.wake_requested
  AND NOT EXISTS (
    SELECT 1 FROM delivery_events o
    WHERE o.delivery_key = d.delivery_key AND o.event = 'observed'
  )
GROUP BY d.delivery_key;
```

Wake frequency per Pi session and day:

```sql
SELECT i.pi_session_id, date(e.at / 1000, 'unixepoch') AS day,
  count(DISTINCT e.batch_id) AS continuations,
  count(*) AS delivered_events
FROM delivery_events e JOIN instances i USING (instance_id)
WHERE e.event = 'enqueued'
GROUP BY i.pi_session_id, day;
```

## Treat commands and output as untrusted

This extension does not sandbox commands. Tasks have Pi's file, network,
environment, and process permissions, so they can read the same secrets.

Treat command output as untrusted data. Model messages mark it as untrusted,
and custom TUI views remove terminal control sequences. These
steps do not make hostile output safe or prevent prompt injection.

The extension stops the process group that it creates. A command that starts a
new process session or fully daemonizes can escape that group. Such a command
must manage its own shutdown.

## Limits and non-goals

- At most 16 tasks can run at one time.
- Each task can write at most 64 MiB. The extension stops that task at the
  limit.
- The 64 MiB limit is per task. No aggregate output quota applies across tasks.
- One log read returns at most 32 KiB.
- One task can have at most eight active watches.
- An output watch pattern can contain at most 512 UTF-8 bytes.
- Logs use a temporary session directory. Pruning removes old logs, and normal
  session shutdown removes the directory. The task journal keeps a copy of the
  committed output.
- The extension supports POSIX commands and process groups only.
- The extension does not provide a PTY or send input to a running process.
- The extension is not a terminal multiplexer, process supervisor, or sandbox.
- The extension does not replace Bash or the user's shell configuration.
- The extension does not create subagents.
- The extension does not put ordinary Pi tool calls in the background
  automatically. The model must call `background_task`.
- The extension does not preserve tasks across Pi restarts.

## Run release checks

Run the same gates as CI:

```sh
bun install --frozen-lockfile
bun run test:unit
bun run typecheck
bun run test:integration
bun run verify:package
```

`verify:package` checks the exact package archive file list, extracts the
archive, and loads it through Pi in offline mode. CI runs these gates on Linux
and macOS.
