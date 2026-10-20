import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type TempBacklog, makeBacklog } from "../helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "tasks-axi.ts");
const PREPARE = join(REPO_ROOT, "test", "fixtures", "prepare-command.mjs");

const SOURCE = [
  "# Backlog",
  "",
  "## Queued",
  "- [ ] mover-a - work to hand off",
  "",
  "## Done",
  "",
].join("\n");
const TARGET = "# Backlog\n\n## Queued\n\n## Done\n";

function mvArgs(
  source: TempBacklog,
  target: TempBacklog,
  prepare: string,
): string[] {
  return [
    "--import",
    "tsx",
    BIN,
    "mv",
    "mover-a",
    "--to",
    target.path,
    "--file",
    source.path,
    "--prepare",
    prepare,
  ];
}

function prepareCommand(log: string, ...rest: string[]): string {
  return [process.execPath, PREPARE, log, ...rest]
    .map((part) => `"${part}"`)
    .join(" ");
}

function invocations(log: string): number[] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("invoked "))
        .map((line) => Number(line.split(" ")[1]))
    : [];
}

async function waitFor(check: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function finished(
  child: ChildProcess,
): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, output })),
  );
}

describe.skipIf(process.platform === "win32")(
  "mv --prepare interrupted mid-prepare",
  () => {
    const open: TempBacklog[] = [];
    const orphans: number[] = [];
    afterEach(() => {
      for (const pid of orphans.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      for (const b of open.splice(0)) b.cleanup();
    });

    function pair(): { source: TempBacklog; target: TempBacklog; log: string } {
      const source = makeBacklog(SOURCE);
      const target = makeBacklog(TARGET);
      open.push(source, target);
      return { source, target, log: join(source.dir, "prepare.log") };
    }

    it("on SIGTERM stops the prepare command, releases the locks, and moves nothing", async () => {
      const { source, target, log } = pair();
      const child = spawn(
        process.execPath,
        mvArgs(source, target, prepareCommand(log, "sleep", "20000")),
        { cwd: REPO_ROOT },
      );
      const result = finished(child);
      await waitFor(() => invocations(log).length === 1);

      child.kill("SIGTERM");
      const { code, output } = await result;

      expect(code).toBe(1);
      expect(output).toContain("PREPARE_FAILED");
      expect(source.read()).toBe(SOURCE);
      expect(target.read()).toBe(TARGET);
      expect(existsSync(`${source.path}.lock`)).toBe(false);
      expect(existsSync(`${target.path}.lock`)).toBe(false);
      await waitFor(() => !isAlive(invocations(log)[0]));

      const retry = spawnSync(
        process.execPath,
        mvArgs(source, target, prepareCommand(log, "ok")),
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(retry.status).toBe(0);
      expect(target.read()).toContain("mover-a");
      expect(invocations(log)).toHaveLength(2);
    }, 30000);

    it("on SIGKILL moves nothing, leaves the locks for manual cleanup, and prepares again on retry", async () => {
      const { source, target, log } = pair();
      const child = spawn(
        process.execPath,
        mvArgs(source, target, prepareCommand(log, "sleep", "20000")),
        { cwd: REPO_ROOT, stdio: "ignore" },
      );
      const exited = new Promise((resolve) => child.on("exit", resolve));
      await waitFor(() => invocations(log).length === 1);
      orphans.push(invocations(log)[0]);

      child.kill("SIGKILL");
      await exited;

      expect(source.read()).toBe(SOURCE);
      expect(target.read()).toBe(TARGET);
      expect(existsSync(`${source.path}.lock`)).toBe(true);
      expect(existsSync(`${target.path}.lock`)).toBe(true);

      rmSync(`${source.path}.lock`);
      rmSync(`${target.path}.lock`);
      const retry = spawnSync(
        process.execPath,
        mvArgs(source, target, prepareCommand(log, "ok")),
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(retry.status).toBe(0);
      expect(target.read()).toContain("mover-a");
      expect(invocations(log)).toHaveLength(2);
    }, 30000);
  },
);
