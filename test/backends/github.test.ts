import { describe, expect, it } from "vitest";
import type {
  GhIssuesClient,
  IssueData,
  IssuePatch,
  LabelPatch,
} from "../../src/backends/gh.js";
import { GithubStore } from "../../src/backends/github.js";
import { BLOCK_END, BLOCK_START } from "../../src/backends/github-body.js";
import { showCommand } from "../../src/commands/crud.js";
import type { TasksContext } from "../../src/context.js";

const NOW = "2026-07-30";
const ISO = "2026-07-30T12:00:00Z";

function managedBody(prose: string, blockLines: string[]): string {
  const block = [BLOCK_START, ...blockLines, BLOCK_END].join("\n");
  return prose === "" ? block : `${prose}\n\n${block}`;
}

/** In-memory GitHub: the store's typed client surface, plus a write log. */
class FakeGh implements GhIssuesClient {
  readonly repo = "o/r";
  issues: IssueData[] = [];
  comments = new Map<number, string[]>();
  calls: string[] = [];
  listCalls = 0;
  failLabelUpdates = false;
  failSubIssueUpdates = false;
  private next = 1;

  seed(partial: Partial<IssueData> & { body: string }): IssueData {
    const issue: IssueData = {
      number: this.next++,
      id: 0,
      title: "a task",
      state: "open",
      stateReason: null,
      labels: [],
      parentNumber: null,
      createdAt: "2026-07-01T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-07-02T00:00:00Z",
      url: "",
      ...partial,
    };
    // Global ids are distinct from issue numbers, as on real GitHub.
    if (issue.id === 0) issue.id = 5000 + issue.number;
    issue.url = `https://github.com/o/r/issues/${issue.number}`;
    this.issues.push(issue);
    return issue;
  }

  findByGlobalId(id: number): IssueData {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) throw new Error(`no issue with global id ${id}`);
    return issue;
  }

  find(number: number): IssueData {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new Error(`no issue #${number}`);
    return issue;
  }

  listIssues(): Promise<IssueData[]> {
    this.listCalls++;
    return Promise.resolve(structuredClone(this.issues));
  }

  createIssue(title: string, body: string): Promise<IssueData> {
    const issue = this.seed({ title, body, createdAt: ISO, updatedAt: ISO });
    this.calls.push(`create #${issue.number}`);
    return Promise.resolve(structuredClone(issue));
  }

  updateIssue(number: number, patch: IssuePatch): Promise<void> {
    const issue = this.find(number);
    this.calls.push(`patch #${number} ${Object.keys(patch).sort().join(",")}`);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state === "closed") {
      issue.state = "closed";
      issue.stateReason = patch.state_reason ?? "completed";
      issue.closedAt = ISO;
    } else if (patch.state === "open") {
      issue.state = "open";
      issue.stateReason = "reopened";
      issue.closedAt = null;
    }
    issue.updatedAt = ISO;
    return Promise.resolve();
  }

  updateLabels(number: number, patch: LabelPatch): Promise<void> {
    const add = [...patch.add].sort();
    const remove = [...patch.remove].sort();
    this.calls.push(
      `labels #${number} +[${add.join(" ")}] -[${remove.join(" ")}]`,
    );
    if (this.failLabelUpdates) {
      return Promise.reject(new Error("label projection unavailable"));
    }
    const issue = this.find(number);
    issue.labels = [
      ...issue.labels.filter((label) => !remove.includes(label)),
      ...add.filter((label) => !issue.labels.includes(label)),
    ];
    return Promise.resolve();
  }

  addComment(number: number, body: string): Promise<void> {
    this.comments.set(number, [...(this.comments.get(number) ?? []), body]);
    return Promise.resolve();
  }

  addSubIssue(
    number: number,
    subIssueId: number,
    replaceParent = false,
  ): Promise<void> {
    this.calls.push(
      `subissue #${number} +${subIssueId}${replaceParent ? " replace" : ""}`,
    );
    if (this.failSubIssueUpdates) {
      return Promise.reject(new Error("sub-issue projection unavailable"));
    }
    this.findByGlobalId(subIssueId).parentNumber = number;
    return Promise.resolve();
  }

  removeSubIssue(number: number, subIssueId: number): Promise<void> {
    this.calls.push(`subissue #${number} -${subIssueId}`);
    if (this.failSubIssueUpdates) {
      return Promise.reject(new Error("sub-issue projection unavailable"));
    }
    this.findByGlobalId(subIssueId).parentNumber = null;
    return Promise.resolve();
  }
}

