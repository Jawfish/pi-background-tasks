import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  TaskLogs,
  TaskSnapshot,
  TaskWatchSnapshot,
} from "./core.ts";
import {
  renderBackgroundTaskCall,
  renderBackgroundTaskResult,
  renderCompletionMessage,
  TaskDashboardComponent,
  TaskDashboardReadState,
} from "./tui.ts";

const components: TaskDashboardComponent[] = [];

const theme = {
  bg(_color: string, text: string) {
    return `\u001b[48;5;236m${text}\u001b[0m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
  fg(_color: string, text: string) {
    return `\u001b[38;5;250m${text}\u001b[0m`;
  },
} as Theme;

const task = function task(
  overrides: Partial<TaskSnapshot> = {}
): TaskSnapshot {
  return {
    bytesWritten: 12,
    command: "printf hello",
    cwd: "/tmp/project",
    id: "abc12345",
    logPath: "/tmp/abc12345.log",
    name: "Build project",
    pid: 1234,
    startedAt: Date.now() - 5000,
    status: "running",
    completionPolicy: "wake",
    ...overrides,
  };
};

const createTui = function createTui(rows: number, columns = 100) {
  let renders = 0;
  const tui = {
    requestRender() {
      renders += 1;
    },
    terminal: { columns, rows },
  } as unknown as TUI;
  return { get renders() { return renders; }, tui };
};

const createDashboard = function createDashboard(options: {
  logs?: TaskLogs;
  readState?: TaskDashboardReadState;
  rows?: number;
  tasks?: TaskSnapshot[];
}) {
  const source = options.tasks ?? [task()];
  let stopCalls = 0;
  const manager = {
    list: () => source.map((item) => ({ ...item })),
    async logs(): Promise<TaskLogs> {
      return (
        options.logs ?? {
          bytesRead: 5,
          output: "hello",
          task: { ...source[0]! },
          text: "hello\n\nFull log: /tmp/abc12345.log",
          totalBytes: 5,
          truncated: false,
        }
      );
    },
    stop(id: string): TaskSnapshot {
      stopCalls += 1;
      const selected = source.find((item) => item.id === id);
      if (!selected) {
        throw new Error("missing task");
      }
      selected.status = "stopping";
      return { ...selected };
    },
  };
  const { tui } = createTui(options.rows ?? 30);
  const component = new TaskDashboardComponent({
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    manager,
    onClose() {},
    readState: options.readState,
    theme,
    tui,
  });
  components.push(component);
  return { component, get stopCalls() { return stopCalls; } };
};

afterEach(() => {
  for (const component of components.splice(0)) {
    component.dispose();
  }
});

describe("background task dashboard", () => {
  test("stays within narrow terminal width and height constraints", () => {
    const malicious = task({
      command: "printf '\u001b]2;bad title\u0007hello'",
      name: "Unsafe \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007",
    });

    for (const rows of [1, 2, 4, 8, 14, 30]) {
      for (const width of [0, 1, 2, 18, 44, 80]) {
        const { component } = createDashboard({ rows, tasks: [malicious] });
        const lines = component.render(width);
        expect(lines.length).toBeLessThanOrEqual(
          Math.max(1, Math.floor(rows * 0.9))
        );
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        const visible = stripTerminalSequences(lines.join("\n"));
        expect(visible).not.toContain("bad title");
        expect(visible).not.toContain("https://example.test");
      }
    }
  });

  test("shows quiet duration only for active tasks after the threshold", () => {
    const now = Date.now();
    const quiet = createDashboard({
      tasks: [
        task({
          lastOutputAt: now - 90_500,
          name: "Quiet worker",
          startedAt: now - 180_000,
        }),
      ],
    });
    const quietText = stripTerminalSequences(
      quiet.component.render(100).join("\n")
    );
    expect(quietText).toContain("quiet 1m 30s");

    const completed = createDashboard({
      tasks: [
        task({
          endedAt: now - 60_000,
          lastOutputAt: now - 120_000,
          name: "Completed worker",
          startedAt: now - 180_000,
          status: "completed",
        }),
      ],
    });
    const completedText = stripTerminalSequences(
      completed.component.render(100).join("\n")
    );
    expect(completedText).not.toContain("quiet");
  });

  test("requires a deliberate second stop keypress", () => {
    const dashboard = createDashboard({});

    dashboard.component.handleInput("x");
    expect(dashboard.stopCalls).toBe(0);
    expect(stripTerminalSequences(dashboard.component.render(80).join("\n"))).toContain(
      "Press x again"
    );

    dashboard.component.handleInput("x");
    expect(dashboard.stopCalls).toBe(1);
    expect(stripTerminalSequences(dashboard.component.render(80).join("\n"))).toContain(
      "Stop requested"
    );
  });

  test("keeps the newest log response with one read per refresh", async () => {
    const selected = task();
    const first = Promise.withResolvers<TaskLogs>();
    const second = Promise.withResolvers<TaskLogs>();
    const readState = new TaskDashboardReadState();
    let logCalls = 0;
    const manager = {
      list: () => [{ ...selected }],
      logs: () => {
        logCalls += 1;
        return logCalls === 1 ? first.promise : second.promise;
      },
      stop: () => ({ ...selected, status: "stopping" as const }),
    };
    const { tui } = createTui(30);
    const component = new TaskDashboardComponent({
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      manager,
      onClose() {},
      readState,
      theme,
      tui,
    });
    components.push(component);

    component.handleInput("\r");
    component.handleInput("r");
    const makeLogs = (output: string): TaskLogs => ({
      bytesRead: output.length,
      nextByte: output.length,
      output,
      startByte: 0,
      task: selected,
      text: output,
      totalBytes: output.length,
      truncated: false,
    });
    second.resolve(makeLogs("new response"));
    await Promise.resolve();
    await Promise.resolve();
    first.resolve(makeLogs("stale response"));
    await Promise.resolve();
    await Promise.resolve();

    const rendered = stripTerminalSequences(component.render(80).join("\n"));
    expect(logCalls).toBe(2);
    expect(rendered).toContain("new response");
    expect(rendered).not.toContain("stale response");
    expect(readState.cursor(selected.id)).toBe("new response".length);
  });

  test("ignores a stale log failure after a newer success", async () => {
    const selected = task();
    const first = Promise.withResolvers<TaskLogs>();
    const second = Promise.withResolvers<TaskLogs>();
    let logCalls = 0;
    const manager = {
      list: () => [{ ...selected }],
      logs: () => {
        logCalls += 1;
        return logCalls === 1 ? first.promise : second.promise;
      },
      stop: () => ({ ...selected, status: "stopping" as const }),
    };
    const { tui } = createTui(30);
    const component = new TaskDashboardComponent({
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      manager,
      onClose() {},
      theme,
      tui,
    });
    components.push(component);
    const logs: TaskLogs = {
      bytesRead: 12,
      output: "new response",
      task: selected,
      text: "new response",
      totalBytes: 12,
      truncated: false,
    };

    component.handleInput("\r");
    component.handleInput("r");
    second.resolve(logs);
    await Promise.resolve();
    await Promise.resolve();
    first.reject(new Error("stale failure"));
    await Promise.resolve();
    await Promise.resolve();

    const rendered = stripTerminalSequences(component.render(80).join("\n"));
    expect(logCalls).toBe(2);
    expect(rendered).toContain("new response");
    expect(rendered).not.toContain("stale failure");
    expect(rendered).not.toContain("Could not read log");
  });

  test("preserves read cursors across reopen and releases pruned tasks", async () => {
    const selected = task({ bytesWritten: 12 });
    const readState = new TaskDashboardReadState();
    const requestedCursors: number[] = [];
    const manager = {
      list: () => [{ ...selected }],
      logs: (
        _id: string,
        _requestedBytes?: number,
        afterByte = 0
      ): Promise<TaskLogs> => {
        requestedCursors.push(afterByte);
        return Promise.resolve({
          bytesRead: selected.bytesWritten - afterByte,
          nextByte: selected.bytesWritten,
          output: `bytes after ${String(afterByte)}`,
          startByte: afterByte,
          task: { ...selected },
          text: "unused",
          totalBytes: selected.bytesWritten,
          truncated: false,
        });
      },
      stop: () => ({ ...selected, status: "stopping" as const }),
    };
    const openDashboard = () => {
      const { tui } = createTui(30);
      const component = new TaskDashboardComponent({
        keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
        manager,
        onClose() {},
        readState,
        theme,
        tui,
      });
      components.push(component);
      component.handleInput("\r");
      return component;
    };

    const first = openDashboard();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestedCursors).toEqual([0]);
    expect(readState.cursor(selected.id)).toBe(12);
    first.dispose();

    selected.bytesWritten = 20;
    const reopened = openDashboard();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestedCursors).toEqual([0, 12]);
    expect(readState.cursor(selected.id)).toBe(20);
    reopened.dispose();

    const empty = createDashboard({ readState, tasks: [] });
    expect(empty.component).toBeDefined();
    expect(readState.cursor(selected.id)).toBe(0);
  });

  test("updates unread counts for open, closed, and switched tasks", async () => {
    const first = task({ bytesWritten: 12, id: "first001" });
    const second = task({
      bytesWritten: 20,
      id: "second02",
      status: "completed",
    });
    const source = [first, second];
    const readState = new TaskDashboardReadState();
    readState.markRead(first.id, 4);
    readState.markRead(second.id, 5);
    const requests: { afterByte: number; taskId: string }[] = [];
    const manager = {
      list: () => source.map((item) => ({ ...item })),
      logs: (
        taskId: string,
        _requestedBytes?: number,
        afterByte = 0
      ): Promise<TaskLogs> => {
        const selected = source.find((item) => item.id === taskId)!;
        requests.push({ afterByte, taskId });
        return Promise.resolve({
          bytesRead: selected.bytesWritten - afterByte,
          nextByte: selected.bytesWritten,
          output: `new ${taskId}`,
          startByte: afterByte,
          task: { ...selected },
          text: "unused",
          totalBytes: selected.bytesWritten,
          truncated: false,
        });
      },
      stop: (taskId: string) =>
        ({ ...source.find((item) => item.id === taskId)! }),
    };
    const { tui } = createTui(30);
    const component = new TaskDashboardComponent({
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      manager,
      onClose() {},
      readState,
      theme,
      tui,
    });
    components.push(component);

    let rendered = stripTerminalSequences(component.render(100).join("\n"));
    expect(rendered).toContain("+8 B unread");
    expect(rendered).toContain("+15 B unread");

    component.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();
    rendered = stripTerminalSequences(component.render(100).join("\n"));
    expect(rendered).toContain("read through byte 12 of 12");
    expect(readState.cursor(first.id)).toBe(12);
    expect(readState.cursor(second.id)).toBe(5);

    component.handleInput("\r");
    first.bytesWritten = 18;
    component.refresh();
    rendered = stripTerminalSequences(component.render(100).join("\n"));
    expect(rendered).toContain("+6 B unread");

    component.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();
    component.handleInput("j");
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toEqual([
      { afterByte: 4, taskId: first.id },
      { afterByte: 12, taskId: first.id },
      { afterByte: 5, taskId: second.id },
    ]);
    expect(readState.cursor(first.id)).toBe(18);
    expect(readState.cursor(second.id)).toBe(20);
  });

  test("renders bounded active and historical watch state", () => {
    const now = Date.now();
    const watches: TaskWatchSnapshot[] = [
      {
        condition: "output",
        createdAt: now,
        id: "watch001",
        pattern: `ready-${"x".repeat(160)}\u001b]2;owned\u0007`,
        status: "active",
        taskId: "watched1",
        wake: true,
      },
      {
        condition: "exit",
        createdAt: now - 1,
        endedAt: now,
        id: "watch002",
        status: "fired",
        taskId: "watched1",
        wake: false,
      },
      {
        condition: "inactivity",
        createdAt: now - 2,
        endedAt: now,
        id: "watch003",
        inactivitySeconds: 30,
        status: "cancelled",
        taskId: "watched1",
        wake: false,
      },
      {
        condition: "output",
        createdAt: now - 3,
        endedAt: now,
        id: "watch004",
        pattern: "timeout",
        status: "expired",
        taskId: "watched1",
        wake: false,
      },
    ];
    const watched = task({
      bytesWritten: 0,
      id: "watched1",
      watches,
    });
    const dashboard = createDashboard({ rows: 50, tasks: [watched] });

    for (const width of [44, 100]) {
      const lines = dashboard.component.render(width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      const rendered = stripTerminalSequences(lines.join("\n"));
      if (width === 100) {
        expect(rendered).toContain("4 watches");
      } else {
        expect(rendered).toContain("● run");
      }
      for (const status of ["active", "fired", "cancelled", "expired"]) {
        expect(rendered).toContain(`${status} watch`);
      }
      if (width === 100) {
        expect(rendered).toContain("wake model");
      }
      expect(rendered).not.toContain("owned");
      expect(rendered).not.toContain("x".repeat(100));
    }
  });

  test("loads a sanitized log tail without rendering terminal controls", async () => {
    const selected = task();
    const dashboard = createDashboard({
      logs: {
        bytesRead: 17,
        output: "\u001b]2;owned\u0007hello\nworld",
        task: selected,
        text: "unused",
        totalBytes: 17,
        truncated: false,
      },
      tasks: [selected],
    });

    dashboard.component.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();
    const rendered = stripTerminalSequences(
      dashboard.component.render(80).join("\n")
    );

    expect(rendered).toContain("hello");
    expect(rendered).toContain("world");
    expect(rendered).not.toContain("owned");
  });
});

describe("background task transcript rendering", () => {
  test("renders incremental cursor calls and ranges", () => {
    const selected = task({ status: "completed" });
    const call = renderBackgroundTaskCall(
      {
        action: "logs",
        afterByte: 2,
        maxBytes: 16,
        taskId: selected.id,
      },
      theme,
      { expanded: false }
    );
    const result = renderBackgroundTaskResult(
      {
        content: [{ type: "text", text: "unused" }],
        details: {
          bytesRead: 2,
          droppedBytes: 1,
          nextByte: 5,
          output: "ok",
          startByte: 3,
          task: selected,
          totalBytes: 9,
          truncated: true,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { action: "logs" }, isError: false }
    );

    expect(stripTerminalSequences(call.render(80).join("\n"))).toContain(
      "after byte 2"
    );
    const rendered = stripTerminalSequences(result.render(80).join("\n"));
    expect(rendered).toContain("bytes 3-5 of 9");
    expect(rendered).toContain("skipped 1");
    expect(rendered).toContain("ok");
  });

  test("does not report an empty captured output as unavailable", () => {
    const completion = renderCompletionMessage(
      {
        content: "hidden",
        details: {
          omitted: 0,
          tasks: [
            {
              id: "abc12345",
              name: "Quiet task",
              output: "",
              outputError: "should not be shown",
              status: "completed",
            },
          ],
        },
      },
      { expanded: true, outputPad: 0 },
      theme
    );

    const rendered = stripTerminalSequences(completion.render(80).join("\n"));
    expect(rendered).not.toContain("Output unavailable");
    expect(rendered).not.toContain("should not be shown");
  });

  test("renders legacy task snapshots with an effective policy", () => {
    const current = task();
    const { completionPolicy: _completionPolicy, ...legacyFields } = current;
    const legacy = {
      ...legacyFields,
      wakeOnExit: true,
    } as unknown as TaskSnapshot;
    const result = renderBackgroundTaskResult(
      {
        content: [{ type: "text", text: "started" }],
        details: { task: legacy },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: { action: "start" }, isError: false }
    );

    const rendered = stripTerminalSequences(result.render(80).join("\n"));
    expect(rendered).toContain("policy wake");
    expect(rendered).not.toContain("undefined");
  });

  test("renders compact calls, results, and completion cards", () => {
    const running = task();
    const call = renderBackgroundTaskCall(
      {
        action: "start",
        command: "bun test",
        name: "Test suite",
        timeoutSeconds: 120,
        completionPolicy: "wake",
        watch: {
          condition: "output",
          pattern: "ready",
          wake: true,
        },
      },
      theme,
      { expanded: false }
    );
    const result = renderBackgroundTaskResult(
      {
        content: [{ type: "text", text: "started" }],
        details: { task: running },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: { action: "start" }, isError: false }
    );
    const completion = renderCompletionMessage(
      {
        content: "model-facing XML is intentionally hidden",
        details: {
          omitted: 0,
          tasks: [
            {
              exitCode: 0,
              id: running.id,
              name: running.name,
              output: "all tests passed",
              status: "completed",
            },
          ],
        },
      },
      { expanded: true, outputPad: 1 },
      theme
    );

    for (const component of [call, result, completion]) {
      const lines = component.render(48);
      expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    }
    const callText = stripTerminalSequences(call.render(80).join("\n"));
    const inlineCallText = callText.replaceAll(/\s+/gu, " ");
    expect(inlineCallText).toContain("policy wake");
    expect(inlineCallText).toContain("initial output watch + wake");
    expect(stripTerminalSequences(result.render(80).join("\n"))).toContain(
      "Running"
    );
    const completionText = stripTerminalSequences(
      completion.render(80).join("\n")
    );
    expect(completionText).toContain("1 task completed");
    expect(completionText).toContain("all tests passed");
    expect(completionText).not.toContain("model-facing XML");
  });
});
