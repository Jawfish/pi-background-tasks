import { afterEach, describe, expect, test } from "bun:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProcessGroupAlive, waitFor } from "./harness.ts";

const INTEGRATION_TIMEOUT_MS = 20_000;
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

const activeClients = new Set<RpcClient>();
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
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may exit between the probe and signal.
  }
};

afterEach(async () => {
  await Promise.allSettled([...activeClients].map(async (client) => client.stop()));
  activeClients.clear();
  for (const rootDir of headlessRoots) {
    // Cleanup must also run when a subprocess assertion fails.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const pid = await readProbePid(rootDir);
    if (pid !== undefined) {
      killProbe(pid);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await rm(rootDir, { force: true, recursive: true });
  }
  headlessRoots.clear();
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
  const pidFile = path.join(rootDir, "task.pid");
  return {
    ...process.env,
    HOME: path.join(rootDir, "home"),
    PI_BG_HEADLESS_COMMAND: `printf '%s' "$$" > '${pidFile}'; sleep 0.05; printf headless-output`,
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

const runPrintCli = async function runPrintCli(rootDir: string): Promise<{
  stderr: string;
  stdout: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      CLI_BIN,
      ["--print", ...commonArguments, "Run the headless task"],
      {
        cwd: REPOSITORY_ROOT,
        env: headlessEnvironment(rootDir),
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Print mode timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
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
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
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

const expectProbeStopped = async function expectProbeStopped(
  rootDir: string
): Promise<void> {
  const pid = await readProbePid(rootDir);
  expect(pid).toBeNumber();
  await waitFor(() => !isProcessGroupAlive(pid!), "headless process group");
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
    "completes in RPC mode through JSON events without a TUI leak",
    async () => {
      const rootDir = await createHeadlessRoot();
      const client = new RpcClient({
        args: [...commonArguments],
        cliPath: CLI_JS,
        cwd: REPOSITORY_ROOT,
        env: headlessEnvironment(rootDir) as Record<string, string>,
        model: MODEL_ID,
        provider: PROVIDER_ID,
      });
      activeClients.add(client);
      await client.start();
      const events = await client.promptAndWait(
        "Run the RPC headless task",
        undefined,
        15_000
      );

      expect(await client.getLastAssistantText()).toBe(
        "Headless completion handled"
      );
      expect(
        events.some(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "background_task" &&
            !event.isError
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            (event as unknown as { type: string }).type === "extension_error"
        )
      ).toBe(false);
      await client.stop();
      activeClients.delete(client);
      await expectProbeStopped(rootDir);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