function makeStore(gh = new FakeGh()): {
  store: GithubStore;
  gh: FakeGh;
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    store: new GithubStore({
      repo: gh.repo,
      client: gh,
      now: () => NOW,
      warn: (message) => warnings.push(message),
    }),
    gh,
    warnings,
  };
}

describe("GithubStore reads", () => {
  it("maps native state + the block state tag onto the model", async () => {
    const gh = new FakeGh();
    gh.seed({
      title: "flying",
      body: managedBody("notes", [
        "(id: fly-1) (state: in-flight) (repo: app) (kind: ship) (priority: 2)",
      ]),
      labels: ["tasks-axi:in-flight"],
    });
    gh.seed({ title: "waiting", body: managedBody("", ["(id: wait-2)"]) });
    gh.seed({
      title: "finished https://github.com/o/r/pull/9",
      body: managedBody("", ["(id: fin-3)"]),
      state: "closed",
      stateReason: "completed",
      closedAt: "2026-07-10T00:00:00Z",
    });
    gh.seed({
      title: "abandoned",
      body: managedBody("", ["(id: drop-4)"]),
      state: "closed",
      stateReason: "duplicate",
      closedAt: "2026-07-11T00:00:00Z",
    });
    gh.seed({ title: "a human-filed issue", body: "no marker here" });
    const { store } = makeStore(gh);

    const { items } = await store.list({});
    expect(items.map((t) => [t.id, t.state])).toEqual([
      ["fly-1", "in_flight"],
      ["wait-2", "queued"],
      ["drop-4", "done"],
      ["fin-3", "done"],
    ]);

    const flying = await store.get("fly-1");
    expect(flying).toMatchObject({
      title: "flying",
      kind: "ship",
      repo: "app",
      priority: 2,
      body: "notes",
      created: "2026-07-01",
      updated: "2026-07-02",
      meta: { issue: 1, url: "https://github.com/o/r/issues/1" },
    });

    const finished = await store.get("fin-3");
    expect(finished?.closed).toBe("2026-07-10");
    expect(finished?.resolution).toBeUndefined();
    expect(finished?.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/9" },
    ]);

    // Closed as duplicate reads as dropped with the exact reason preserved.
    const dropped = await store.get("drop-4");
    expect(dropped?.resolution).toBe("dropped");
    expect(dropped?.meta).toMatchObject({ state_reason: "duplicate" });
  });

  it("memoizes the read for the process lifetime", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    await store.list({});
    await store.get("a-1");
    await store.list({ state: "queued" });
    expect(gh.listCalls).toBe(1);
  });

  it("fails loud on duplicate ids, naming both issue numbers", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: twin-1)"]) });
    gh.seed({ body: managedBody("", ["(id: twin-1)"]) });
    const { store } = makeStore(gh);
    await expect(store.list({})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: 'Duplicate task id "twin-1" in issues #1 and #2',
    });
  });

  it("fails loud on a mangled block, naming the issue", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: ok-1) (priority: 9)"]) });
    const { store } = makeStore(gh);
    await expect(store.list({})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("issue #1") as string,
    });
  });

  it("reports label drift in meta without acting on it", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", ["(id: fly-1) (state: in-flight)"]),
      labels: ["bug"], // a human removed in-flight and the issue has its own label
    });
    const { store } = makeStore(gh);
    const task = await store.get("fly-1");
    expect(task?.state).toBe("in_flight"); // the block, not the chip, is truth
    expect(task?.meta).toMatchObject({ label_drift: true });
  });
});

