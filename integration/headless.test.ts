import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProcessGroupAlive, waitFor } from "./harness.ts";

const INTEGRATION_TIMEOUT_MS = 20_000;
const PROCESS_EXIT_GRACE_MS = 500;
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_BIN = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "pi");
const CLI_JS = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js"
);
const EXTENSION_PATH = path.join(REPOSITORY_ROOT, "index.ts");
const PROVIDER_PATH = path.join(
  REPOSITORY_ROOT,
  "integration",
  "fixtures",
  "headless-provider.ts"
);
const PROVIDER_ID = "pi-background-tasks-headless-test";
const MODEL_ID = "faux-1";

interface RpcRecord {
  [key: string]: unknown;
  id?: string;
  success?: boolean;
  type: string;
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const fallbackProcessGroups = new Set<number>();
const headlessRoots = new Set<string>();

const readProbePid = async function readProbePid(
  rootDir: string
): Promise<number | undefined> {
  try {
    const value = await readFile(path.join(rootDir, "task.pid"), "utf-8");
    const pid = Number(value.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const killProbe = function killProbe(pid: number): void {
  if (!isProcessGroupAlive(pid)) {
    fallbackProcessGroups.delete(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may exit between the probe and signal.
  }
};

process.once("exit", () => {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  for (const pid of fallbackProcessGroups) {
    killProbe(pid);
  }
});

const hasExited = function hasExited(
  child: ChildProcessWithoutNullStreams
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
};

const waitForChildExit = async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("close", handleClose);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const handleClose = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("close", handleClose);
  });
};

const terminateChild = async function terminateChild(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  if (!hasExited(child)) {
    child.kill("SIGTERM");
    if (!(await waitForChildExit(child, PROCESS_EXIT_GRACE_MS))) {
      child.kill("SIGKILL");
      await waitForChildExit(child, PROCESS_EXIT_GRACE_MS);
    }
  }
  if (!hasExited(child)) {
    throw new Error(`Headless Pi process ${String(child.pid)} did not exit`);
  }
  activeChildren.delete(child);
};

const cleanupRoot = async function cleanupRoot(rootDir: string): Promise<void> {
  const pid = await readProbePid(rootDir);
  let cleanupError: unknown;
  if (pid !== undefined) {
    fallbackProcessGroups.add(pid);
    killProbe(pid);
    try {
      await waitFor(
        () => !isProcessGroupAlive(pid),
        `headless process group ${String(pid)}`
      );
      fallbackProcessGroups.delete(pid);
    } catch (error) {
      cleanupError = error;
    }
  }
  await rm(rootDir, { force: true, recursive: true });
  if (cleanupError) {
    throw cleanupError;
  }
};

afterEach(async () => {
  const childResults = await Promise.allSettled(
    [...activeChildren].map(async (child) => terminateChild(child))
  );
  const rootResults = await Promise.allSettled(
    [...headlessRoots].map(async (rootDir) => cleanupRoot(rootDir))
  );
  headlessRoots.clear();
  const failures = [...childResults, ...rootResults].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Headless Pi cleanup failed");
  }
});

const createHeadlessRoot = async function createHeadlessRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "pi-bg-headless-"));
  headlessRoots.add(rootDir);
  await mkdir(path.join(rootDir, "home"), { recursive: true });
  return rootDir;
};

const headlessEnvironment = function headlessEnvironment(
  rootDir: string
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.PI_BACKGROUND_TASK_SHELL;
  delete environment.PI_BACKGROUND_TASK_SHELL_ARGS;
  const pidFile = path.join(rootDir, "task.pid");
  return {
    ...environment,
    HOME: path.join(rootDir, "home"),
    PI_BG_HEADLESS_COMMAND: `printf '%s' "$$" > '${pidFile}'; printf headless-output`,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
};

const commonArguments = [
  "--offline",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--extension",
  PROVIDER_PATH,
  "--extension",
  EXTENSION_PATH,
  "--provider",
  PROVIDER_ID,
  "--model",
  MODEL_ID,
  "--thinking",
  "off",
  "--tools",
  "background_task",
] as const;

const spawnHeadless = function spawnHeadless(
  executable: string,
  arguments_: readonly string[],
  rootDir: string
): ChildProcessWithoutNullStreams {
  const child = spawn(executable, [...arguments_], {
    cwd: REPOSITORY_ROOT,
    env: headlessEnvironment(rootDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.add(child);
  child.once("close", () => {
    activeChildren.delete(child);
  });
  return child;
};

const runPrintCli = async function runPrintCli(rootDir: string): Promise<{
  stderr: string;
  stdout: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawnHeadless(
      CLI_BIN,
      ["--print", ...commonArguments, "Run the headless task"],
      rootDir
    );
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChild(child).then(
        () => {
          reject(
            new Error(
              `Print mode timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`
            )
          );
        },
        reject
      );
    }, 15_000);
    timeout.unref();
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Print mode exited with code ${String(code)} and signal ${String(signal)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }
      resolve({ stderr, stdout });
    });
    child.stdin.end();
  });
};

