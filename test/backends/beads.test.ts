import { describe, expect, it } from "vitest";
import { BeadsStore, type BeadsRunner } from "../../src/backends/beads.js";

type FakeBead = Record<string, unknown>;

function fakeBd(ignore: string[] = []) {
  const beads = new Map<string, FakeBead>();
  const edges: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
  }> = [];
  const run: BeadsRunner = async (_binary, args) => {
    const command = args[0];
    const operation = command === "dep" ? `${command} ${args[1]}` : command;
    if (command === "create") {
      const id = args[args.indexOf("--id") + 1];
      const title = args[1];
      const description = args.includes("--description")
        ? args[args.indexOf("--description") + 1]
        : "";
      beads.set(id, {
        id,
        title,
        description: ignore.includes("create description") ? "" : description,
        status: "open",
        priority: args.includes("--priority")
          ? Number(args[args.indexOf("--priority") + 1])
          : 2,
        issue_type: "task",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:00Z",
        ...(args.includes("--labels")
          ? { labels: args[args.indexOf("--labels") + 1].split(",") }
          : {}),
        ...(args.includes("--defer")
          ? { defer_until: args[args.indexOf("--defer") + 1] }
          : {}),
      });
    } else if (command === "show") {
      const bead = beads.get(args[1]);
      return { stdout: JSON.stringify(bead ? [bead] : []), stderr: "" };
    } else if (command === "list") {
      return { stdout: JSON.stringify([...beads.values()]), stderr: "" };
    } else if (command === "dep") {
      if (args[1] === "list") {
        const ids = args.slice(2).filter((arg) => !arg.startsWith("-"));
        const requested =
          ids.length === 0
            ? edges
            : edges.filter((edge) => ids.includes(edge.issue_id));
        return { stdout: JSON.stringify(requested), stderr: "" };
      }
      const issue = args[2];
      const target = args[3];
      if (args[1] === "add" && !ignore.includes(operation))
        edges.push({ issue_id: issue, depends_on_id: target, type: "blocks" });
      if (args[1] === "remove") {
        const index = edges.findIndex(
          (edge) => edge.issue_id === issue && edge.depends_on_id === target,
        );
        if (index >= 0 && !ignore.includes(operation)) edges.splice(index, 1);
      }
    } else if (command === "update") {
      const bead = beads.get(args[1]);
      if (!bead) return { stdout: "[]", stderr: "" };
      if (ignore.includes(operation)) return { stdout: "[]", stderr: "" };
      if (args.includes("--title"))
        bead.title = args[args.indexOf("--title") + 1];
      if (args.includes("--description"))
        bead.description = args[args.indexOf("--description") + 1];
      if (args.includes("--status"))
        bead.status = args[args.indexOf("--status") + 1];
      if (!ignore.includes("update native")) {
        if (args.includes("--add-label")) bead.labels = ["tasks-axi-held"];
        if (args.includes("--remove-label")) bead.labels = [];
        if (args.includes("--defer"))
          bead.defer_until = args[args.indexOf("--defer") + 1];
      }
    } else if (command === "close") {
      const bead = beads.get(args[1]);
      if (bead && !ignore.includes(operation)) bead.status = "closed";
    } else if (command === "delete") {
      if (!ignore.includes(operation)) beads.delete(args[1]);
    }
    return { stdout: "[]", stderr: "" };
  };
  return { run, edges, beads };
}

function realDepShapeBd() {
  const fake = fakeBd();
  const run: BeadsRunner = async (binary, args, cwd) => {
    if (args[0] === "dep" && args[1] === "list") {
      const owner = args[2];
      return {
        stdout: JSON.stringify(
          fake.edges
            .filter((edge) => edge.issue_id === owner)
            .map((edge) => ({
              id: edge.depends_on_id,
              dependency_type: edge.type,
            })),
        ),
        stderr: "",
      };
    }
    return fake.run(binary, args, cwd);
  };
  return { ...fake, run };
}