describe("GithubStore create", () => {
  it("creates a queued issue with the block at the foot and links in the prose", async () => {
    const { store, gh } = makeStore();
    const task = await store.create({
      id: "new-1",
      title: "build the thing",
      body: "some context",
      links: [{ kind: "pr", url: "https://github.com/o/r/pull/3" }],
      kind: "ship",
      priority: 1,
    });
    expect(task.state).toBe("queued");
    expect(task.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/3" },
    ]);
    const issue = gh.find(1);
    expect(issue.title).toBe("build the thing");
    expect(issue.body).toBe(
      managedBody("some context\nhttps://github.com/o/r/pull/3", [
        "(id: new-1) (kind: ship) (priority: 1)",
      ]),
    );
    // Queued with no drift: no label write happens at all.
    expect(gh.calls).toEqual(["create #1"]);
  });

  it("projects the in-flight label for a started create", async () => {
    const { store, gh } = makeStore();
    await store.create({ id: "hot-1", title: "start now", state: "in_flight" });
    expect(gh.find(1).body).toContain("(id: hot-1) (state: in-flight)");
    expect(gh.calls).toContain("labels #1 +[tasks-axi:in-flight] -[]");
  });

  it("writes a (since) override only when created differs from today", async () => {
    const { store, gh } = makeStore();
    await store.create({
      id: "old-1",
      title: "imported",
      created: "2026-01-05",
    });
    await store.create({ id: "new-2", title: "fresh", created: NOW });
    expect(gh.find(1).body).toContain("(id: old-1) (since 2026-01-05)");
    expect(gh.find(2).body).not.toContain("since");
  });

  it("closes immediately for a done create, honoring resolution", async () => {
    const { store, gh } = makeStore();
    await store.create({
      id: "gone-1",
      title: "already dropped",
      state: "done",
      resolution: "dropped",
    });
    expect(gh.find(1)).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
    });
  });

  it("validates ids, duplicates, and dependency targets", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    await expect(
      store.create({ id: "a-1", title: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.create({
        id: "b-2",
        title: "x",
        deps: [{ type: "blocked-by", id: "nope" }],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: 'blocker "nope" not found',
    });
    await expect(
      store.create({
        id: "b-2",
        title: "x",
        deps: [{ type: "blocked-by", id: "b-2" }],
      }),
    ).rejects.toMatchObject({ message: "A task cannot block itself" });
    await expect(
      store.create({ id: "bad id", title: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects reserved marker lines before creating an issue", async () => {
    const { store, gh } = makeStore();
    await expect(
      store.create({ id: "bad-1", title: "x", body: BLOCK_START }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(gh.calls).toEqual([]);
  });

  it("refuses public-followup work outright", async () => {
    const { store } = makeStore();
    await expect(
      store.create({ id: "pf-1", title: "x", kind: "public-followup" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(store.updatePublicFollowup()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("GithubStore transitions", () => {
  it("start sets the block state tag and projects the label", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    const task = await store.transition("a-1", "in_flight");
    expect(task.state).toBe("in_flight");
    expect(gh.find(1).body).toContain("(id: a-1) (state: in-flight)");
    expect(gh.find(1).labels).toEqual(["tasks-axi:in-flight"]);
  });

  it("done closes natively, appends the PR to the prose, and normalizes the state tag away", async () => {
    const gh = new FakeGh();
    gh.seed({
      title: "blocker work",
      body: managedBody("", ["(id: blk-1) (state: in-flight)"]),
      labels: ["tasks-axi:in-flight"],
    });
    gh.seed({
      body: managedBody("", ["(id: dep-2)", "blocked-by: blk-1 - waits on it"]),
      labels: ["tasks-axi:blocked"],
    });
    const { store } = makeStore(gh);

    const task = await store.transition("blk-1", "done", {
      pr: "https://github.com/o/r/pull/42",
      note: "landed cleanly",
    });
    expect(task).toMatchObject({ state: "done", closed: NOW });
    expect(task.resolution).toBeUndefined();
    expect(task.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/42" },
    ]);

    const issue = gh.find(1);
    expect(issue).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(issue.body).toBe(
      managedBody("https://github.com/o/r/pull/42\nlanded cleanly", [
        "(id: blk-1)",
      ]),
    );
    expect(issue.labels).toEqual([]);
    // Completing the blocker clears the dependent's blocked chip in the same command.
    expect(gh.find(2).labels).toEqual([]);
  });

  it("done --dropped closes as not_planned", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    const task = await store.transition("a-1", "done", { dropped: true });
    expect(task.resolution).toBe("dropped");
    expect(gh.find(1)).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
    });
  });

  it("reopen lands in queued and reopens the native issue", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    await store.transition("a-1", "done");
    const task = await store.transition("a-1", "queued");
    expect(task.state).toBe("queued");
    expect(task.closed).toBeUndefined();
    expect(gh.find(1).state).toBe("open");
  });
});

describe("GithubStore hand-edit round-trips (design §5)", () => {
  it("a hand-close is a valid artifact-less done; done backfills attach the artifact and heal the stale tag", async () => {
    const gh = new FakeGh();
    // Hand-closed in the UI: block still carries the in-flight tag.
    gh.seed({
      body: managedBody("", ["(id: a-1) (state: in-flight)"]),
      state: "closed",
      stateReason: "completed",
      closedAt: "2026-07-20T00:00:00Z",
      labels: ["tasks-axi:in-flight"],
    });
    const { store } = makeStore(gh);
    const before = await store.get("a-1");
    expect(before).toMatchObject({ state: "done", closed: "2026-07-20" });
    expect(before?.links).toEqual([]);

    // The idempotent-done backfill path (command layer uses update on Done).
    const { changed } = await store.update("a-1", {
      addLinks: [{ kind: "pr", url: "https://github.com/o/r/pull/7" }],
    });
    expect(changed).toEqual(["links"]);
    const issue = gh.find(1);
    expect(issue.body).toBe(
      managedBody("https://github.com/o/r/pull/7", ["(id: a-1)"]),
    );
    expect(issue.labels).toEqual([]); // stale chip healed by the write
  });

  it("a hand-close as not planned reads as dropped", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", ["(id: a-1)"]),
      state: "closed",
      stateReason: "not_planned",
      closedAt: "2026-07-20T00:00:00Z",
    });
    const { store } = makeStore(gh);
    expect((await store.get("a-1"))?.resolution).toBe("dropped");
  });

  it("a hand-reopen after a tasks-axi done lands queued", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1) (state: in-flight)"]) });
    const first = makeStore(gh);
    await first.store.transition("a-1", "done");

    // Hand-reopen in the UI: only native state flips; the block (normalized on
    // done) has no state tag, so the task lands queued.
    const issue = gh.find(1);
    issue.state = "open";
    issue.stateReason = "reopened";
    issue.closedAt = null;

    const second = makeStore(gh);
    expect((await second.store.get("a-1"))?.state).toBe("queued");
  });

  it("a hand-retitle can never orphan the task", async () => {
    const gh = new FakeGh();
    gh.seed({ title: "old name", body: managedBody("", ["(id: a-1)"]) });
    gh.find(1).title = "totally new name";
    const { store } = makeStore(gh);
    const task = await store.get("a-1");
    expect(task?.title).toBe("totally new name");
  });

  it("any write heals arbitrary label drift while preserving human labels", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", ["(id: fly-1) (state: in-flight)"]),
      labels: ["tasks-axi:blocked", "bug"], // human tidied in-flight away, added blocked
    });
    const { store } = makeStore(gh);
    expect((await store.get("fly-1"))?.meta).toMatchObject({
      label_drift: true,
    });
    gh.find(1).labels.push("triage");

    await store.update("fly-1", { priority: 3 });
    expect(gh.find(1).labels.sort()).toEqual(["bug", "tasks-axi:in-flight", "triage"]);
    expect((await store.get("fly-1"))?.meta?.label_drift).toBeUndefined();
  });

  it("keeps task mutations successful when label projection fails", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    gh.seed({
      body: managedBody("", ["(id: fly-2) (state: in-flight)"]),
      labels: [],
    });
    gh.failLabelUpdates = true;
    const { store, warnings } = makeStore(gh);

    const task = await store.transition("a-1", "in_flight");
    expect(task).toMatchObject({
      state: "in_flight",
      meta: {
        label_drift: true,
        label_projection_degraded: true,
      },
    });
    expect(gh.find(1).body).toContain("(state: in-flight)");
    expect(warnings).toEqual([
      "warning: projection labels degraded on issue #1: label projection unavailable; run tasks-axi render to resync",
      "warning: projection labels degraded on issue #2: label projection unavailable; run tasks-axi render to resync",
    ]);
  });
});

