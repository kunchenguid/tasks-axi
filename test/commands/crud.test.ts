import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  ADD_HELP,
  LIST_HELP,
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

    it("persists repeatable labels as one canonical sorted token", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          [
            "topic-q1",
            "tagged task",
            "--label",
            "topic:t3",
            "--label",
            "alpha",
            "--label",
            "topic:t3",
          ],
          b.ctx,
        );
        expect(out).toContain("ok: added topic-q1 (labels alpha, topic:t3)");
        expect(b.read()).toContain(
          "- [ ] topic-q1 - tagged task (labels: alpha, topic:t3)",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid label name before creating", async () => {
      const b = makeBacklog();
      try {
        for (const bad of ["Topic", "two words", "a(b)", "a,b"]) {
          await expect(
            addCommand(["bad-label-q1", "work", "--label", bad], b.ctx),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        }
        await expect(
          addCommand(["bad-label-q2", "work", "--label", ""], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad-label");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a label longer than the bounded length", async () => {
      const b = makeBacklog();
      try {
        await expect(
          addCommand(
            ["long-label-q1", "work", "--label", "a".repeat(65)],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await addCommand(
          ["edge-label-q1", "work", "--label", "a".repeat(64)],
          b.ctx,
        );
      } finally {
        b.cleanup();
      }
    });

    it("carries labels in the --json task payload", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(
          ["json-labels-q1", "tagged", "--label", "alpha", "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          task: { labels: string[] };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.task.labels).toEqual(["alpha"]);
      } finally {
        b.cleanup();
      }
    });

    it("exposes usage help text", () => {
      expect(ADD_HELP).toContain("usage: tasks-axi add");
    });
  });

  describe("list", () => {
    it("emits a count line and the default compact schema", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand([], b.ctx);
        expect(out).toMatch(/count: \d+/);
        expect(out).toContain("tasks[");
        expect(out).toContain("{id,state,kind,repo,title}");
        expect(() => decode(out)).not.toThrow();
        // the long body is never in list
        expect(out).not.toContain("Follow-up note added later");
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
        const out = await listCommand([], b.ctx);
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

    it("filters by repeatable --label with AND semantics", async () => {
      const b = makeBacklog();
      try {
        await addCommand(["list-a1", "one tag", "--label", "alpha"], b.ctx);
        await addCommand(
          ["list-ab1", "two tags", "--label", "alpha", "--label", "beta"],
          b.ctx,
        );
        const one = await listCommand(["--label", "alpha"], b.ctx);
        expect(one).toContain("list-a1");
        expect(one).toContain("list-ab1");
        const both = await listCommand(
          ["--label", "alpha", "--label", "beta"],
          b.ctx,
        );
        expect(both).toContain("list-ab1");
        expect(both).not.toContain("list-a1");
        const none = await listCommand(["--label", "gamma"], b.ctx);
        expect(none).toContain("count: 0");
      } finally {
        b.cleanup();
      }
    });

    it("combines a --label filter with --state", async () => {
      const b = makeBacklog();
      try {
        await addCommand(["list-s1", "queued", "--label", "alpha"], b.ctx);
        await addCommand(
          ["list-s2", "started", "--label", "alpha", "--start"],
          b.ctx,
        );
        const out = await listCommand(
          ["--state", "in_flight", "--label", "alpha"],
          b.ctx,
        );
        expect(out).toContain("list-s2");
        expect(out).not.toContain("list-s1");
      } finally {
        b.cleanup();
      }
    });

    it("exposes a labels column via --fields", async () => {
      const b = makeBacklog();
      try {
        await addCommand(
          ["list-f1", "tagged", "--label", "alpha", "--label", "topic:t3"],
          b.ctx,
        );
        const out = await listCommand(["--fields", "labels"], b.ctx);
        expect(() => decode(out)).not.toThrow();
        expect(out).toContain("labels[2]");
        expect(out).toContain('"topic:t3"');
      } finally {
        b.cleanup();
      }
    });

    it("documents the --label flag in help", () => {
      expect(LIST_HELP).toContain("--label");
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

    it("prints labels in the detail record", async () => {
      const b = makeBacklog();
      try {
        await addCommand(
          ["show-l1", "tagged", "--label", "alpha", "--label", "topic:t3"],
          b.ctx,
        );
        const out = await showCommand(["show-l1"], b.ctx);
        expect(() => decode(out)).not.toThrow();
        expect(out).toContain('labels[2]: alpha,"topic:t3"');
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
            "Run `tasks-axi list --file='other backlog.md'` to see existing tasks",
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

    it("adds and removes labels with --label / --unlabel", async () => {
      const b = makeBacklog();
      try {
        await addCommand(
          ["label-update-q1", "tagged", "--label", "alpha"],
          b.ctx,
        );
        const out = await updateCommand(
          ["label-update-q1", "--label", "topic:t3", "--unlabel", "alpha"],
          b.ctx,
        );
        expect(out).toContain("ok: updated label-update-q1 (labels)");
        expect(b.read()).toContain("(labels: topic:t3)");
        expect(b.read()).not.toContain("alpha");
      } finally {
        b.cleanup();
      }
    });

    it("unions repeated --label values into the existing set", async () => {
      const b = makeBacklog();
      try {
        await addCommand(
          ["label-union-q1", "tagged", "--label", "alpha"],
          b.ctx,
        );
        await updateCommand(
          ["label-union-q1", "--label", "topic:t3", "--label", "alpha"],
          b.ctx,
        );
        expect(b.read()).toContain("(labels: alpha, topic:t3)");
      } finally {
        b.cleanup();
      }
    });

    it.each([
      {
        name: "additions",
        initial: ["alpha"],
        first: ["--label", "beta"],
        second: ["--label", "gamma"],
        expected: ["alpha", "beta", "gamma"],
      },
      {
        name: "removals",
        initial: ["alpha", "beta"],
        first: ["--unlabel", "alpha"],
        second: ["--unlabel", "beta"],
        expected: [],
      },
      {
        name: "mixed edits",
        initial: ["alpha", "beta"],
        first: ["--unlabel", "alpha"],
        second: ["--label", "gamma"],
        expected: ["beta", "gamma"],
      },
    ])(
      "preserves concurrent label $name through update",
      async ({ initial, first, second, expected }) => {
        const b = makeBacklog();
        try {
          await b.store.create({
            id: "labels-race",
            title: "work",
            labels: initial,
          });
          const outputs = await Promise.all([
            updateCommand(["labels-race", ...first, "--json"], b.ctx),
            updateCommand(["labels-race", ...second, "--json"], b.ctx),
          ]);
          for (const output of outputs) {
            expect(JSON.parse(output)).toMatchObject({
              ok: true,
              changed: ["labels"],
            });
          }
          expect((await b.store.get("labels-race"))?.labels ?? []).toEqual(
            expected,
          );
        } finally {
          b.cleanup();
        }
      },
    );

    it("rejects --label and --unlabel on the same name", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(
            ["cert-cleanup", "--label", "alpha", "--unlabel", "alpha"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent when --unlabel names an absent label", async () => {
      const b = makeBacklog();
      try {
        const out = await updateCommand(
          ["cert-cleanup", "--unlabel", "absent"],
          b.ctx,
        );
        expect(out).toContain("already: true");
        expect(b.read()).not.toContain("(labels:");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid label name before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--label", "Nope"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          updateCommand(["cert-cleanup", "--unlabel", "a,b"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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
