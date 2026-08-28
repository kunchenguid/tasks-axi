import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  ADD_HELP,
  addCommand,
  listCommand,
  rmCommand,
  showCommand,
  updateCommand,
} from "../../src/commands/crud.js";
import { makeBacklog } from "../helpers.js";

describe("crud commands", () => {
  describe("add", () => {
    it("adds a queued task and suggests next steps", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          ["new-q1", "a fresh task", "--kind", "ship", "--repo", "demo"],
          b.ctx,
        );
        expect(out).toContain("id: new-q1");
        expect(out).toContain("state: queued");
        expect(out).toContain("Run `tasks-axi start new-q1`");
        expect(b.read()).toContain("- [ ] new-q1 - a fresh task");
      } finally {
        b.cleanup();
      }
    });

    it("adds directly to In flight with --start", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          [
            "new-h1",
            "started task",
            "--kind",
            "ship",
            "--repo",
            "demo",
            "--start",
          ],
          b.ctx,
        );
        // The confirmation line leads with the resulting state.
        expect(out).toContain(
          "ok: added new-h1 (ship, repo demo) -> In flight",
        );
        // State-aware hints never suggest the action --start already performed.
        expect(out).not.toContain("Run `tasks-axi start new-h1`");
        expect(out).toContain("Run `tasks-axi done new-h1 --pr <url>`");
        // In-flight items use firstmate's `- [ ]` checkbox form under the header.
        expect(b.read()).toMatch(/## In flight[\s\S]*- \[ \] new-h1/);
      } finally {
        b.cleanup();
      }
    });

    it("keeps the confirmation-forward output valid TOON", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          [
            "toon-q1",
            "round trips",
            "--kind",
            "ship",
            "--repo",
            "demo",
            "--start",
          ],
          b.ctx,
        );
        // The leading ok: line carries commas (`(ship, repo demo)`) yet the
        // whole block still decodes - it is the human-readable success signal.
        const decoded = decode(out) as { ok: string };
        expect(decoded.ok).toBe("added toon-q1 (ship, repo demo) -> In flight");
      } finally {
        b.cleanup();
      }
    });

    it("confirms a queued add and suggests start, not done", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(["new-q9", "queued task"], b.ctx);
        expect(out).toContain("ok: added new-q9 -> Queued");
        expect(out).toContain("Run `tasks-axi start new-q9`");
        expect(out).not.toContain("Run `tasks-axi done new-q9");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable task with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          [
            "json-q1",
            "json task",
            "--kind",
            "ship",
            "--repo",
            "demo",
            "--json",
          ],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          task: { id: string; state: string; kind: string; repo: string };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("add");
        expect(parsed.task).toMatchObject({
          id: "json-q1",
          state: "queued",
          kind: "ship",
          repo: "demo",
        });
        // --json suppresses the human-readable TOON blocks.
        expect(out).not.toContain("help[");
        expect(out).not.toContain("task:");
      } finally {
        b.cleanup();
      }
    });

    it("uses show --full as the mutation truncation escape hatch", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          ["long-body-q1", "short task", "--body", "x".repeat(600)],
          b.ctx,
        );
        expect(out).toContain("use show long-body-q1 --full");
        expect(out).not.toContain("use --full to see complete text");
      } finally {
        b.cleanup();
      }
    });

    it("rejects conflicting placement flags before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["new-q1", "ambiguous task", "--start", "--queue"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });

    it("mints an id from the title with --mint", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(["a quick note", "--mint"], b.ctx);
        expect(out).toMatch(/id: a-quick-note-[0-9a-f]{2}/);
      } finally {
        b.cleanup();
      }
    });

    it("rejects --prefix without --mint before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["new-q1", "prefixed task", "--prefix", "fm"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string[]]>([
      ["empty", ["--prefix="]],
      ["whitespace", ["--prefix", "   "]],
      ["multiline", ["--prefix", "fm\nops"]],
    ])("rejects a %s prefix while minting", async (_case, flagArgs) => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["prefixed task", "--mint", ...flagArgs], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent for an existing id", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(["lease-adopt", "dup title"], b.ctx);
        expect(out).toContain("already: true");
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string, string[]]>([
      ["bad pr", "dup title", ["--pr", "https://github.com/o/r/issues/9"]],
      ["missing blocker", "dup title", ["--blocked-by", "missing-q1"]],
      ["tag-injecting repo", "dup title", ["--repo", "foo(bar)"]],
      ["tagging title", "dup title (repo: foo)", []],
    ])(
      "rejects %s before duplicate add no-ops",
      async (_case, title, flagArgs) => {
        const b = makeBacklog();
        try {
          await expect(
            addCommand(["lease-adopt", title, ...flagArgs], b.ctx),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
          b.cleanup();
        }
      },
    );

    it("rejects an invalid id", async () => {
      const b = makeBacklog();
      try {
        await expect(addCommand(["Bad Id", "t"], b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });

    it("rejects a blank title before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["blank-q1", "   "], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blank-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a multiline title before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["multi-q1", "first\nsecond"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("multi-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a blank minted title", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["   ", "--mint"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects unknown flags before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["--repoo", "demo", "real-id", "title"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("- [ ] demo - real-id");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["new-q1", "title", "extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid blocked-by id", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["new-q1", "bad dep", "--blocked-by", "bad:id"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad:id");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a missing blocked-by target before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(
            ["new-q1", "bad dep", "--blocked-by", "missing-q1"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
        expect(b.read()).not.toContain("missing-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a self blocked-by edge before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(
            ["new-q1", "self blocked", "--blocked-by", "new-q1"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });

    it("records blocked-by when the target exists", async () => {
      const b = makeBacklog();
      try {
        await addCommand(
          ["new-q1", "blocked work", "--blocked-by", "lease-core-t4"],
          b.ctx,
        );
        expect(b.read()).toContain("new-q1 - blocked work");
        expect(b.read()).toContain("blocked-by: lease-core-t4");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an empty link flag before creating a task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(["new-q1", "linked task", "--pr="], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string[]]>([
      ["--body", ["--body", "   "]],
      ["--repo", ["--repo="]],
      ["--kind", ["--kind", "   "]],
    ])(
      "rejects an empty %s value before creating a task",
      async (_flag, flagArgs) => {
        const b = makeBacklog();
        try {
          await expect(
            addCommand(["new-q1", "metadata task", ...flagArgs], b.ctx),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
          expect(b.read()).not.toContain("new-q1");
        } finally {
          b.cleanup();
        }
      },
    );

    it("persists priority through a fresh read", async () => {
      const b = makeBacklog();
      try {
        await addCommand(["new-q1", "ranked task", "--priority", "2"], b.ctx);
        const out = await showCommand(["new-q1"], b.ctx);
        expect(out).toContain("priority: 2");
        expect(b.read()).toContain("(priority: 2)");
      } finally {
        b.cleanup();
      }
    });

    it("exposes usage help text", () => {
      expect(ADD_HELP).toContain("usage: tasks-axi add");
    });
  });

  describe("list", () => {
    it("bare list is the dispatch view: ready-only one-line rows", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand([], b.ctx);
        expect(out).toMatch(/count: \d+/);
        expect(out).toContain("tasks[");
        expect(out).toContain("{id,state,priority}");
        expect(out).not.toContain("{id,state,kind,repo,priority,title}");
        // only ready work: queued unblocked/unheld tasks, never done or in-flight
        expect(out).not.toContain("owns-widget-h7");
        expect(out).not.toContain("design-scout-d4");
        expect(out).toContain("lease-adopt");
        expect(out).toContain("cert-cleanup");
        expect(() => decode(out)).not.toThrow();
        // the long body is never in list
        expect(out).not.toContain("Follow-up note added later");
      } finally {
        b.cleanup();
      }
    });

    it("bare list excludes blocked queued work", async () => {
      const b = makeBacklog();
      try {
        await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        const out = await listCommand([], b.ctx);
        expect(out).not.toContain("cert-cleanup");
        expect(out).toContain("lease-adopt");
      } finally {
        b.cleanup();
      }
    });

    it("bare list excludes held queued work", async () => {
      const b = makeBacklog();
      try {
        await b.store.update("cert-cleanup", {
          hold: { reason: "captain gate", kind: "captain" },
        });
        const out = await listCommand([], b.ctx);
        expect(out).not.toContain("cert-cleanup");
        expect(out).toContain("lease-adopt");
      } finally {
        b.cleanup();
      }
    });

    it("gives a definitive empty dispatch state", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await listCommand([], b.ctx);
        expect(out).toContain("count: 0");
        expect(out).toContain("0 ready tasks in this backlog");
        expect(() => decode(out)).not.toThrow();
      } finally {
        b.cleanup();
      }
    });

    it("bare list suggests dispatch follow-ups", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand([], b.ctx);
        expect(out).toContain(
          "Run `tasks-axi start <id>` to dispatch one of these",
        );
      } finally {
        b.cleanup();
      }
    });

    it("--all restores the full backlog listing (every state, full schema)", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--all"], b.ctx);
        expect(out).toContain("{id,state,kind,repo,priority,title}");
        expect(out).toContain("owns-widget-h7");
        expect(out).toContain("design-scout-d4");
        expect(() => decode(out)).not.toThrow();
      } finally {
        b.cleanup();
      }
    });

    it("--compact forces one-line rows under any flags", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(
          ["--compact", "--state", "queued"],
          b.ctx,
        );
        expect(out).toContain("{id,state,priority}");
        expect(out).not.toContain("{id,state,kind,repo,priority,title}");
        // the state filter still applies
        expect(out).toContain("lease-adopt");
        expect(out).not.toContain("owns-widget-h7");
      } finally {
        b.cleanup();
      }
    });

    it("filters by state and reports a true total when limited", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(
          ["--state", "queued", "--limit", "2"],
          b.ctx,
        );
        expect(out).toMatch(/count: 2 of \d+ total/);
      } finally {
        b.cleanup();
      }
    });

    it("does not report an empty backlog when a zero limit hides matches", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--limit", "0"], b.ctx);
        expect(out).toMatch(/count: 0 of \d+ total/);
        expect(out).not.toContain("0 tasks in this backlog");
        expect(out).toContain("Run `tasks-axi show <id>`");
      } finally {
        b.cleanup();
      }
    });

    it("uses show --full as the list truncation escape hatch", async () => {
      const b = makeBacklog();
      try {
        await addCommand(["long-title-q1", "x".repeat(100)], b.ctx);
        const out = await listCommand(["--all"], b.ctx);
        expect(out).toContain("use show long-title-q1 --full");
        expect(out).not.toContain("use --full to see complete text");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid state filter", async () => {
      const b = makeBacklog();
      try {
        await expect(
          listCommand(["--state", "in-flight"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string[]]>([
      ["empty repo", ["--repo="]],
      ["whitespace kind", ["--kind", "   "]],
      ["multiline repo", ["--repo", "demo\nops"]],
    ])("rejects a %s filter", async (_case, flagArgs) => {
      const b = makeBacklog();
      try {
        await expect(listCommand(flagArgs, b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });

    it.each(["2abc", "abc", "-1"])(
      "rejects an invalid limit %s",
      async (limit) => {
        const b = makeBacklog();
        try {
          await expect(
            listCommand(["--limit", limit], b.ctx),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
          b.cleanup();
        }
      },
    );

    it("filters to blocked tasks with --blocked", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--blocked"], b.ctx);
        // lease-adopt is blocked-by lease-core-t4 (in_flight elsewhere? it is done? no - t4 is done)
        // build a guaranteed blocked edge first
        await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        const out2 = await listCommand(["--blocked"], b.ctx);
        expect(out2).toContain("cert-cleanup");
        expect(out).not.toContain("Follow-up note added later");
      } finally {
        b.cleanup();
      }
    });

    it("gives a definitive empty state", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await listCommand(["--state", "queued"], b.ctx);
        expect(out).toContain("count: 0");
        expect(out).toContain("0 queued tasks in this backlog");
        expect(() => decode(out)).not.toThrow();
      } finally {
        b.cleanup();
      }
    });

    it("escapes filtered empty states as valid TOON", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await listCommand(["--repo", 'foo: "bar"'], b.ctx);
        expect(out).toContain("repo=foo");
        expect(() => decode(out)).not.toThrow();
      } finally {
        b.cleanup();
      }
    });

    it("carries repo scope into list suggestions", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--repo", "monorepo"], b.ctx);
        expect(out).toContain(
          "Run `tasks-axi ready --repo=monorepo` to see unblocked queued work",
        );
      } finally {
        b.cleanup();
      }
    });

    it("suppresses ready suggestions for kind-filtered lists", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--kind", "ship"], b.ctx);
        expect(out).toContain(
          "Run `tasks-axi show <id>` for full notes on a task",
        );
        expect(out).not.toContain("Run `tasks-axi ready");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an unknown --fields name", async () => {
      const b = makeBacklog();
      try {
        await expect(
          listCommand(["--fields", "bogus"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("adds requested columns via --fields", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(
          ["--fields", "blocked_by,created"],
          b.ctx,
        );
        expect(out).toContain("blocked_by");
        expect(out).toContain("created");
      } finally {
        b.cleanup();
      }
    });

    it("shows the priority column in every list view", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(["p-q1", "ranked", "--priority", "3"], b.ctx);
        const compact = await listCommand([], b.ctx);
        expect(compact).toContain("{id,state,priority}");
        const full = await listCommand(["--all"], b.ctx);
        expect(full).toContain("{id,state,kind,repo,priority,title}");
      } finally {
        b.cleanup();
      }
    });

    it("orders list output by priority, highest first", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(["low-q1", "low", "--priority", "1"], b.ctx);
        await addCommand(["high-q1", "high", "--priority", "4"], b.ctx);
        await addCommand(["mid-q1", "mid", "--priority", "2"], b.ctx);
        await addCommand(["none-q1", "none"], b.ctx);
        const out = await listCommand([], b.ctx);
        const order = ["high-q1", "mid-q1", "low-q1", "none-q1"].map((id) =>
          out.indexOf(id),
        );
        expect(order).toEqual([...order].sort((a, z) => a - z));
        // the file itself keeps insertion order; only the listing is ranked
        expect(b.read().indexOf("low-q1")).toBeLessThan(
          b.read().indexOf("high-q1"),
        );
      } finally {
        b.cleanup();
      }
    });

    it("ranks by priority even under a state filter", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(["low-q1", "low", "--priority", "0"], b.ctx);
        await addCommand(["high-q1", "high", "--priority", "4"], b.ctx);
        const out = await listCommand(["--state", "queued"], b.ctx);
        expect(out.indexOf("high-q1")).toBeLessThan(out.indexOf("low-q1"));
      } finally {
        b.cleanup();
      }
    });
  });

  describe("show", () => {
    it("truncates the body by default and reveals --full", async () => {
      const b = makeBacklog();
      try {
        const out = await showCommand(["owns-widget-h7"], b.ctx);
        expect(out).toContain("id: owns-widget-h7");
        expect(out).toContain("use --full");
        const full = await showCommand(["owns-widget-h7", "--full"], b.ctx);
        expect(full).not.toContain("use --full");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a malformed id as a validation error", async () => {
      const b = makeBacklog();
      try {
        await expect(showCommand(["bad:id"], b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });

    it("errors with NOT_FOUND for an unknown id", async () => {
      const b = makeBacklog();
      try {
        await expect(showCommand(["nope"], b.ctx)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      } finally {
        b.cleanup();
      }
    });

    it("carries explicit globals into not-found help", async () => {
      const b = makeBacklog();
      try {
        await expect(
          showCommand(["nope"], {
            ...b.ctx,
            suggestionGlobals: { file: "other backlog.md" },
          }),
        ).rejects.toMatchObject({
          code: "NOT_FOUND",
          suggestions: [
            "Run `tasks-axi list --all --file='other backlog.md'` to see existing tasks",
          ],
        });
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments", async () => {
      const b = makeBacklog();
      try {
        await expect(
          showCommand(["cert-cleanup", "extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });
  });

  describe("update", () => {
    it("rejects the removed --append flag as unknown", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(
            ["cert-cleanup", "--append", "step 2 in progress"],
            b.ctx,
          ),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          message: "Unknown flag: --append",
        });
        expect(b.read()).not.toContain("\n  step 2 in progress");
      } finally {
        b.cleanup();
      }
    });

    it("replaces the body wholesale", async () => {
      const b = makeBacklog();
      try {
        const out = await updateCommand(
          ["cert-cleanup", "--body", "current status only"],
          b.ctx,
        );
        expect(out).toContain("ok: updated cert-cleanup (body)");
        expect(out).toContain("body: current status only");
        expect(b.read()).toContain("\n  current status only");
      } finally {
        b.cleanup();
      }
    });

    it("archives the superseded body when replacing with --archive-body", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] task-q1 - title\n  old line one\n  old line two\n\n## Done\n",
      );
      try {
        const out = await updateCommand(
          ["task-q1", "--body", "new current body", "--archive-body"],
          b.ctx,
        );
        expect(out).toContain("ok: updated task-q1 (body, archive)");
        expect(b.read()).toContain("\n  new current body");
        expect(b.read()).not.toContain("old line one");
        expect(b.noteArchive()).toContain("## Archived 2026-07-01");
        expect(b.noteArchive()).toContain("- [ ] task-q1 - title");
        expect(b.noteArchive()).toContain("old line one");
        expect(b.noteArchive()).toContain("old line two");
      } finally {
        b.cleanup();
      }
    });

    it("requires a replacement body with --archive-body", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--archive-body"], b.ctx),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          message: "--archive-body requires --body or --body-file",
        });
      } finally {
        b.cleanup();
      }
    });

    it("lists every changed field in the confirmation", async () => {
      const b = makeBacklog();
      try {
        const out = await updateCommand(
          ["cert-cleanup", "--title", "renamed", "--repo", "demo"],
          b.ctx,
        );
        expect(out).toContain("ok: updated cert-cleanup (title, repo)");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable task with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await updateCommand(
          ["cert-cleanup", "--body", "json body", "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          changed: string[];
          task: { id: string };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.changed).toContain("body");
        expect(parsed.task.id).toBe("cert-cleanup");
        expect(out).not.toContain("help[");
      } finally {
        b.cleanup();
      }
    });

    it("reports an unchanged body replacement as already done", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] task-q1 - title\n  current note\n\n## Done\n",
      );
      try {
        const out = await updateCommand(
          ["task-q1", "--body", "current note", "--archive-body", "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          already?: boolean;
          changed: string[];
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.already).toBe(true);
        expect(parsed.changed).toEqual([]);
        expect(b.noteArchive()).toBe("");
      } finally {
        b.cleanup();
      }
    });

    it("requires at least one field", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects a malformed id as a validation error", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["bad:id", "--body", "note"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "extra", "--body", "note"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("\n  note");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a blank replacement title before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--title", "   "], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects a multiline replacement title before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--title", "first\nsecond"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects an empty link flag before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--report", "   "], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
      } finally {
        b.cleanup();
      }
    });

    it.each(["--body", "--repo", "--kind"])(
      "rejects an empty %s value before updating",
      async (flag) => {
        const b = makeBacklog();
        try {
          await expect(
            updateCommand(["cert-cleanup", flag, "   "], b.ctx),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
          expect(b.read()).toContain("(repo: monorepo)");
          expect(b.read()).toContain(
            "- [ ] cert-cleanup - port the post-upload cert pruning",
          );
        } finally {
          b.cleanup();
        }
      },
    );

    it("persists updated priority through a fresh read", async () => {
      const b = makeBacklog();
      try {
        await updateCommand(["cert-cleanup", "--priority", "3"], b.ctx);
        const out = await showCommand(["cert-cleanup"], b.ctx);
        expect(out).toContain("priority: 3");
        expect(b.read()).toContain("(priority: 3)");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("resume token", () => {
    it("persists a resume token through a fresh read and round-trips it", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(
          ["lane-q1", "resumable lane", "--resume", "jcode-sess-abc123"],
          b.ctx,
        );
        expect(b.read()).toContain("(resume: jcode-sess-abc123)");
        const shown = await showCommand(["lane-q1"], b.ctx);
        expect(shown).toContain("resume: jcode-sess-abc123");
        // a re-read parses the tag back onto the task
        const reread = makeBacklog(b.read());
        try {
          const out = await showCommand(["lane-q1"], reread.ctx);
          expect(out).toContain("resume: jcode-sess-abc123");
        } finally {
          reread.cleanup();
        }
      } finally {
        b.cleanup();
      }
    });

    it("surfaces the resume token via --fields resume", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(
          ["lane-q1", "resumable lane", "--resume", "tok-1"],
          b.ctx,
        );
        const out = await listCommand(["--fields", "resume"], b.ctx);
        expect(out).toContain("resume");
        expect(out).toContain("tok-1");
      } finally {
        b.cleanup();
      }
    });

    it("update sets and replaces the resume token", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await addCommand(["lane-q1", "lane"], b.ctx);
        const set = await updateCommand(
          ["lane-q1", "--resume", "tok-first"],
          b.ctx,
        );
        expect(set).toContain("resume");
        expect(b.read()).toContain("(resume: tok-first)");
        const replace = await updateCommand(
          ["lane-q1", "--resume", "tok-second"],
          b.ctx,
        );
        expect(replace).toContain("resume");
        expect(b.read()).toContain("(resume: tok-second)");
        expect(b.read()).not.toContain("tok-first");
        // idempotent when unchanged
        const again = await updateCommand(
          ["lane-q1", "--resume", "tok-second"],
          b.ctx,
        );
        expect(again).toContain("already");
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string]>([
      ["parentheses", "tok(bad)"],
      ["newline", "tok\nbad"],
      ["empty", ""],
    ])("rejects a resume token with %s", async (_case, value) => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await expect(
          addCommand(["lane-q1", "lane", "--resume", value], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("leaves a record with no resume tag unchanged on round-trip", async () => {
      const original = "# Backlog\n\n## Queued\n- [ ] plain-q1 - plain task (kind: ship) (since 2026-07-01)\n\n## Done\n";
      const b = makeBacklog(original);
      try {
        // a read/re-render of an untagged task must not invent a resume tag
        await updateCommand(["plain-q1", "--repo", "demo"], b.ctx);
        expect(b.read()).not.toContain("(resume:");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("rm", () => {
    it("removes a task and confirms", async () => {
      const b = makeBacklog();
      try {
        const out = await rmCommand(["cert-cleanup"], b.ctx);
        expect(out).toContain("ok: removed cert-cleanup");
        expect(b.read()).not.toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable result with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await rmCommand(["cert-cleanup", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          id: string;
          removed: boolean;
        };
        expect(parsed).toMatchObject({
          ok: true,
          action: "rm",
          id: "cert-cleanup",
          removed: true,
        });
        expect(b.read()).not.toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects removing a task that active tasks still block on", async () => {
      const b = makeBacklog();
      try {
        await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        await expect(
          rmCommand(["owns-widget-h7"], b.ctx),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          message: expect.stringContaining("cert-cleanup"),
          suggestions: expect.arrayContaining([
            expect.stringContaining(
              "tasks-axi unblock cert-cleanup --by owns-widget-h7",
            ),
          ]),
        });
        expect(b.read()).toContain("owns-widget-h7");
      } finally {
        b.cleanup();
      }
    });

    it("removes a blocker after dependents are unblocked or done", async () => {
      const unblocked = makeBacklog();
      const completed = makeBacklog();
      try {
        await unblocked.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        await unblocked.store.removeDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        await rmCommand(["owns-widget-h7"], unblocked.ctx);
        expect(unblocked.read()).not.toContain("**owns-widget-h7**");

        await completed.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        await completed.store.transition("cert-cleanup", "done");
        await rmCommand(["owns-widget-h7"], completed.ctx);
        expect(completed.read()).not.toContain("**owns-widget-h7**");
      } finally {
        unblocked.cleanup();
        completed.cleanup();
      }
    });

    it("rejects extra positional arguments before removing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          rmCommand(["cert-cleanup", "extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a malformed id as a validation error", async () => {
      const b = makeBacklog();
      try {
        await expect(rmCommand(["bad:id"], b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });
  });
});