describe("BeadsStore", () => {
  it("keeps an explicitly cleared managed body empty", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      prefix: "fm",
      run: fake.run,
    });

    await store.create({ id: "fm-clear-body", title: "clear body" });
    fake.beads.get("fm-clear-body")!.notes = "legacy notes";
    await store.update("fm-clear-body", { repo: "tasks-axi" });
    await store.update("fm-clear-body", { body: "" });

    expect((await store.get("fm-clear-body"))?.body).toBeUndefined();
  });

  it("maps beads CRUD, transitions, metadata, and dependencies", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      binary: "/fake/bd",
      prefix: "fm",
      run: fake.run,
    });

    const created = await store.create({
      id: "fm-tasks-axi-beads",
      title: "wire beads",
      body: "notes",
      kind: "ship",
      repo: "tasks-axi",
    });
    expect(created).toMatchObject({
      id: "fm-tasks-axi-beads",
      title: "wire beads",
      body: "notes",
      kind: "ship",
      repo: "tasks-axi",
      state: "queued",
    });

    await store.create({ id: "fm-blocker", title: "blocker" });
    expect(
      await store.addDep("fm-tasks-axi-beads", {
        type: "blocked-by",
        id: "fm-blocker",
        reason: "waits on refactor",
      }),
    ).toBe(true);
    expect((await store.get("fm-tasks-axi-beads"))?.deps).toEqual([
      { type: "blocked-by", id: "fm-blocker", reason: "waits on refactor" },
    ]);
    await store.update("fm-tasks-axi-beads", { body: "updated notes" });
    expect(
      (await store.list({})).items.find(
        (task) => task.id === "fm-tasks-axi-beads",
      )?.deps,
    ).toEqual([
      { type: "blocked-by", id: "fm-blocker", reason: "waits on refactor" },
    ]);
    expect(
      await store.addDep("fm-tasks-axi-beads", {
        type: "blocked-by",
        id: "fm-blocker",
        reason: "updated reason",
      }),
    ).toBe(false);
    expect((await store.get("fm-tasks-axi-beads"))?.deps).toEqual([
      { type: "blocked-by", id: "fm-blocker", reason: "updated reason" },
    ]);
    expect(
      await store.removeDep("fm-tasks-axi-beads", {
        type: "blocked-by",
        id: "fm-blocker",
      }),
    ).toBe(true);
    expect((await store.get("fm-tasks-axi-beads"))?.deps).toEqual([]);

    await store.update("fm-tasks-axi-beads", {
      hold: { reason: "captain", kind: "captain" },
    });
    expect((await store.get("fm-tasks-axi-beads"))?.hold).toEqual({
      reason: "captain",
      kind: "captain",
    });
    const started = await store.transition("fm-tasks-axi-beads", "in_flight");
    expect(started.state).toBe("in_flight");
    const done = await store.transition("fm-tasks-axi-beads", "done", {
      pr: "https://github.com/o/r/pull/1",
    });
    expect(done).toMatchObject({ state: "done", links: [{ kind: "pr" }] });
    expect(await store.list({ state: "done" })).toMatchObject({ total: 1 });
    expect(await store.remove("fm-tasks-axi-beads")).toMatchObject({
      id: "fm-tasks-axi-beads",
    });
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

  it("recognizes bd's structured missing-issue response", async () => {
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: async () => {
        throw Object.assign(new Error("bd show failed"), {
          stdout: JSON.stringify({
            error: 'no issue found matching "bd-missing"',
          }),
          stderr: "",
        });
      },
    });

    await expect(store.get("bd-missing")).resolves.toBeNull();
  });

  it("validates and verifies dependency mutations", async () => {
    const fake = fakeBd(["dep add"]);
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });
    await store.create({ id: "bd-owner", title: "owner" });
    await store.create({ id: "bd-target", title: "target" });

    await expect(
      store.addDep("bd-owner", { type: "blocked-by", id: "bd-owner" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      store.addDep("bd-owner", { type: "blocked-by", id: "bd-missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      store.addDep("bd-owner", { type: "blocked-by", id: "bd-target" }),
    ).rejects.toThrow("did not persist edge");
  });

  it("validates create dependencies before persisting the owner", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });

    await expect(
      store.create({
        id: "bd-owner",
        title: "owner",
        deps: [{ type: "blocked-by", id: "bd-missing" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.beads.has("bd-owner")).toBe(false);

    await expect(
      store.create({
        id: "bd-self",
        title: "self",
        deps: [{ type: "blocked-by", id: "bd-self" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fake.beads.has("bd-self")).toBe(false);
  });

  it("verifies generic updates and deletion", async () => {
    const fake = fakeBd(["update", "delete"]);
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });
    await store.create({ id: "bd-task", title: "task" });

    await expect(store.update("bd-task", { title: "renamed" })).rejects.toThrow(
      "did not persist requested fields",
    );
    await expect(store.remove("bd-task")).rejects.toThrow("did not remove");
  });

  it("protects blockers with target-only dependent records", async () => {
    const fake = fakeBd();
    const run: BeadsRunner = async (binary, args, cwd) => {
      if (
        args[0] === "dep" &&
        args[1] === "list" &&
        args.includes("--direction") &&
        args.includes("up")
      ) {
        return {
          stdout: JSON.stringify([
            { id: "bd-dependent", dependency_type: "blocks" },
          ]),
          stderr: "",
        };
      }
      return fake.run(binary, args, cwd);
    };
    const store = new BeadsStore({ path: "/tmp/project/.beads", run });
    await store.create({ id: "bd-blocker", title: "blocker" });
    await store.create({ id: "bd-dependent", title: "dependent" });

    await expect(store.remove("bd-blocker")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fake.beads.has("bd-blocker")).toBe(true);
  });

  it.each(["parent-child", "discovered-from"])(
    "allows deletion across incoming %s relationships",
    async (dependencyType) => {
      const fake = fakeBd();
      const run: BeadsRunner = async (binary, args, cwd) => {
        if (
          args[0] === "dep" &&
          args[1] === "list" &&
          args.includes("--direction") &&
          args.includes("up")
        ) {
          return {
            stdout: JSON.stringify([
              { id: "bd-related", dependency_type: dependencyType },
            ]),
            stderr: "",
          };
        }
        return fake.run(binary, args, cwd);
      };
      const store = new BeadsStore({ path: "/tmp/project/.beads", run });
      await store.create({ id: "bd-target", title: "target" });
      await store.create({ id: "bd-related", title: "related" });

      await expect(store.remove("bd-target")).resolves.toMatchObject({
        id: "bd-target",
      });
    },
  );

  it("rejects ids outside the configured beads prefix before creation", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      prefix: "fm",
      run: fake.run,
    });

    await expect(
      store.create({ id: "blocker", title: "blocker" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fake.beads.size).toBe(0);
  });

  it("decodes the target-only shape returned by real bd dep list", async () => {
    const fake = realDepShapeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      prefix: "fm",
      run: fake.run,
    });
    await store.create({ id: "fm-owner", title: "owner" });
    await store.create({ id: "fm-target", title: "target" });

    await expect(
      store.addDep("fm-owner", { type: "blocked-by", id: "fm-target" }),
    ).resolves.toBe(true);
    expect((await store.get("fm-owner"))?.deps).toEqual([
      { type: "blocked-by", id: "fm-target" },
    ]);
  });

  it("verifies transitions and clears dated holds", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });
    await store.create({ id: "bd-held", title: "held" });
    await store.update("bd-held", {
      hold: { reason: "later", until: "2026-09-10" },
    });
    await store.update("bd-held", { hold: { reason: "still held" } });
    expect(fake.beads.get("bd-held")?.defer_until).toBe("");

    await store.create({ id: "bd-native-defer", title: "native defer" });
    const nativeDeferred = fake.beads.get("bd-native-defer");
    if (nativeDeferred) nativeDeferred.defer_until = "2026-10-01";
    await store.update("bd-native-defer", { hold: null });
    expect(nativeDeferred?.defer_until).toBe("");

    await store.create({
      id: "bd-label-drift",
      title: "label drift",
      hold: { reason: "later" },
    });
    const labelDrift = fake.beads.get("bd-label-drift");
    if (labelDrift) labelDrift.labels = [];
    await store.update("bd-label-drift", { hold: { reason: "later" } });
    expect(labelDrift?.labels).toEqual(["tasks-axi-held"]);

    await store.create({ id: "native-defer", title: "native defer" });
    const nativeDeferred = fake.beads.get("native-defer");
    if (nativeDeferred) nativeDeferred.defer_until = "2026-10-01";
    await store.update("native-defer", { hold: null });
    expect(nativeDeferred?.defer_until).toBe("");

    await store.create({ id: "label-drift", title: "label drift", hold: { reason: "later" } });
    const labelDrift = fake.beads.get("label-drift");
    if (labelDrift) labelDrift.labels = [];
    await store.update("label-drift", { hold: { reason: "later" } });
    expect(labelDrift?.labels).toEqual(["tasks-axi-held"]);

    const partial = fakeBd(["update native"]);
    const partialStore = new BeadsStore({
      path: "/tmp/project/.beads",
      run: partial.run,
    });
    await partialStore.create({ id: "bd-partial", title: "partial" });
    await expect(
      partialStore.update("bd-partial", { hold: { reason: "later" } }),
    ).rejects.toThrow("did not persist hold");

    const silent = fakeBd(["update"]);
    const silentStore = new BeadsStore({
      path: "/tmp/project/.beads",
      run: silent.run,
    });
    await silentStore.create({ id: "bd-task", title: "task" });
    await expect(
      silentStore.transition("bd-task", "in_flight"),
    ).rejects.toThrow("did not persist state");
  });

  it("persists native hold state during creation", async () => {
    const fake = fakeBd();
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });
    const task = await store.create({
      id: "bd-held-at-create",
      title: "held",
      hold: { reason: "later", until: "2026-09-10" },
    });

    expect(task).toMatchObject({
      state: "queued",
      hold: { reason: "later", until: "2026-09-10" },
    });
    expect(fake.beads.get("bd-held-at-create")).toMatchObject({
      labels: ["tasks-axi-held"],
      defer_until: "2026-09-10",
    });
  });

  it("rejects creates that omit requested persisted fields", async () => {
    const fake = fakeBd(["create description"]);
    const store = new BeadsStore({
      path: "/tmp/project/.beads",
      run: fake.run,
    });

    await expect(
      store.create({
        id: "bd-incomplete",
        title: "incomplete",
        body: "notes",
        kind: "ship",
        repo: "tasks-axi",
        priority: 1,
        links: [{ kind: "doc", url: "https://example.com/spec" }],
        hold: { reason: "later" },
        meta: { owner: "captain" },
      }),
    ).rejects.toThrow("did not persist requested fields");
  });
});
