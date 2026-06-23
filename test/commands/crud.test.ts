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

    it("mints an id from the title with --mint", async () => {
      const b = makeBacklog();
      try {
        const out = await addCommand(["a quick note", "--mint"], b.ctx);
        expect(out).toMatch(/id: a-quick-note-[0-9a-f]{2}/);
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
        await expect(
          addCommand(["Bad Id", "t"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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
        // the long body is never in list
        expect(out).not.toContain("Follow-up note added later");
      } finally {
        b.cleanup();
      }
    });

    it("filters by state and reports a true total when limited", async () => {
      const b = makeBacklog();
      try {
        const out = await listCommand(["--state", "queued", "--limit", "2"], b.ctx);
        expect(out).toMatch(/count: 2 of \d+ total/);
      } finally {
        b.cleanup();
      }
    });

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
        const out = await listCommand(["--fields", "blocked_by,created"], b.ctx);
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
  });
});
