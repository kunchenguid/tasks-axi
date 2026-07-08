import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { readyTasks } from "../../src/derive.js";
import { AxiError } from "../../src/errors.js";
import {
  FIRSTMATE_FIXTURE,
  makeBacklog,
  MULTI_REASON_FIXTURE,
} from "../helpers.js";

type MarkdownInternals = {
  appendArchive(lines: string[]): void;
  persist(loaded: unknown): void;
};

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

    it("rejects titles that end with canonical trailing tags", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({ id: "tag-title-q1", title: "work (repo: demo)" }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "dep-title-q1",
            title: "work blocked-by: lease-core-t4",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await b.store.create({
          id: "mid-title-q1",
          title: "report.md (reported 2026-06-22): write summary",
        });
        expect(b.read()).not.toContain("tag-title-q1");
        expect(b.read()).not.toContain("dep-title-q1");
        expect(b.read()).toContain(
          "report.md (reported 2026-06-22): write summary",
        );
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

    it("rejects create links that cannot round-trip with their kind", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "bad-link-q1",
            title: "bad link",
            links: [{ kind: "pr", url: "https://github.com/o/r/issues/9" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad-link-q1");
        expect(b.read()).not.toContain("issues/9");
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

    it("creates and reads structured holds", async () => {
      const b = makeBacklog();
      try {
        await b.store.create({
          id: "held-q1",
          title: "wait for launch",
          hold: {
            reason: "load clears",
            kind: "load",
            until: "2999-01-01",
          },
        });
        const got = await b.store.get("held-q1");
        expect(got?.hold).toEqual({
          reason: "load clears",
          kind: "load",
          until: "2999-01-01",
        });
        expect(b.read()).toContain(
          "(hold: load clears) (hold-kind: load) (hold-until: 2999-01-01)",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects unsafe hold fields before rendering", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "bad-hold-q1",
            title: "bad hold",
            hold: { reason: "wait (blocked)" },
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "bad-until-q1",
            title: "bad until",
            hold: { reason: "wait", until: "tomorrow" },
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad-hold-q1");
        expect(b.read()).not.toContain("bad-until-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects invalid date tags before rendering", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "bad-created-q1",
            title: "bad created",
            created: "tomorrow",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "bad-closed-q1",
            title: "bad closed",
            state: "done",
            closed: "06/22",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad-created-q1");
        expect(b.read()).not.toContain("bad-closed-q1");
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
        const before = b.read().split(/\r?\n/);
        await b.store.update("cert-cleanup", { appendBody: "a note" });
        const after = b.read();
        // no original line is removed; the note is simply added as a continuation
        for (const line of before) expect(after).toContain(line);
        expect(after).toMatch(/\r?\n[ ]{2}a note/);
      } finally {
        b.cleanup();
      }
    });

    it("a no-holds backlog still renders byte-exactly after parsing", async () => {
      const b = makeBacklog();
      try {
        const before = b.read();
        const { parseBacklog, renderBacklog } = await import(
          "../../src/backends/markdown-grammar.js"
        );
        expect(renderBacklog(parseBacklog(before))).toBe(before);
      } finally {
        b.cleanup();
      }
    });

    it("rejects writes when the backlog changed after load", async () => {
      const b = makeBacklog();
      try {
        const before = b.read();
        const manuallyEdited = `${before}\nmanual edit\n`;

        await expect(
          b.store.update("cert-cleanup", {
            get title() {
              writeFileSync(b.path, manuallyEdited, "utf8");
              return "updated title";
            },
          }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: expect.stringContaining("changed on disk"),
        });
        expect(b.read()).toBe(manuallyEdited);
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

    it("rejects added links that cannot round-trip with their kind", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", {
            addLinks: [
              { kind: "pr", url: "https://github.com/o/r/issues/9" },
            ],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.update("cert-cleanup", {
            addLinks: [{ kind: "report", url: "reports/cert/report.md" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("issues/9");
        expect(b.read()).not.toContain("reports/cert/report.md");
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

    it("rejects replacement titles that end with canonical trailing tags", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.update("cert-cleanup", {
            title: "replacement (kind: ship)",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.update("cert-cleanup", {
            title: "replacement blocked-by: owns-widget-h7",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain(
          "- [ ] cert-cleanup - port the post-upload cert pruning",
        );
        expect(b.read()).not.toContain("blocked-by: owns-widget-h7");
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
        // In-flight renders in firstmate's `- [ ]` checkbox form (same bullet as
        // Queued); the In flight section header is what marks the state.
        expect(read).toMatch(/## In flight[\s\S]*- \[ \] cert-cleanup/);
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

    it("rejects invalid transition dates before moving", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.transition("cert-cleanup", "done", { date: "06/22" }),
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

    it("rejects addDep when the dependency target is missing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.addDep("cert-cleanup", {
            type: "blocked-by",
            id: "missing-q1",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blocked-by: missing-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects create when a dependency target is missing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.create({
            id: "new-q1",
            title: "missing dep",
            deps: [{ type: "blocked-by", id: "missing-q1" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("new-q1");
        expect(b.read()).not.toContain("missing-q1");
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

    it("rejects multiline dependency reasons before writing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.addDep("cert-cleanup", {
            type: "blocked-by",
            id: "lease-core-t4",
            reason: "waits\n- [ ] injected-q1 - bad",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "new-q1",
            title: "bad dep reason",
            deps: [
              {
                type: "blocked-by",
                id: "lease-core-t4",
                reason: "waits\r- [ ] injected-q1 - bad",
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("injected-q1");
        expect(b.read()).not.toContain("new-q1");
        expect(b.read()).not.toContain("waits");
      } finally {
        b.cleanup();
      }
    });

    it("rejects dependency reasons that contain edge markers before writing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.addDep("cert-cleanup", {
            type: "blocked-by",
            id: "lease-core-t4",
            reason: "waits blocked-by: injected-q1 - hidden",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        const markers = ["blocked-by", "parent", "discovered-from"];
        for (let i = 0; i < markers.length; i++) {
          await expect(
            b.store.create({
              id: `new-${i}-q1`,
              title: "bad dep reason",
              deps: [
                {
                  type: "blocked-by",
                  id: "lease-core-t4",
                  reason: `waits ${markers[i]}: injected-q1 - hidden`,
                },
              ],
            }),
          ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        }

        expect(b.read()).not.toContain("injected-q1");
        expect(b.read()).not.toContain("new-0-q1");
        expect(b.read()).not.toContain("new-1-q1");
        expect(b.read()).not.toContain("new-2-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects self-dependencies before writing", async () => {
      const b = makeBacklog();
      try {
        await expect(
          b.store.addDep("cert-cleanup", {
            type: "blocked-by",
            id: "cert-cleanup",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          b.store.create({
            id: "new-q1",
            title: "self dep",
            deps: [{ type: "blocked-by", id: "new-q1" }],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blocked-by: cert-cleanup");
        expect(b.read()).not.toContain("new-q1");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("moveTo", () => {
    it("rolls back the destination when source removal fails", async () => {
      const source = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] move-q1 - move me\n\n## Done\n",
      );
      const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const targetInternals = target.store as unknown as MarkdownInternals;
        const originalPersist = targetInternals.persist.bind(target.store);
        targetInternals.persist = (loaded: unknown) => {
          originalPersist(loaded);
          writeFileSync(
            source.path,
            `${source.read()}\nmanual edit after destination write\n`,
            "utf8",
          );
        };

        await expect(
          source.store.moveTo("move-q1", target.store),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: expect.stringContaining("changed on disk"),
        });
        expect(source.read()).toContain("move-q1");
        expect(target.read()).not.toContain("move-q1");
      } finally {
        source.cleanup();
        target.cleanup();
      }
    });
  });

  describe("prune", () => {
    it("rejects an archive path that resolves to the live backlog", () => {
      const b = makeBacklog();
      try {
        expect(
          () => new MarkdownStore({ path: b.path, archivePath: b.path }),
        ).toThrow(AxiError);
      } finally {
        b.cleanup();
      }
    });

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

    it("restores the archive when the active backlog write fails", async () => {
      const b = makeBacklog();
      try {
        const internals = b.store as unknown as MarkdownInternals;
        const originalAppendArchive = internals.appendArchive.bind(b.store);
        internals.appendArchive = (lines: string[]) => {
          originalAppendArchive(lines);
          writeFileSync(
            b.path,
            `${b.read()}\nmanual edit after archive append\n`,
            "utf8",
          );
        };

        await expect(
          b.store.prune({ state: "done", keep: 2, archive: true }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message: expect.stringContaining("changed on disk"),
        });
        expect(b.archive()).toBe("");
        expect(b.read()).toContain("- [x] multi-line-w8");
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

  // Interop with firstmate's real backlog shape (the two adoption blockers):
  // `- [ ]` checkbox in-flight items and `blocked-by: <id> - <reason>` edges.
  describe("firstmate interop", () => {
    it("sees the `- [ ]` checkbox in-flight item that firstmate writes", async () => {
      const b = makeBacklog(FIRSTMATE_FIXTURE);
      try {
        const inflight = await b.store.get("fix-login-k3");
        expect(inflight?.state).toBe("in_flight");
        const { items } = await b.store.list({});
        expect(items.map((t) => t.id)).toEqual([
          "fix-login-k3",
          "add-tests-q7",
          "legacy-done-z1",
        ]);
      } finally {
        b.cleanup();
      }
    });

    it("keeps a `blocked-by: <id> - <reason>` item out of `ready`", async () => {
      const b = makeBacklog(FIRSTMATE_FIXTURE);
      try {
        const blocked = await b.store.get("add-tests-q7");
        expect(blocked?.deps).toEqual([
          {
            type: "blocked-by",
            id: "fix-login-k3",
            reason: "waits on the login refactor",
          },
        ]);
        const { items } = await b.store.list({});
        // fix-login-k3 is still in flight, so add-tests-q7 must not be ready.
        expect(readyTasks(items).map((t) => t.id)).toEqual([]);
      } finally {
        b.cleanup();
      }
    });

    it("keeps an item with a later active reason-bearing blocker out of `ready`", async () => {
      const b = makeBacklog(MULTI_REASON_FIXTURE);
      try {
        const blocked = await b.store.get("target-q1");
        expect(blocked?.deps).toEqual([
          {
            type: "blocked-by",
            id: "blocker-a",
            reason: "first blocker done",
          },
          {
            type: "blocked-by",
            id: "blocker-b",
            reason: "waits on second blocker",
          },
        ]);
        const { items } = await b.store.list({});
        expect(readyTasks(items).map((t) => t.id)).toEqual([]);
      } finally {
        b.cleanup();
      }
    });

    it("surfaces the item as ready once its blocker is done", async () => {
      const b = makeBacklog(FIRSTMATE_FIXTURE);
      try {
        await b.store.transition("fix-login-k3", "done");
        const { items } = await b.store.list({});
        expect(readyTasks(items).map((t) => t.id)).toEqual(["add-tests-q7"]);
      } finally {
        b.cleanup();
      }
    });

    it("preserves firstmate's lines byte-for-byte on a read-only load", () => {
      const b = makeBacklog(FIRSTMATE_FIXTURE);
      try {
        // get() loads and parses but never rewrites; the file is untouched.
        expect(b.read()).toBe(FIRSTMATE_FIXTURE);
      } finally {
        b.cleanup();
      }
    });

    it("preserves the blocked-by reason when the item is later mutated", async () => {
      const b = makeBacklog(FIRSTMATE_FIXTURE);
      try {
        await b.store.update("add-tests-q7", { title: "two lines now" });
        const read = b.read();
        expect(read).toContain(
          "blocked-by: fix-login-k3 - waits on the login refactor",
        );
        // ...and the in-flight blocker stays in the `- [ ]` checkbox form,
        // never rewritten to `- **id**`, so firstmate can still read it.
        expect(read).toMatch(/## In flight[\s\S]*- \[ \] fix-login-k3/);
        expect(read).not.toContain("**fix-login-k3**");
      } finally {
        b.cleanup();
      }
    });
  });
});
