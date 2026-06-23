import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, TOP_HELP } from "../src/cli.js";
import { FIXTURE } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

function capture() {
  let out = "";
  return {
    stdout: { write: (chunk: string) => void (out += chunk) },
    read: () => out,
  };
}

let dir: string;
let path: string;
const savedFile = process.env.TASKS_AXI_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cli-"));
  path = join(dir, "backlog.md");
  writeFileSync(path, FIXTURE, "utf8");
  process.env.TASKS_AXI_FILE = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedFile === undefined) delete process.env.TASKS_AXI_FILE;
  else process.env.TASKS_AXI_FILE = savedFile;
  process.exitCode = undefined;
});

describe("CLI entrypoint", () => {
  it("prints top-level help", async () => {
    const c = capture();
    await main({ argv: ["--help"], stdout: c.stdout });
    expect(c.read()).toBe(TOP_HELP);
  });

  it.each(["-v", "-V", "--version"])("prints version for %s", async (flag) => {
    const c = capture();
    await main({ argv: [flag], stdout: c.stdout });
    expect(c.read()).toBe(`${pkg.version}\n`);
  });

  it("runs a verb against the env-resolved backlog", async () => {
    const c = capture();
    await main({ argv: ["list", "--state", "queued"], stdout: c.stdout });
    expect(c.read()).toContain("count:");
    expect(c.read()).toContain("cert-cleanup");
  });

  it("treats the `task` noun as optional sugar", async () => {
    const c = capture();
    await main({ argv: ["task", "show", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("id: cert-cleanup");
  });

  it("honors aliases (view = show)", async () => {
    const c = capture();
    await main({ argv: ["view", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("id: cert-cleanup");
  });

  it("performs a mutation end to end", async () => {
    const c = capture();
    await main({ argv: ["start", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("state: in_flight");
    expect(readFileSync(path, "utf8")).toMatch(/\*\*cert-cleanup\*\*/);
  });

  it("accepts a global --file after the command", async () => {
    const other = join(dir, "other.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({ argv: ["list", "--file", other], stdout: c.stdout });
    expect(c.read()).toContain("solo-q1");
    expect(c.read()).not.toContain("cert-cleanup");
  });

  it("rejects a missing global flag value", async () => {
    const c = capture();
    await main({ argv: ["list", "--file", "--state"], stdout: c.stdout });
    expect(c.read()).toContain("--file requires a value");
    expect(process.exitCode).toBe(2);
  });

  it("renders the home dashboard with no args", async () => {
    const c = capture();
    await main({ argv: [], stdout: c.stdout });
    expect(c.read()).toContain("bin:");
    expect(c.read()).toContain("description:");
    expect(c.read()).toContain("queued[");
  });

  it("errors on an unknown command", async () => {
    const c = capture();
    await main({ argv: ["frobnicate"], stdout: c.stdout });
    expect(c.read()).toContain("Unknown command");
    expect(process.exitCode).toBe(2);
  });

  it("returns per-command help with --help", async () => {
    const c = capture();
    await main({ argv: ["done", "--help"], stdout: c.stdout });
    expect(c.read()).toContain("usage: tasks-axi done");
  });
});