describe("GithubStore update and rm", () => {
  it("rejects meta patches: github meta is derived, not stored", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    await expect(
      store.update("a-1", { meta: { anything: 1 } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("archives a superseded body as an issue comment", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("old prose", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    const { changed } = await store.update("a-1", {
      body: "new prose",
      archiveBody: true,
    });
    expect(changed).toEqual(["body", "archive"]);
    expect(gh.comments.get(1)).toEqual([
      `tasks-axi archived this superseded body on ${NOW}:\n\nold prose`,
    ]);
    expect(gh.find(1).body).toBe(managedBody("new prose", ["(id: a-1)"]));
  });

  it("holds gate through the block and project the held label", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    const { store } = makeStore(gh);
    await store.update("a-1", {
      hold: {
        reason: "captain decision pending",
        kind: "captain",
        until: "2026-08-09",
      },
    });
    expect(gh.find(1).body).toContain(
      "(hold: captain decision pending) (hold-kind: captain) (hold-until: 2026-08-09)",
    );
    expect(gh.find(1).labels).toEqual(["tasks-axi:held"]);

    await store.update("a-1", { hold: null });
    expect(gh.find(1).labels).toEqual([]);
  });

  it("an expired hold-until projects no held label", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", [
        "(id: a-1) (hold: wait) (hold-until: 2026-07-30)",
      ]),
    });
    const { store } = makeStore(gh);
    const task = await store.get("a-1");
    expect(task?.hold).toEqual({ reason: "wait", until: "2026-07-30" });
    expect(task?.meta?.label_drift).toBeUndefined(); // no held label expected today
  });

  it("rm refuses while active dependents exist, then de-manages", async () => {
    const gh = new FakeGh();
    gh.seed({
      title: "the blocker",
      body: managedBody("history prose", ["(id: blk-1) (state: in-flight)"]),
      labels: ["tasks-axi:in-flight", "keeper"],
    });
    gh.seed({ body: managedBody("", ["(id: dep-2)", "blocked-by: blk-1"]) });
    const { store } = makeStore(gh);

    await expect(store.remove("blk-1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: 'Task "blk-1" is still blocking active tasks: dep-2',
    });

    await store.removeDep("dep-2", { type: "blocked-by", id: "blk-1" });
    const removed = await store.remove("blk-1");
    expect(removed.id).toBe("blk-1");

    // De-managed: block stripped, closed as not planned, managed labels gone,
    // title and prose surviving as ordinary issue history.
    const issue = gh.find(1);
    expect(issue).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
      body: "history prose",
      title: "the blocker",
    });
    expect(issue.labels).toEqual(["keeper"]);
    expect(await store.get("blk-1")).toBeNull();
  });

  it("rm refreshes projections for the remaining backlog", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: gone-1)"]) });
    gh.seed({
      body: managedBody("", ["(id: fly-2) (state: in-flight)"]),
      labels: [],
    });
    const { store } = makeStore(gh);

    await store.remove("gone-1");
    expect(gh.find(2).labels).toEqual(["tasks-axi:in-flight"]);
  });

  it("rm warns without failing when projection cleanup degrades", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", ["(id: gone-1)"]),
      labels: ["tasks-axi:held"],
    });
    gh.seed({
      body: managedBody("", ["(id: fly-2) (state: in-flight)"]),
      labels: [],
    });
    gh.failLabelUpdates = true;
    const { store, warnings } = makeStore(gh);

    const removed = await store.remove("gone-1");
    expect(removed.meta).toMatchObject({
      label_drift: true,
      label_projection_degraded: true,
    });
    expect(gh.find(1).state).toBe("closed");
    expect(warnings).toEqual([
      "warning: projection labels degraded on issue #1: label projection unavailable; run tasks-axi render to resync",
      "warning: projection labels degraded on issue #2: label projection unavailable; run tasks-axi render to resync",
    ]);
  });

  it("dependency edges with reasons round-trip through the block", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: a-1)"]) });
    gh.seed({ body: managedBody("", ["(id: b-2)"]) });
    const { store } = makeStore(gh);
    await store.addDep("b-2", {
      type: "blocked-by",
      id: "a-1",
      reason: "waits on the login refactor",
    });
    expect(gh.find(2).body).toContain(
      "blocked-by: a-1 - waits on the login refactor",
    );
    expect(gh.find(2).labels).toEqual(["tasks-axi:blocked"]);

    const again = await store.addDep("b-2", { type: "blocked-by", id: "a-1" });
    expect(again).toBe(false);

    await store.removeDep("b-2", { type: "blocked-by", id: "a-1" });
    expect(gh.find(2).labels).toEqual([]);
  });
});

