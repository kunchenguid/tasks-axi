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

function quoteSuggestionValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function decodedHelp(out: string): string[] {
  const decoded = decode(out) as { help?: unknown };
  expect(Array.isArray(decoded.help)).toBe(true);
  return decoded.help as string[];
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
    const decoded = decode(c.read()) as {
      task: { id: string; source?: string };
    };
    expect(decoded.task.id).toBe("cert-cleanup");
    expect(decoded.task.source).toBeUndefined();
  });

  it("reads the backend's default Done archive only with explicit opt-in", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-02\n- [x] durable-c1 - durable result (kind: captain) (done 2026-07-02)\n  complete archived body\n",
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "durable-c1", "--include-archive", "--full"],
      stdout: c.stdout,
    });

    const decoded = decode(c.read()) as {
      task: { id: string; source: string; state: string; body: string };
    };
    expect(decoded.task).toMatchObject({
      id: "durable-c1",
      source: "archive",
      state: "done",
      body: "complete archived body",
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("reports archived Done tasks as unblocked while preserving their deps", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-02\n- [x] durable-c1 - durable result (done 2026-07-02) blocked-by: cert-cleanup\n",
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "durable-c1", "--include-archive"],
      stdout: c.stdout,
    });

    const decoded = decode(c.read()) as {
      task: {
        source: string;
        state: string;
        blocked: string;
        blocked_by: string;
        deps: string;
      };
    };
    expect(decoded.task).toMatchObject({
      source: "archive",
      state: "done",
      blocked: "no",
      blocked_by: "none",
      deps: "blocked-by:cert-cleanup",
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("resolves an explicit configured archive path", async () => {
    process.chdir(dir);
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[markdown]\narchive = "custom-done-history.md"\n',
      "utf8",
    );
    writeFileSync(
      join(dir, "custom-done-history.md"),
      "\n## Archived 2026-07-02\n- [x] configured-c1 - configured result (done 2026-07-02)\n",
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "configured-c1", "--include-archive"],
      stdout: c.stdout,
    });

    const decoded = decode(c.read()) as {
      task: { id: string; source: string };
    };
    expect(decoded.task).toMatchObject({
      id: "configured-c1",
      source: "archive",
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("keeps ordinary show active-only with the existing NOT_FOUND exit", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-02\n- [x] archived-only-c1 - cold result (done 2026-07-02)\n",
      "utf8",
    );
    const c = capture();

    await main({ argv: ["show", "archived-only-c1"], stdout: c.stdout });

    expect(c.read()).toContain("code: NOT_FOUND");
    expect(process.exitCode).toBe(1);
  });

  it("preserves NOT_FOUND when archive-inclusive lookup finds no identity", async () => {
    const c = capture();

    await main({
      argv: ["show", "absent-c1", "--include-archive"],
      stdout: c.stdout,
    });

    expect(c.read()).toContain("absent-c1");
    expect(c.read()).toContain("not found in this backlog");
    expect(c.read()).toContain("code: NOT_FOUND");
    expect(process.exitCode).toBe(1);
  });

  it("returns an active identity before reading malformed archive data", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] malformed-c1 - missing typed data (kind: public-followup) (done 2026-07-01)\n",
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "cert-cleanup", "--include-archive"],
      stdout: c.stdout,
    });

    const decoded = decode(c.read()) as {
      task: { id: string; source: string };
    };
    expect(decoded.task).toMatchObject({
      id: "cert-cleanup",
      source: "active",
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("does not hide a malformed active identity behind archive fallback", async () => {
    writeFileSync(
      path,
      "# Backlog\n\n## Queued\n- invalid-active-c1 - malformed active item\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] invalid-active-c1 - valid historical item (done 2026-07-01)\n",
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "invalid-active-c1", "--include-archive"],
      stdout: c.stdout,
    });

    expect(c.read()).toContain("malformed task syntax");
    expect(c.read()).toContain("code: VALIDATION_ERROR");
    expect(process.exitCode).toBe(2);
  });

  it("rejects multiple valid archive records for one identity", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      [
        "",
        "## Archived 2026-07-01",
        "- [x] duplicate-c1 - first result (done 2026-07-01)",
        "",
        "## Archived 2026-07-02",
        "- [x] duplicate-c1 - second result (done 2026-07-02)",
        "",
      ].join("\n"),
      "utf8",
    );
    const c = capture();

    await main({
      argv: ["show", "duplicate-c1", "--include-archive"],
      stdout: c.stdout,
    });

    expect(c.read()).toContain("code: CONFLICT");
    expect(c.read()).toContain("more than once");
    expect(process.exitCode).toBe(1);
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
    expect(c.read()).toContain("ok: start cert-cleanup -> In flight");
    // In-flight items render in firstmate's `- [ ]` checkbox form, under the
    // In flight header (the section, not the bullet, carries the state).
    expect(readFileSync(path, "utf8")).toMatch(
      /## In flight[\s\S]*- \[ \] cert-cleanup/,
    );
  });

  it("emits machine-readable JSON for a mutation with --json", async () => {
    const c = capture();
    await main({ argv: ["start", "cert-cleanup", "--json"], stdout: c.stdout });
    const parsed = JSON.parse(c.read()) as {
      ok: boolean;
      action: string;
      task: { id: string; state: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("start");
    expect(parsed.task.id).toBe("cert-cleanup");
    expect(parsed.task.state).toBe("in_flight");
    expect(process.exitCode).toBeFalsy();
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
    const other = join(dir, "other backlog.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({ argv: ["list", "--file", other], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("solo-q1");
    expect(out).not.toContain("cert-cleanup");
    expect(decodedHelp(out)).toContain(
      `Run \`tasks-axi show <id> --file=${quoteSuggestionValue(other)}\` for full notes on a task`,
    );
  });

  it("carries explicit global backend and file flags into suggestions", async () => {
    const other = join(dir, "other backlog.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({
      argv: ["list", "--backend", "markdown", "--file", other],
      stdout: c.stdout,
    });
    expect(decodedHelp(c.read())).toContain(
      `Run \`tasks-axi show <id> --backend=markdown --file=${quoteSuggestionValue(other)}\` for full notes on a task`,
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

  it("documents archive lookup in show help", async () => {
    const c = capture();
    await main({ argv: ["show", "--help"], stdout: c.stdout });
    expect(c.read()).toContain("--include-archive");
    expect(c.read()).toContain("active first");
    expect(c.read()).toContain("read-only");
  });

  it("returns focused help for a public-followup subcommand", async () => {
    const c = capture();
    await main({
      argv: ["public-followup", "work-event", "--help"],
      stdout: c.stdout,
    });
    expect(c.read()).toBe(
      "usage: tasks-axi public-followup work-event <id> --event-file <file> [--json]",
    );
  });

  it("creates and reads a durable public-followup through the CLI namespace", async () => {
    const requestPath = join(dir, "request.json");
    const expectedPath = join(dir, "expected.json");
    writeFileSync(
      requestPath,
      JSON.stringify({
        request_id: "req-cli-demo",
        platform: "discord",
        context_binding: { version: "ctx1", value: "ctx1_cli_demo" },
        public_safe_summary: "Post the public-safe CLI result",
        received_at: "2026-07-13T12:00:00Z",
        followup_expires_at: "2026-08-13T12:00:00Z",
        reservation_expires_at: "2026-09-13T12:00:00Z",
      }),
    );
    writeFileSync(
      expectedPath,
      JSON.stringify({
        type: "report-ready",
        project: "tasks-axi",
        required_deliverables: ["report_path"],
        completion_policy: "all-required",
      }),
    );

    const created = capture();
    await main({
      argv: [
        "public-followup",
        "add",
        "public-cli-q1",
        "--request-context-file",
        requestPath,
        "--purpose",
        "investigation-result",
        "--expected-final-file",
        expectedPath,
        "--expires-at",
        "2026-10-01T00:00:00Z",
        "--json",
      ],
      stdout: created.stdout,
    });
    expect(JSON.parse(created.read())).toMatchObject({
      ok: true,
      action: "public-followup.add",
      task: {
        id: "public-cli-q1",
        kind: "public-followup",
        public_followup: { schema_version: 1 },
      },
    });
    expect(readFileSync(path, "utf8")).toContain(
      "tasks-axi:public-followup/v1:",
    );

    const listed = capture();
    await main({
      argv: ["public-followup", "list", "--json"],
      stdout: listed.stdout,
    });
    expect(JSON.parse(listed.read())).toMatchObject({
      ok: true,
      count: 1,
      public_followups: [{ id: "public-cli-q1" }],
    });
  });
});
