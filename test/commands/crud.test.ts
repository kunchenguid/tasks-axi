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
        await addCommand(["new-h1", "started task", "--start"], b.ctx);
        expect(b.read()).toMatch(/## In flight[\s\S]*\*\*new-h1\*\*/);
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
        await expect(addCommand(["blank-q1", "   "], b.ctx)).rejects.toMatchObject(
          { code: "VALIDATION_ERROR" },
        );
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
        await expect(addCommand(["   ", "--mint"], b.ctx)).rejects.toMatchObject(
          { code: "VALIDATION_ERROR" },
        );
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
          addCommand(["new-q1", "bad dep", "--blocked-by", "missing-q1"], b.ctx),
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
          addCommand(["new-q1", "self blocked", "--blocked-by", "new-q1"], b.ctx),
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
    it("appends a timestamped note without rewriting the line", async () => {
      const b = makeBacklog();
      try {
        const out = await updateCommand(
          ["cert-cleanup", "--append", "step 2 in progress"],
          b.ctx,
        );
        expect(out).toContain("id: cert-cleanup");
        expect(b.read()).toContain("\n  step 2 in progress");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an empty append before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "--append", "   "], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("\n     ");
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

    it("rejects extra positional arguments before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          updateCommand(["cert-cleanup", "extra", "--append", "note"], b.ctx),
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
        expect(out).toContain("removed:");
        expect(b.read()).not.toContain("cert-cleanup");
      } finally {
        b.cleanup();
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
  });
});