describe("GithubStore render", () => {
  it("re-renders every block canonically and refreshes every projection", async () => {
    const gh = new FakeGh();
    gh.seed({
      // Hand-reordered tags and drifted labels.
      body: managedBody("prose", ["(kind: ship) (id: a-1) (state: in-flight)"]),
      labels: ["tasks-axi:held"],
    });
    gh.seed({ body: managedBody("", ["(id: b-2)"]) });
    const { store } = makeStore(gh);

    const count = await store.render();
    expect(count).toBe(2);
    expect(gh.find(1).body).toBe(
      managedBody("prose", ["(id: a-1) (state: in-flight) (kind: ship)"]),
    );
    expect(gh.find(1).labels).toEqual(["tasks-axi:in-flight"]);
    // The already-canonical issue is not rewritten.
    expect(gh.calls.filter((c) => c.startsWith("patch #2"))).toEqual([]);
  });
});

describe("github tasks in the CLI detail view", () => {
  it("show surfaces the issue number, url, and drift note from meta", async () => {
    const gh = new FakeGh();
    gh.seed({
      body: managedBody("", ["(id: a-1) (state: in-flight)"]),
      labels: [],
    });
    const { store } = makeStore(gh);
    const ctx: TasksContext = {
      store,
      config: { backend: "github", path: "/dev/null", doneKeep: 10 },
    };
    const output = await showCommand(["a-1"], ctx);
    expect(output).toContain("meta_issue: 1");
    expect(output).toContain('meta_url: "https://github.com/o/r/issues/1"');
    expect(output).toContain("meta_label_drift: true");
  });
});

