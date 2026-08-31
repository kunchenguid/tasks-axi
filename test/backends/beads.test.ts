import { describe, expect, it } from "vitest";
import {
  BeadsStore,
  type BeadsRunner,
} from "../../src/backends/beads.js";

type FakeBead = Record<string, unknown>;

function fakeBd() {
  const beads = new Map<string, FakeBead>();
  const edges: Array<{ issue_id: string; depends_on_id: string; type: string }> = [];
  const run: BeadsRunner = async (_binary, args) => {
    const command = args[0];
    if (command === "create") {
      const id = args[args.indexOf("--id") + 1];
      const title = args[1];
      const description = args.includes("--description")
        ? args[args.indexOf("--description") + 1]
        : "";
      beads.set(id, {
        id,
        title,
        description,
        status: "open",
        priority: 2,
        issue_type: "task",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:00Z",
      });
    } else if (command === "show") {
      const bead = beads.get(args[1]);
      return { stdout: JSON.stringify(bead ? [bead] : []), stderr: "" };
    } else if (command === "list") {
      return { stdout: JSON.stringify([...beads.values()]), stderr: "" };
    } else if (command === "dep") {
      if (args[1] === "list") {
        const ids = args.slice(2).filter((arg) => !arg.startsWith("-"));
        const requested = ids.length === 0 ? edges : edges.filter((edge) => ids.includes(edge.issue_id));
        return { stdout: JSON.stringify(requested), stderr: "" };
      }
      const issue = args[2];
      const target = args[3];
      if (args[1] === "add") edges.push({ issue_id: issue, depends_on_id: target, type: "blocks" });
      if (args[1] === "remove") {
        const index = edges.findIndex((edge) => edge.issue_id === issue && edge.depends_on_id === target);
        if (index >= 0) edges.splice(index, 1);
      }
    } else if (command === "update") {
      const bead = beads.get(args[1]);
      if (!bead) return { stdout: "[]", stderr: "" };
      if (args.includes("--title")) bead.title = args[args.indexOf("--title") + 1];
      if (args.includes("--description")) bead.description = args[args.indexOf("--description") + 1];
      if (args.includes("--status")) bead.status = args[args.indexOf("--status") + 1];
      if (args.includes("--add-label")) bead.labels = ["tasks-axi-held"];
      if (args.includes("--remove-label")) bead.labels = [];
    } else if (command === "close") {
      const bead = beads.get(args[1]);
      if (bead) bead.status = "closed";
    } else if (command === "delete") {
      beads.delete(args[1]);
    }
    return { stdout: "[]", stderr: "" };
  };
  return { run, edges };
}

describe("BeadsStore", () => {
  it("maps beads CRUD, transitions, metadata, and dependencies", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      binary: "/fake/bd",
      prefix: "fm",
      run: fake.run,
    });

    const created = await store.create({
      id: "tasks-axi-beads",
      title: "wire beads",
      body: "notes",
      kind: "ship",
      repo: "tasks-axi",
    });
    expect(created).toMatchObject({
      id: "tasks-axi-beads",
      title: "wire beads",
      body: "notes",
      kind: "ship",
      repo: "tasks-axi",
      state: "queued",
    });

    await store.create({ id: "blocker", title: "blocker" });
    expect(await store.addDep("tasks-axi-beads", { type: "blocked-by", id: "blocker" })).toBe(true);
    expect((await store.get("tasks-axi-beads"))?.deps).toEqual([
      { type: "blocked-by", id: "blocker" },
    ]);
    expect(await store.removeDep("tasks-axi-beads", { type: "blocked-by", id: "blocker" })).toBe(true);

    await store.update("tasks-axi-beads", { hold: { reason: "captain", kind: "captain" } });
    expect((await store.get("tasks-axi-beads"))?.hold).toEqual({ reason: "captain", kind: "captain" });
    const started = await store.transition("tasks-axi-beads", "in_flight");
    expect(started.state).toBe("in_flight");
    const done = await store.transition("tasks-axi-beads", "done", {
      pr: "https://github.com/o/r/pull/1",
    });
    expect(done).toMatchObject({ state: "done", links: [{ kind: "pr" }] });
    expect(await store.list({ state: "done" })).toMatchObject({ total: 1 });
    expect(await store.remove("tasks-axi-beads")).toMatchObject({ id: "tasks-axi-beads" });
  });

  it("reports capabilities and turns missing beads into a null get", async () => {
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: async () => ({ stdout: "[]", stderr: "" }),
    });
    expect(store.capabilities()).toEqual({
      backend: "beads",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: true,
      realtimeSync: false,
      customStates: true,
      serverMintsIds: true,
      publicFollowups: false,
    });
    expect(await store.get("missing")).toBeNull();
  });
});
