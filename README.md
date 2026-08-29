# Background tasks

This Pi extension runs POSIX shell commands without blocking the agent. It gives the model a current task list before every model call. Commands use `sh` from `PATH` by default, not the user's interactive login shell. Set `PI_BACKGROUND_TASK_SHELL` to use another POSIX shell.

Task commands run from Pi's current working directory and inherit Pi's environment. The extension passes the command to the configured shell with `-c` without rewriting shell quoting or command escapes. Put quote-heavy or multiline programs in a file or a quoted heredoc. Do not use literal `\uXXXX` sequences as substitutes for shell quotes.

## Tool

The extension adds one `background_task` tool with four actions.

Start a task:

```json
{
  "action": "start",
  "name": "Typecheck",
  "command": "bun run typecheck",
  "wakeOnExit": true
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

`taskId` accepts a full ID or a unique prefix.

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

## Automatic continuation

`wakeOnExit` defaults to `false`. When it is `true`, a completed or failed task delivers one automatic continuation. If the agent is active, the completion steers the next model call instead of waiting for the whole run to settle. If the agent is idle, it starts a turn. Completions within 100 milliseconds share one continuation.

The continuation includes bounded output tails captured before log pruning. Its model-facing message is capped at 32 KiB and includes details for at most 16 tasks. Completed and failed wake-enabled tasks are omitted from the parallel recent-task status because the continuation is authoritative. A manual stop does not start a continuation. Pi also suppresses continuations during session shutdown.

## Status context

Before every model call, the extension adds an ephemeral custom message with all active tasks and up to eight recent tasks. The message is sent to the model but is not stored in the session. More completed tasks remain available briefly by ID so a simultaneous completion batch does not lose its logs.

The model does not need to poll `status` or `logs` while it waits. It can use `logs` when it needs the command output.

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