const awaitRpcRecord = async function awaitRpcRecord(
  child: ChildProcessWithoutNullStreams,
  records: RpcRecord[],
  getParseError: () => Error | undefined,
  predicate: (record: RpcRecord) => boolean,
  label: string,
  stderr: () => string
): Promise<RpcRecord> {
  let match: RpcRecord | undefined;
  await waitFor(
    () => {
      match = records.find(predicate);
      return match !== undefined || getParseError() !== undefined || hasExited(child);
    },
    label,
    15_000
  );
  const parseError = getParseError();
  if (parseError) {
    throw parseError;
  }
  if (!match) {
    throw new Error(`RPC process exited before ${label}. Stderr: ${stderr()}`);
  }
  return match;
};

const runRpcCli = async function runRpcCli(rootDir: string): Promise<{
  events: RpcRecord[];
  lastAssistantText: string;
  stderr: string;
}> {
  const child = spawnHeadless(
    "node",
    [CLI_JS, "--mode", "rpc", ...commonArguments],
    rootDir
  );
  const records: RpcRecord[] = [];
  let buffer = "";
  let parseError: Error | undefined;
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (data: string) => {
    buffer += data;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== "object" ||
          value === null ||
          !("type" in value) ||
          typeof value.type !== "string"
        ) {
          throw new Error("RPC line is not a typed JSON object");
        }
        records.push(value as RpcRecord);
      } catch (error) {
        parseError = new Error(
          `RPC emitted non-JSONL stdout: ${line}`,
          error instanceof Error ? { cause: error } : undefined
        );
      }
    }
  });
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        id: "prompt",
        message: "Run the RPC headless task",
        type: "prompt",
      })}\n`
    );
    const promptResponse = await awaitRpcRecord(
      child,
      records,
      () => parseError,
      (record) => record.type === "response" && record.id === "prompt",
      "RPC prompt response",
      () => stderr
    );
    expect(promptResponse.success).toBe(true);
    await awaitRpcRecord(
      child,
      records,
      () => parseError,
      (record) => record.type === "agent_settled",
      "settled RPC agent",
      () => stderr
    );

    child.stdin.write(
      `${JSON.stringify({ id: "last-text", type: "get_last_assistant_text" })}\n`
    );
    const textResponse = await awaitRpcRecord(
      child,
      records,
      () => parseError,
      (record) => record.type === "response" && record.id === "last-text",
      "last assistant text response",
      () => stderr
    );
    expect(textResponse.success).toBe(true);
    const text = (textResponse.data as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") {
      throw new Error("RPC last assistant text response did not contain text");
    }
    return {
      events: records.filter((record) => record.type !== "response"),
      lastAssistantText: text,
      stderr,
    };
  } finally {
    await terminateChild(child);
    if (buffer.length > 0) {
      throw new Error(`RPC emitted an unterminated stdout record: ${buffer}`);
    }
  }
};

const expectProbeStopped = async function expectProbeStopped(
  rootDir: string
): Promise<void> {
  const pid = await readProbePid(rootDir);
  expect(pid).toBeNumber();
  fallbackProcessGroups.add(pid!);
  await waitFor(() => !isProcessGroupAlive(pid!), "headless process group");
  fallbackProcessGroups.delete(pid!);
  expect(isProcessGroupAlive(pid!)).toBe(false);
};

describe("background tasks in headless Pi modes", () => {
  test(
    "completes in print mode without credentials, network, or leaked processes",
    async () => {
      const rootDir = await createHeadlessRoot();
      const result = await runPrintCli(rootDir);

      expect(result.stdout).toContain("Headless completion handled");
      expect(result.stderr).not.toContain("Extension error");
      expect(result.stderr).not.toContain("No API key");
      await expectProbeStopped(rootDir);
    },
    INTEGRATION_TIMEOUT_MS
  );

  test(
    "emits strict JSONL in RPC mode without TUI output or leaked processes",
    async () => {
      const rootDir = await createHeadlessRoot();
      const result = await runRpcCli(rootDir);

      expect(result.lastAssistantText).toBe("Headless completion handled");
      expect(
        result.events.some(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "background_task" &&
            !event.isError
        )
      ).toBe(true);
      expect(
        result.events.some((event) => event.type === "extension_error")
      ).toBe(false);
      expect(result.stderr).not.toContain("Extension error");
      await expectProbeStopped(rootDir);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
