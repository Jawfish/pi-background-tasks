# Background tasks for Pi

Run session-owned POSIX shell commands without blocking Pi. The extension gives
the model task status before each model call. It can notify or continue the
model when work finishes.

## Install the extension

Install the package for your Pi user:

```sh
pi install npm:@jawfish/pi-background-tasks
```

Try it for one Pi run without changing your settings:

```sh
pi -e npm:@jawfish/pi-background-tasks
```

Update or remove it with Pi's package commands:

```sh
pi update npm:@jawfish/pi-background-tasks
pi remove npm:@jawfish/pi-background-tasks
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

An output watch matches literal UTF-8 text in committed output. It can match
across output chunks. The pattern limit is 512 bytes.

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

Put quote-heavy or multiline programs in a script file or a quoted heredoc.
Do not use literal `\uXXXX` text as a replacement for shell quoting.

## Monitor tasks in the TUI

Run `/background-tasks` to open the task monitor. It shows task state, elapsed
time, process details, watches, and a bounded log tail.

- Use the configured up and down keys, or `j` and `k`, to select a task.
- Press Enter or `l` to switch between task details and its log tail.
- Press `r` to refresh.
- Press `x` twice to stop a running task.
- Press Escape or the configured cancel key to close the monitor.

The TUI keeps read cursors when it closes and reopens. It removes terminal
control sequences from command text and logs before it renders them.

### Herdr side panel

When Pi runs interactively inside [Herdr](https://herdr.dev), the extension
lazily opens a reusable panel on the right when the first background task
starts. The panel shows active tasks first, followed by recent tasks, with live
status, elapsed time, process details, and bounded committed-output previews.
While it is connected, the normal `bg: …` footer status is hidden.

- Use Up and Down, or `j` and `k`, to select a task.
- Press `x` twice to stop an active task.
- Press `r` to refresh, `p` to focus the parent Pi pane, and `?` for help.
- Press `q` or Ctrl+C to close the panel and restore the normal footer status.
- `/background-tasks` focuses or opens the panel instead of showing the modal.

Herdr is detected through `HERDR_ENV=1` and the inherited pane context; it is
not a package dependency. Missing Herdr commands, pane startup failures, or a
disconnected viewer fall back to the existing footer and modal. Set
`PI_BACKGROUND_TASK_HERDR_DASHBOARD=0` to disable the integration. The panel
uses `node` by default; set `PI_BACKGROUND_TASK_NODE` to override the runtime
command.

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
extension does not store task state for a later Pi process.

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
status. `subscribe` emits immutable `started`, `output-committed`,
`watch-fired`, and `finished` events. It does not expose child processes, file
handles, or Pi objects.

Call returned unsubscribe functions during consumer shutdown. A service becomes
unavailable when its provider reloads or its session ends. Discover the
replacement instead of keeping a stale service.

The `v1` channel names, version value, and current field meanings are stable.
Consumers must ignore unknown optional fields and event types. A breaking
change uses a new `v2` channel set. The package will publish `v1` and `v2`
together for at least one minor release before it removes `v1`.

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
  session shutdown removes the directory.
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

`verify:package` checks the exact npm archive file list, extracts the archive,
and loads it through Pi in offline mode. CI runs these gates on Linux and
macOS.
