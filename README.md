# Background tasks

This Pi extension runs POSIX shell commands without blocking the agent. It gives the model a current task list before every model call. Commands use `sh` from `PATH` by default, not the user's interactive login shell. Set `PI_BACKGROUND_TASK_SHELL` to use another POSIX shell.

Task commands run from Pi's current working directory and inherit Pi's environment. The extension passes the command to the configured shell with `-c` without rewriting shell quoting or command escapes. Put quote-heavy or multiline programs in a file or a quoted heredoc. Do not use literal `\uXXXX` sequences as substitutes for shell quotes.

## Tool

The extension adds one `background_task` tool with six actions.

Start a task:

```json
{
  "action": "start",
  "name": "Typecheck",
  "command": "bun run typecheck",
  "completionPolicy": "wake"
}
```

Inspect one task or all tasks:

```json
{"action":"status"}
{"action":"status","taskId":"a12bc34d"}
```

Read the bounded tail of a task log:

```json
{"action":"logs","taskId":"a12bc34d","maxBytes":16000}
```

Stop a task:

```json
{"action":"stop","taskId":"a12bc34d"}
```

Register or cancel a one-shot task watch:

```json
{"action":"watch","taskId":"a12bc34d","condition":"exit","wake":true}
{"action":"unwatch","watchId":"d45ef678"}
```

`taskId` and `watchId` accept a full ID or a unique prefix.

## Interactive monitor

Run `/background-tasks` in Pi's TUI to open an auto-refreshing task monitor. It
adapts to narrow and short terminals and shows task state, elapsed time,
commands, process details, and a bounded log tail.

- Use the configured up and down keys, or `j` and `k`, to select a task.
- Press Enter or `l` to switch between task details and its log tail.
- Press `r` to refresh immediately.
- Press `x` twice to stop a running task. The second press prevents accidental
  stops.
- Press Escape or the configured cancel key to close the monitor.

The footer shows a compact running and stopping count. Tool calls, tool results,
and automatic completions use themed, expandable summaries instead of raw task
data. Terminal control sequences from commands and logs are removed before
custom TUI rendering.

## Completion policy

`completionPolicy` controls what happens when a task ends:

- `silent` sends no automatic user notification or model continuation.
- `notify` alerts the user in supported UI modes without starting a model turn.
  This is the default.
- `wake` alerts the user and delivers one automatic model continuation for a
  completed or failed task.

Stored calls that use the old `wakeOnExit` Boolean remain compatible: `true`
maps to `wake`, while `false` maps to `notify`. New calls must use
`completionPolicy`.

A wake continuation steers the next model call when the agent is active or
starts a turn when it is idle. Completions within 100 milliseconds share one
continuation. The continuation includes bounded output tails captured before
log pruning. Its model-facing message is capped at 32 KiB and includes details
for at most 16 tasks. Command output is marked as untrusted data. A manual stop
does not start a continuation. Pi also suppresses continuations during session
shutdown.

## Status context

Before a model call, the extension adds ephemeral context only when there are
active tasks, unobserved task events, or unacknowledged failures. The context is
not stored in the session, omits temporary log paths and routine successful
history, and disappears after acknowledgement. Empty task state does not add a
message or timestamp.

The model does not need to poll `status` or `logs` while it waits. It can use
`logs` when it needs command output.

## Limits

- POSIX systems only
- 16 tasks can run at once
- Logs are stored under the system temporary directory
- Pruned logs are deleted, and the session log directory is removed at shutdown
- Each task can write up to 64 MiB before the extension stops it
- One log read returns at most 32 KiB and does not return a split UTF-8 prefix
- Tracked process groups stop when the Pi session shuts down or reloads
- Tasks do not survive a Pi restart

Background commands run with the same user permissions and environment as Pi. This extension does not sandbox them. A command that deliberately creates a new process session or fully daemonizes can escape process-group cleanup and must manage its own shutdown.