describe("GithubStore label prefix", () => {
  it("rejects projection label names outside the tasks-axi: namespace", () => {
    const gh = new FakeGh();
    expect(
      () =>
        new GithubStore({
          repo: gh.repo,
          client: gh,
          labels: { inFlight: "wip" },
        }),
    ).toThrow('must carry the "tasks-axi:" prefix');
  });
});

describe("GithubStore native sub-issue projection", () => {
  it("links a created child under its parent by global id", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    const { store } = makeStore(gh);

    await store.create({
      id: "child-c1",
      title: "child work",
      deps: [{ type: "parent", id: "parent-p1" }],
    });

    const child = gh.find(2);
    expect(gh.calls).toContain(`subissue #1 +${child.id}`);
    expect(child.parentNumber).toBe(1);
    // The block stays the source of truth for the edge.
    expect(child.body).toContain("parent: parent-p1");
  });

  it("reparents with replace when the native link points elsewhere", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    gh.seed({ body: managedBody("", ["(id: parent-p2)"]) });
    const child = gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p2"]),
      parentNumber: 1,
    });
    const { store } = makeStore(gh);

    // Any write heals projection drift; a plain metadata update suffices.
    await store.update("child-c1", { priority: 1 });

    expect(gh.calls).toContain(`subissue #2 +${child.id} replace`);
    expect(gh.find(3).parentNumber).toBe(2);
  });

  it("preserves an unmanaged native parent and reports drift", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    gh.seed({ body: "human tracking issue" });
    const child = gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p1"]),
      parentNumber: 2,
    });
    const { store } = makeStore(gh);

    const result = await store.update("child-c1", { priority: 1 });

    expect(child.parentNumber).toBe(2);
    expect(result.task.meta?.parent_drift).toBe(true);
    expect(gh.calls.some((call) => call.startsWith("subissue "))).toBe(false);
  });

  it("unlinks when the parent edge is gone but preserves links to unmanaged issues", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    const orphan = gh.seed({
      body: managedBody("", ["(id: orphan-o1)"]),
      parentNumber: 1,
    });
    // A human linked this managed task under an unmanaged tracking issue.
    gh.seed({ body: "no block: not a task", parentNumber: undefined });
    const human = gh.seed({
      body: managedBody("", ["(id: human-h1)"]),
      parentNumber: 3,
    });
    const { store } = makeStore(gh);

    await store.update("orphan-o1", { priority: 2 });

    expect(gh.calls).toContain(`subissue #1 -${orphan.id}`);
    expect(gh.find(2).parentNumber).toBeNull();
    expect(human.parentNumber).toBe(3);
    expect(gh.calls).not.toContain(`subissue #3 -${human.id}`);
  });

  it("reports parent drift in meta without acting on a read", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p1"]),
    });
    const { store } = makeStore(gh);

    const task = await store.get("child-c1");
    expect(task?.meta?.parent_drift).toBe(true);
    expect(gh.calls).toEqual([]);
  });

  it("de-manage retracts its own link and its children's links", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: grand-g1)"]) });
    const parent = gh.seed({
      body: managedBody("", ["(id: parent-p1)\nparent: grand-g1"]),
      parentNumber: 1,
    });
    const child = gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p1"]),
      parentNumber: 2,
    });
    const { store } = makeStore(gh);

    await store.remove("parent-p1");

    expect(gh.calls).toContain(`subissue #1 -${parent.id}`);
    expect(gh.calls).toContain(`subissue #2 -${child.id}`);
    expect(gh.find(3).parentNumber).toBeNull();
  });

  it("keeps the task managed when required unlinking fails", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    const child = gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p1"]),
      parentNumber: 1,
    });
    gh.failSubIssueUpdates = true;
    const { store, warnings } = makeStore(gh);

    await expect(store.remove("parent-p1")).rejects.toMatchObject({
      code: "UNKNOWN",
      message: 'Could not retract native sub-issue links for task "parent-p1"',
      suggestions: ["Run `tasks-axi rm parent-p1` again to retry"],
    });

    expect(gh.find(1)).toMatchObject({ state: "open" });
    expect(gh.find(1).body).toContain("(id: parent-p1)");
    expect(child.parentNumber).toBe(1);
    expect(gh.calls.some((call) => call.startsWith("patch #1"))).toBe(false);
    expect(warnings).toEqual([]);

    gh.failSubIssueUpdates = false;
    await store.remove("parent-p1");
    expect(gh.find(1)).toMatchObject({ state: "closed" });
    expect(gh.find(1).body).not.toContain("(id: parent-p1)");
    expect(child.parentNumber).toBeNull();
  });

  it("degrades with a warning when the sub-issue write fails", async () => {
    const gh = new FakeGh();
    gh.seed({ body: managedBody("", ["(id: parent-p1)"]) });
    gh.seed({
      body: managedBody("", ["(id: child-c1)\nparent: parent-p1"]),
    });
    gh.failSubIssueUpdates = true;
    const { store, warnings } = makeStore(gh);

    const result = await store.update("child-c1", { priority: 3 });
    expect(result.task.meta?.parent_projection_degraded).toBe(true);
    expect(
      warnings.some((w) => w.includes("sub-issue projection degraded")),
    ).toBe(true);
  });
});
