import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
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
const savedCwd = process.cwd();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cli-"));
  path = join(dir, "backlog.md");
  writeFileSync(path, FIXTURE, "utf8");
  process.env.TASKS_AXI_FILE = path;
});

afterEach(() => {
  process.chdir(savedCwd);
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
    const out = c.read();
    expect(out).toContain("count:");
    expect(out).toContain("cert-cleanup");
    expect(() => decode(out)).not.toThrow();
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

  it("reports malformed task ids as validation errors", async () => {
    const c = capture();
    await main({ argv: ["show", "bad:id"], stdout: c.stdout });
    expect(c.read()).toContain("Invalid id");
    expect(process.exitCode).toBe(2);
  });

  it("performs a mutation end to end", async () => {
    const c = capture();
    await main({ argv: ["start", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("state: in_flight");
    expect(readFileSync(path, "utf8")).toMatch(/\*\*cert-cleanup\*\*/);
  });

  it("rejects unknown mutation flags instead of shifting positionals", async () => {
    const c = capture();
    await main({
      argv: ["add", "--repoo", "demo", "real-id", "title"],
      stdout: c.stdout,
    });
    expect(c.read()).toContain("Unknown flag: --repoo");
    expect(process.exitCode).toBe(2);
    expect(readFileSync(path, "utf8")).not.toContain("- [ ] demo - real-id");
  });

  it("accepts a global --file after the command", async () => {
    const other = join(dir, "other.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({ argv: ["list", "--file", other], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("solo-q1");
    expect(out).not.toContain("cert-cleanup");
    expect(out).toContain(`Run \`tasks-axi show <id> --file=${other}\``);
  });

  it("carries explicit global backend and file flags into suggestions", async () => {
    const other = join(dir, "other.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({
      argv: ["list", "--backend", "markdown", "--file", other],
      stdout: c.stdout,
    });
    expect(c.read()).toContain(
      `Run \`tasks-axi show <id> --backend=markdown --file=${other}\``,
    );
  });

  it("rejects a missing global flag value", async () => {
    const c = capture();
    await main({ argv: ["list", "--file", "--state"], stdout: c.stdout });
    expect(c.read()).toContain("--file requires a value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects an empty global --file without falling back to env config", async () => {
    const c = capture();
    await main({ argv: ["done", "cert-cleanup", "--file="], stdout: c.stdout });
    expect(c.read()).toContain("--file requires a value");
    expect(process.exitCode).toBe(2);
    expect(readFileSync(path, "utf8")).toContain("- [ ] cert-cleanup");
    expect(readFileSync(path, "utf8")).not.toContain("- [x] cert-cleanup");
  });

  it("rejects a whitespace global --backend value", async () => {
    const c = capture();
    await main({ argv: ["list", "--backend", "   "], stdout: c.stdout });
    expect(c.read()).toContain("--backend requires a value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects multiline global flag values", async () => {
    const c = capture();
    await main({ argv: ["list", "--file", "one\ntwo"], stdout: c.stdout });
    expect(c.read()).toContain("--file must be a single line");
    expect(process.exitCode).toBe(2);
  });

  it("renders config validation errors without a stack trace", async () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = -1\n");
    process.chdir(dir);
    const c = capture();
    await main({ argv: ["list"], stdout: c.stdout });
    expect(c.read()).toContain("markdown.done_keep");
    expect(c.read()).not.toContain("AxiError");
    expect(process.exitCode).toBe(2);
  });

  it("renders the home dashboard with no args", async () => {
    const c = capture();
    await main({ argv: [], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("bin:");
    expect(out).toContain("description:");
    expect(out).toContain("queued[");
    expect(() => decode(out)).not.toThrow();
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
