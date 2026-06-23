import { describe, expect, it } from "vitest";
import { AxiError } from "../../src/errors.js";
import { makeBacklog } from "../helpers.js";

describe("MarkdownStore", () => {
  describe("create / get / list", () => {
    it("creates a queued task and reads it back", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.create({
          id: "new-task-q1",
          title: "a brand new task",
          kind: "ship",
          repo: "demo",
        });
        expect(task.state).toBe("queued");
        const got = await b.store.get("new-task-q1");
        expect(got?.title).toBe("a brand new task");
        expect(got?.repo).toBe("demo");
        expect(b.read()).toContain("- [ ] new-task-q1 - a brand new task");
      } finally {
        b.cleanup();
      }
    });

    it("stamps created for non-done tasks via the injected clock", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.create({ id: "x-q1", title: "t" });
        expect(task.created).toBe("2026-07-01");
        expect(b.read()).toContain("(since 2026-07-01)");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a duplicate id with CONFLICT", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({ id: "lease-adopt", title: "dup" }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects blank titles", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({ id: "blank-q1", title: "   " }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blank-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects multiline titles", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({ id: "multi-q1", title: "first\nsecond" }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("multi-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects repo values that would inject canonical tags", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "inject-q1",
            title: "bad tag",
            repo: "demo) (kind: ship",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("inject-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects out-of-range priority values", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "bad-priority-q1",
            title: "bad priority",
            priority: 7,
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad-priority-q1");
      } finally {
        b.cleanup();
      }
    });

    it("filters list by state, repo, and kind with a true total", async () => {
      const b = makeBacklog();
      try {
        const queued = await b.store.list({ state: "queued" });
        expect(queued.items.every((t) => t.state === "queued")).toBe(true);
        const byRepo = await b.store.list({ repo: "acme" });
        expect(byRepo.items.map((t) => t.id)).toContain("lease-adopt");
        const limited = await b.store.list({ limit: 2 });
        expect(limited.items).toHaveLength(2);
        expect(limited.total).toBeGreaterThan(2);
      } finally {
        b.cleanup();
      }
    });
  });

  describe("safety: untouched lines stay byte-exact", () => {
    it("a single mutation only alters the targeted line", async () => {
      const b = makeBacklog();
      try {
        const before = b.read().split("\n");
        await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        const after = b.read().split("\n");
        // the only original line no longer present is cert-cleanup's bullet
        const removed = before.filter((line) => !after.includes(line));
        expect(removed).toHaveLength(1);
        expect(removed[0]).toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("appending a note leaves all original lines intact", async () => {
      const b = makeBacklog();
      try {
        const before = b.read().split("\n");
        await b.store.update("cert-cleanup", { appendBody: "a note" });
        const after = b.read();
        // no original line is removed; the note is simply added as a continuation
        for (const line of before) expect(after).toContain(line);
        expect(after).toContain("\n  a note");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("update", () => {
    it("appends to the body as a continuation line", async () => {
      const b = makeBacklog();
      try {
        await b.store.update("cert-cleanup", {
          appendBody: "started 2026-07-01",
        });
        expect(b.read()).toContain("\n  started 2026-07-01");
      } finally {
        b.cleanup();
      }
    });

    it("sets repo and kind as canonical tags", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.update("cert-cleanup", {
          repo: "other",
          kind: "docs",
        });
        expect(task.repo).toBe("other");
        expect(task.kind).toBe("docs");
        expect(b.read()).toContain("(repo: other)");
      } finally {
        b.cleanup();
      }
    });

    it("folds an added link into the prose and re-derives links", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.update("cert-cleanup", {
          addLinks: [{ kind: "pr", url: "https://github.com/o/r/pull/9" }],
        });
        expect(task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/9",
        });
        expect(b.read()).toContain("https://github.com/o/r/pull/9");
      } finally {
        b.cleanup();
      }
    });

    it("dedupes added links by exact parsed url, not substring", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] task-q1 - title https://github.com/o/r/pull/10\n\n## Done\n",
      );
      try {
        const task = await b.store.update("task-q1", {
          addLinks: [{ kind: "pr", url: "https://github.com/o/r/pull/1" }],
        });
        expect(task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/10",
        });
        expect(task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/1",
        });
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/10");
        expect(read).toContain("https://github.com/o/r/pull/1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects empty added links before updating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", {
            addLinks: [{ kind: "pr", url: "" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("throws NOT_FOUND for an unknown id", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("nope", { title: "x" }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects blank replacement titles", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", { title: "   " }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects multiline replacement titles", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", { title: "first\r\nsecond" }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects kind values that would split canonical tags", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", { kind: "ship\nscout" }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("ship\nscout");
      } finally {
        b.cleanup();
      }
    });

    it("rejects out-of-range priority updates", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", { priority: 7 }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("(priority: 7)");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("transition", () => {
    it("moves queued -> in_flight and stamps since", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.transition("cert-cleanup", "in_flight");
        expect(task.state).toBe("in_flight");
        const read = b.read();
        expect(read).toMatch(/## In flight[\s\S]*\*\*cert-cleanup\*\*/);
      } finally {
        b.cleanup();
      }
    });

    it("moves to done, records the pr link and a merged stamp", async () => {
      const b = makeBacklog();
      try {
        const task = await b.store.transition("cert-cleanup", "done", {
          pr: "https://github.com/o/r/pull/7",
        });
        expect(task.state).toBe("done");
        expect(task.closed).toBe("2026-07-01");
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/7");
        expect(read).toContain("(merged 2026-07-01)");
      } finally {
        b.cleanup();
      }
    });

    it("records a shorter transition link when a longer one already exists", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] task-q1 - title https://github.com/o/r/pull/10\n\n## Done\n",
      );
      try {
        const task = await b.store.transition("task-q1", "done", {
          pr: "https://github.com/o/r/pull/1",
        });
        expect(task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/10",
        });
        expect(task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/1",
        });
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/10");
        expect(read).toContain("https://github.com/o/r/pull/1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects empty transition links before moving", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.transition("cert-cleanup", "done", { pr: "" }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("places a done task at the top of the Done section", async () => {
      const b = makeBacklog();
      try {
        await b.store.transition("cert-cleanup", "done");
        const lines = b.read().split("\n");
        const doneIdx = lines.findIndex((l) => l.startsWith("## Done"));
        expect(lines[doneIdx + 1]).toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("dependencies", () => {
    it("addDep is idempotent (false on an existing edge)", async () => {
      const b = makeBacklog();
      try {
        const first = await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "lease-core-t4",
        });
        const second = await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "lease-core-t4",
        });
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(b.read()).toContain("blocked-by: lease-core-t4");
      } finally {
        b.cleanup();
      }
    });

    it("removeDep returns false when there is no such edge", async () => {
      const b = makeBacklog();
      try {
        const removed = await b.store.removeDep("cert-cleanup", {
          type: "blocked-by",
          id: "nope",
        });
        expect(removed).toBe(false);
      } finally {
        b.cleanup();
      }
    });

    it("rejects dependency ids that cannot round-trip through markdown", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.addDep("cert-cleanup", {
            type: "blocked-by",
            id: "bad:id",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "new-q1",
            title: "bad dep",
            deps: [{ type: "blocked-by", id: "bad:id" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad:id");
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("prune", () => {
    it("keeps N recent done tasks and archives the rest", async () => {
      const b = makeBacklog();
      try {
        const result = await b.store.prune({
          state: "done",
          keep: 2,
          archive: true,
        });
        expect(result.archived).toBeGreaterThan(0);
        // archived ids include the oldest done tasks
        expect(result.ids).toContain("multi-line-w8");
        expect(b.archive()).toContain("## Archived");
        expect(b.archive()).toContain("multi-line-w8");
        // the live file no longer contains the archived task
        expect(b.read()).not.toContain("- [x] multi-line-w8");
      } finally {
        b.cleanup();
      }
    });

    it("preserves free-form done lines (does not count or archive them)", async () => {
      const b = makeBacklog();
      try {
        await b.store.prune({ state: "done", keep: 0, archive: true });
        // the free-form "PR #31 (contributor)" done line is preserved verbatim
        expect(b.read()).toContain("- [x] PR #31 (contributor) -");
      } finally {
        b.cleanup();
      }
    });

    it("is a no-op when under the keep count", async () => {
      const b = makeBacklog();
      try {
        const result = await b.store.prune({
          state: "done",
          keep: 100,
          archive: true,
        });
        expect(result.archived).toBe(0);
      } finally {
        b.cleanup();
      }
    });
  });

  describe("render", () => {
    it("normalizes every id'd task and returns the count", async () => {
      const b = makeBacklog();
      try {
        const count = await b.store.render();
        expect(count).toBeGreaterThan(0);
        // free-form lines are untouched
        expect(b.read()).toContain("- (status) Mobile ladder");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("capabilities", () => {
    it("advertises the markdown capability set", () => {
      const b = makeBacklog();
      try {
        const caps = b.store.capabilities();
        expect(caps.backend).toBe("markdown");
        expect(caps).toMatchObject({ deps: true, prune: true, customStates: true });
      } finally {
        b.cleanup();
      }
    });
  });

  it("creates sections on first write to an empty file", async () => {
    const b = makeBacklog("");
    try {
      await b.store.create({ id: "first-q1", title: "the first task" });
      const read = b.read();
      expect(read).toContain("## In flight");
      expect(read).toContain("## Queued");
      expect(read).toContain("## Done");
      expect(read).toContain("first-q1");
    } finally {
      b.cleanup();
    }
  });

  it("surfaces an unknown id as null from get", async () => {
    const b = makeBacklog();
    try {
      expect(await b.store.get("does-not-exist")).toBeNull();
    } finally {
      b.cleanup();
    }
  });

  it("uses AxiError for structured failures", async () => {
    const b = makeBacklog();
    try {
      await b.store.remove("nope").catch((e) => {
        expect(e).toBeInstanceOf(AxiError);
      });
    } finally {
      b.cleanup();
    }
  });
});
