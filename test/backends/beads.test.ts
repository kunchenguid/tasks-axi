import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBacklog } from "../../src/backends/markdown-grammar.js";
import { parseConfigToml, resolveConfig } from "../../src/config.js";
import { resolveTasksContext } from "../../src/context.js";
import { AxiError } from "../../src/errors.js";
import {
  BD_AVAILABLE,
  makeBeadsBacklog,
  type TempBeadsBacklog,
} from "../beads-helpers.js";
import { BeadsStore } from "../../src/backends/beads.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IT_TIMEOUT = 60_000;
const HOOK_TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// bd-free tests: config + context wiring
// ---------------------------------------------------------------------------

describe("beads config", () => {
  it("parses the [beads] table", () => {
    const config = parseConfigToml(
      ['backend = "beads"', "[beads]", 'dir = "data"', 'bin = "/opt/bd"'].join(
        "\n",
      ),
    );
    expect(config.backend).toBe("beads");
    expect(config.beads).toEqual({ dir: "data", bin: "/opt/bd" });
  });

  it("resolves beads.dir relative to the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-config-"));
    try {
      writeFileSync(
        join(dir, ".tasks.toml"),
        ['backend = "beads"', "[beads]", 'dir = "data"'].join("\n"),
        "utf8",
      );
      const config = resolveConfig({ cwd: dir, home: dir, env: {} });
      expect(config.backend).toBe("beads");
      expect(config.beads?.dir).toBe(join(dir, "data"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a BeadsStore context for backend=beads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-ctx-"));
    try {
      const ctx = resolveTasksContext({
        backend: "beads",
        cwd: dir,
        home: dir,
        env: {},
      });
      expect(ctx.store).toBeInstanceOf(BeadsStore);
      expect(ctx.store.capabilities().backend).toBe("beads");
      expect(ctx.store.capabilities().publicFollowups).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names both backends on an unknown backend", () => {
    expect(() =>
      resolveTasksContext({ backend: "sqlite", cwd: tmpdir(), env: {} }),
    ).toThrowError(/available backends: markdown, beads/);
  });
});

// ---------------------------------------------------------------------------
// Real-bd Store conformance
// ---------------------------------------------------------------------------

describe.skipIf(!BD_AVAILABLE)("BeadsStore CRUD", () => {
  let bl: TempBeadsBacklog;
  beforeAll(() => {
    bl = makeBeadsBacklog();
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "create round-trips every field and writes the mirror",
    async () => {
      const created = await bl.store.create({
        id: "alpha-a1",
        title: "ship the widget",
        kind: "ship",
        repo: "widgets",
        priority: 2,
        body: "first paragraph\n\nsecond paragraph",
      });
      expect(created.state).toBe("queued");
      expect(created.created).toBe("2026-07-01");

      const task = await bl.store.get("alpha-a1");
      expect(task).not.toBeNull();
      expect(task?.title).toBe("ship the widget");
      expect(task?.kind).toBe("ship");
      expect(task?.repo).toBe("widgets");
      expect(task?.priority).toBe(2);
      expect(task?.body).toBe("first paragraph\n\nsecond paragraph");
      expect(task?.created).toBe("2026-07-01");

      const mirror = bl.mirror();
      expect(mirror).toContain("## Queued");
      expect(mirror).toContain(
        "- [ ] alpha-a1 - ship the widget (repo: widgets) (kind: ship) (priority: 2) (since 2026-07-01)",
      );
      expect(mirror).toContain("  first paragraph");
    },
    IT_TIMEOUT,
  );

  it(
    "rejects a duplicate id with CONFLICT",
    async () => {
      await expect(
        bl.store.create({ id: "alpha-a1", title: "again" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
    IT_TIMEOUT,
  );

  it(
    "creates in_flight work under the In flight section",
    async () => {
      await bl.store.create({
        id: "alpha-a2",
        title: "started work",
        state: "in_flight",
      });
      const task = await bl.store.get("alpha-a2");
      expect(task?.state).toBe("in_flight");
      const mirror = bl.mirror();
      const inFlight = mirror.indexOf("## In flight");
      const queued = mirror.indexOf("## Queued");
      const line = mirror.indexOf("- [ ] alpha-a2 - started work");
      expect(line).toBeGreaterThan(inFlight);
      expect(line).toBeLessThan(queued);
    },
    IT_TIMEOUT,
  );

  it(
    "validates create-time deps",
    async () => {
      await expect(
        bl.store.create({
          id: "alpha-a3",
          title: "with dangling dep",
          deps: [{ type: "blocked-by", id: "missing-m1" }],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        bl.store.create({
          id: "alpha-a4",
          title: "self block",
          deps: [{ type: "blocked-by", id: "alpha-a4" }],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const created = await bl.store.create({
        id: "alpha-a5",
        title: "blocked work",
        deps: [{ type: "blocked-by", id: "alpha-a1", reason: "waits on a1" }],
      });
      expect(created.deps).toEqual([
        { type: "blocked-by", id: "alpha-a1", reason: "waits on a1" },
      ]);
      const task = await bl.store.get("alpha-a5");
      expect(task?.deps).toEqual([
        { type: "blocked-by", id: "alpha-a1", reason: "waits on a1" },
      ]);
      expect(bl.mirror()).toContain(
        "- [ ] alpha-a5 - blocked work (since 2026-07-01) blocked-by: alpha-a1 - waits on a1",
      );
    },
    IT_TIMEOUT,
  );

  it(
    "lists with filters and in_flight-first order",
    async () => {
      const { items, total } = await bl.store.list({});
      expect(total).toBeGreaterThanOrEqual(3);
      expect(items[0].id).toBe("alpha-a2");
      const ships = await bl.store.list({ kind: "ship" });
      expect(ships.items.map((t) => t.id)).toEqual(["alpha-a1"]);
      const limited = await bl.store.list({ limit: 1 });
      expect(limited.items).toHaveLength(1);
      expect(limited.total).toBe(total);
    },
    IT_TIMEOUT,
  );

  it(
    "refuses public-followups as unsupported",
    async () => {
      await expect(
        bl.store.create({
          id: "pf-x1",
          title: "promise",
          kind: "public-followup",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(bl.store.updatePublicFollowup()).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    },
    IT_TIMEOUT,
  );

  it(
    "removes an unblocking task and protects a blocking one",
    async () => {
      await expect(bl.store.remove("alpha-a1")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      const removed = await bl.store.remove("alpha-a5");
      expect(removed.id).toBe("alpha-a5");
      expect(await bl.store.get("alpha-a5")).toBeNull();
      const gone = await bl.store.remove("alpha-a1");
      expect(gone.id).toBe("alpha-a1");
      expect(bl.mirror()).not.toContain("alpha-a1");
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore update", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    await bl.store.create({
      id: "upd-u1",
      title: "original title",
      body: "original body",
    });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "updates scalar fields and reports changed",
    async () => {
      const result = await bl.store.update("upd-u1", {
        title: "new title",
        repo: "widgets",
        kind: "scout",
        priority: 1,
      });
      expect(result.changed.sort()).toEqual([
        "kind",
        "priority",
        "repo",
        "title",
      ]);
      const task = await bl.store.get("upd-u1");
      expect(task?.title).toBe("new title");
      expect(task?.repo).toBe("widgets");
      expect(task?.kind).toBe("scout");
      expect(task?.priority).toBe(1);
    },
    IT_TIMEOUT,
  );

  it(
    "treats an identical patch as a no-op",
    async () => {
      const result = await bl.store.update("upd-u1", {
        title: "new title",
        repo: "widgets",
      });
      expect(result.changed).toEqual([]);
    },
    IT_TIMEOUT,
  );

  it(
    "adds body lines without duplicating them",
    async () => {
      const first = await bl.store.update("upd-u1", {
        addBodyLines: ["extra line"],
      });
      expect(first.changed).toEqual(["body"]);
      const second = await bl.store.update("upd-u1", {
        addBodyLines: ["extra line"],
      });
      expect(second.changed).toEqual([]);
      const task = await bl.store.get("upd-u1");
      expect(task?.body).toBe("original body\nextra line");
    },
    IT_TIMEOUT,
  );

  it(
    "archives a superseded body on --archive-body",
    async () => {
      const result = await bl.store.update("upd-u1", {
        body: "curated replacement",
        archiveBody: true,
      });
      expect(result.changed).toContain("archive");
      const task = await bl.store.get("upd-u1");
      expect(task?.body).toBe("curated replacement");
      const archive = bl.noteArchive();
      expect(archive).toContain("## Archived 2026-07-01");
      expect(archive).toContain("original body");
    },
    IT_TIMEOUT,
  );

  it(
    "sets, renders, and clears structured holds",
    async () => {
      await bl.store.update("upd-u1", {
        hold: {
          reason: "captain decision pending",
          kind: "captain",
          until: "2026-08-01",
        },
      });
      let task = await bl.store.get("upd-u1");
      expect(task?.hold).toEqual({
        reason: "captain decision pending",
        kind: "captain",
        until: "2026-08-01",
      });
      expect(bl.mirror()).toContain(
        "(hold: captain decision pending) (hold-kind: captain) (hold-until: 2026-08-01)",
      );
      const cleared = await bl.store.update("upd-u1", { hold: null });
      expect(cleared.changed).toEqual(["hold"]);
      task = await bl.store.get("upd-u1");
      expect(task?.hold).toBeUndefined();
      expect(bl.mirror()).not.toContain("(hold:");
    },
    IT_TIMEOUT,
  );

  it(
    "folds added links into the title",
    async () => {
      const result = await bl.store.update("upd-u1", {
        addLinks: [{ kind: "doc", url: "https://example.com/spec" }],
      });
      expect(result.changed).toEqual(["links"]);
      const task = await bl.store.get("upd-u1");
      expect(task?.title).toBe("new title https://example.com/spec");
      expect(task?.links).toEqual([
        { kind: "doc", url: "https://example.com/spec" },
      ]);
    },
    IT_TIMEOUT,
  );

  it(
    "round-trips meta through bd metadata",
    async () => {
      const result = await bl.store.update("upd-u1", {
        meta: { home: "main", harness: "claude" },
      });
      expect(result.changed).toEqual(["meta"]);
      const task = await bl.store.get("upd-u1");
      expect(task?.meta).toEqual({ home: "main", harness: "claude" });
    },
    IT_TIMEOUT,
  );

  it(
    "keeps an in-flight task in flight when a hold sets or clears --until",
    async () => {
      await bl.store.create({
        id: "upd-u2",
        title: "held in flight",
        state: "in_flight",
      });
      await bl.store.update("upd-u2", {
        hold: { reason: "captain gate", until: "2026-09-01" },
      });
      let task = await bl.store.get("upd-u2");
      expect(task?.state).toBe("in_flight");
      expect(task?.hold).toEqual({
        reason: "captain gate",
        until: "2026-09-01",
      });
      const mirror = bl.mirror();
      const inFlight = mirror.indexOf("## In flight");
      const queued = mirror.indexOf("## Queued");
      const line = mirror.indexOf("- [ ] upd-u2 - held in flight");
      expect(line).toBeGreaterThan(inFlight);
      expect(line).toBeLessThan(queued);

      await bl.store.update("upd-u2", { hold: null });
      task = await bl.store.get("upd-u2");
      expect(task?.state).toBe("in_flight");
      expect(task?.hold).toBeUndefined();
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore transitions and deps", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    await bl.store.create({ id: "flow-f1", title: "the work", created: null });
    await bl.store.create({ id: "flow-f2", title: "the blocker" });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "start backfills the created date",
    async () => {
      const task = await bl.store.transition("flow-f1", "in_flight");
      expect(task.state).toBe("in_flight");
      expect(task.created).toBe("2026-07-01");
      expect((await bl.store.get("flow-f1"))?.state).toBe("in_flight");
    },
    IT_TIMEOUT,
  );

  it(
    "done records the pr link and closed date",
    async () => {
      const task = await bl.store.transition("flow-f1", "done", {
        pr: "https://github.com/owner/repo/pull/42",
        note: "landed cleanly",
      });
      expect(task.state).toBe("done");
      expect(task.closed).toBe("2026-07-01");
      expect(task.links).toEqual([
        { kind: "pr", url: "https://github.com/owner/repo/pull/42" },
      ]);
      expect(task.body).toBe("landed cleanly");
      expect(bl.mirror()).toContain(
        "- [x] flow-f1 - the work https://github.com/owner/repo/pull/42 (merged 2026-07-01)",
      );
    },
    IT_TIMEOUT,
  );

  it(
    "reopen clears the closed date",
    async () => {
      const task = await bl.store.transition("flow-f1", "queued");
      expect(task.state).toBe("queued");
      expect(task.closed).toBeUndefined();
      expect((await bl.store.get("flow-f1"))?.closed).toBeUndefined();
    },
    IT_TIMEOUT,
  );

  it(
    "addDep and removeDep are idempotent with reasons preserved",
    async () => {
      const added = await bl.store.addDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
        reason: "waits on the blocker",
      });
      expect(added).toBe(true);
      const again = await bl.store.addDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(again).toBe(false);
      let task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([
        { type: "blocked-by", id: "flow-f2", reason: "waits on the blocker" },
      ]);
      await expect(
        bl.store.addDep("flow-f1", { type: "blocked-by", id: "missing-m9" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const removed = await bl.store.removeDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(removed).toBe(true);
      const removedAgain = await bl.store.removeDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(removedAgain).toBe(false);
      task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([]);
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore maintenance and mirror", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    for (const [id, closed] of [
      ["old-o1", "2026-06-01"],
      ["old-o2", "2026-06-02"],
      ["old-o3", "2026-06-03"],
    ] as const) {
      await bl.store.create({ id, title: `finished ${id}`, created: null });
      await bl.store.transition(id, "done", { date: closed });
    }
    await bl.store.create({ id: "live-l1", title: "still queued" });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "prune keeps the newest done tasks and archives the surplus",
    async () => {
      const result = await bl.store.prune({
        state: "done",
        keep: 1,
        archive: true,
      });
      expect(result.archived).toBe(2);
      expect(result.ids.sort()).toEqual(["old-o1", "old-o2"]);
      const { items } = await bl.store.list({ state: "done" });
      expect(items.map((t) => t.id)).toEqual(["old-o3"]);
      expect(await bl.store.get("old-o1")).toBeNull();
      const archive = bl.archive();
      expect(archive).toContain("## Archived 2026-07-01");
      expect(archive).toContain(
        "- [x] old-o1 - finished old-o1 (done 2026-06-01)",
      );
      expect(archive).toContain(
        "- [x] old-o2 - finished old-o2 (done 2026-06-02)",
      );
      expect(bl.mirror()).not.toContain("old-o1");
    },
    IT_TIMEOUT,
  );

  it(
    "render rewrites the mirror and reports the task count",
    async () => {
      const count = await bl.store.render();
      expect(count).toBe(2);
    },
    IT_TIMEOUT,
  );

  it(
    "the mirror parses back into the same tasks",
    async () => {
      const doc = parseBacklog(bl.mirror());
      const parsed = doc.sections.flatMap((section) =>
        section.entries.flatMap((entry) =>
          entry.kind === "task" ? [entry.task] : [],
        ),
      );
      const { items } = await bl.store.list({});
      expect(parsed.map((t) => [t.id, t.state, t.title])).toEqual(
        items.map((t) => [t.id, t.state, t.title]),
      );
    },
    IT_TIMEOUT,
  );

  it(
    "reports a missing database as an actionable error",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tasks-axi-nodb-"));
      try {
        const store = new BeadsStore({
          dir,
          mirrorPath: join(dir, "backlog.md"),
        });
        await expect(store.list({})).rejects.toSatisfy((error: unknown) => {
          const axi = error as AxiError;
          return (
            axi.code === "VALIDATION_ERROR" &&
            /no beads database found/.test(axi.message)
          );
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    IT_TIMEOUT,
  );
});
