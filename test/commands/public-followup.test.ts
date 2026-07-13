import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBacklog,
  renderBacklog,
} from "../../src/backends/markdown-grammar.js";
import { publicFollowupCommand } from "../../src/commands/public-followup.js";
import { pruneCommand, renderCommand } from "../../src/commands/maintain.js";
import {
  doneCommand,
  mvCommand,
  readyCommand,
  reopenCommand,
  startCommand,
} from "../../src/commands/state.js";
import { rmCommand, updateCommand } from "../../src/commands/crud.js";
import {
  clonePublicFollowup,
  encodePublicFollowup,
} from "../../src/public-followup.js";
import { makeBacklog, type TempBacklog } from "../helpers.js";

const EMPTY =
  "# Backlog\n\n## In flight\n\n## Queued\n- [ ] ordinary-q1 - ordinary work\n\n## Done\n";

function request(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "req-public-demo",
    platform: "discord",
    context_binding: { version: "ctx1", value: "ctx1_opaque_demo" },
    public_safe_summary: "Follow up when the public-safe fix ships",
    received_at: "2026-07-13T12:00:00Z",
    followup_expires_at: "2026-08-13T12:00:00Z",
    reservation_expires_at: "2026-09-13T12:00:00Z",
    ...overrides,
  };
}

function expected(overrides: Record<string, unknown> = {}) {
  return {
    type: "pr-merged",
    project: "demo",
    required_deliverables: ["pr_url"],
    completion_policy: "all-required",
    ...overrides,
  };
}

function relation(
  relationId = "rel-code",
  taskId = "work-code-q1",
  generation = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    relation_id: relationId,
    work_ref: { home_id: "secondmate:demo", task_id: taskId },
    role: "fulfills",
    required: true,
    generation,
    ...overrides,
  };
}

function event(
  eventId = "evt-code-landed",
  relationId = "rel-code",
  taskId = "work-code-q1",
  generation = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    event_id: eventId,
    obligation_id: "public-final-ab",
    relation_id: relationId,
    generation,
    source_home_id: "secondmate:demo",
    work_id: taskId,
    outcome_type: "pr-merged",
    deliverables: { pr_url: "https://github.com/o/r/pull/519" },
    public_safe_outcome: "The fix merged in PR 519.",
    successor: null,
    occurred_at: "2026-07-14T12:00:00Z",
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    state: "posted",
    request_id: "req-public-demo",
    platform: "discord",
    attempt_count: 1,
    total_chunks: 1,
    posted_chunks: 1,
    posted_at: "2026-07-14T13:00:00Z",
    retain_until: "2026-10-14T13:00:00Z",
    ...overrides,
  };
}

function jsonFile(b: TempBacklog, name: string, value: unknown): string {
  const path = join(b.dir, name);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

async function run(
  b: TempBacklog,
  command: string,
  args: string[],
): Promise<string> {
  return publicFollowupCommand([command, ...args], b.ctx);
}

async function add(
  b: TempBacklog,
  id = "public-final-ab",
  requestValue: unknown = request(),
  expectedValue: unknown = expected(),
): Promise<Record<string, any>> {
  const out = await run(b, "add", [
    id,
    "--request-context-file",
    jsonFile(b, `${id}-request.json`, requestValue),
    "--purpose",
    "promised-final",
    "--expected-final-file",
    jsonFile(b, `${id}-expected.json`, expectedValue),
    "--expires-at",
    "2026-10-01T00:00:00Z",
    "--json",
  ]);
  return JSON.parse(out) as Record<string, any>;
}

async function bind(
  b: TempBacklog,
  value: unknown = relation(),
): Promise<Record<string, any>> {
  return JSON.parse(
    await run(b, "bind-work", [
      "public-final-ab",
      "--relation-file",
      jsonFile(b, `relation-${Math.random()}.json`, value),
      "--json",
    ]),
  ) as Record<string, any>;
}

async function acceptEvent(
  b: TempBacklog,
  value: unknown = event(),
): Promise<Record<string, any>> {
  return JSON.parse(
    await run(b, "work-event", [
      "public-final-ab",
      "--event-file",
      jsonFile(b, `event-${Math.random()}.json`, value),
      "--json",
    ]),
  ) as Record<string, any>;
}

async function makeReady(b: TempBacklog): Promise<void> {
  await add(b);
  await bind(b);
  await acceptEvent(b);
}

async function begin(b: TempBacklog): Promise<Record<string, any>> {
  return JSON.parse(
    await run(b, "begin-delivery", [
      "public-final-ab",
      "--payload-hash",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--json",
    ]),
  ) as Record<string, any>;
}

describe("public-followup commands", () => {
  it("round-trips canonical typed metadata through render, task update, and move", async () => {
    const b = makeBacklog(EMPTY);
    const target = makeBacklog(
      "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
    );
    try {
      const created = await add(b);
      expect(created).toMatchObject({
        ok: true,
        action: "public-followup.add",
        revision: 1,
        task: {
          kind: "public-followup",
          public_followup: {
            schema_version: 1,
            delivery: { state: "intent" },
          },
        },
      });
      const source = b.read();
      expect(source).toContain("(kind: public-followup)");
      expect(source).toContain("<!-- tasks-axi:public-followup/v1:");
      expect(renderBacklog(parseBacklog(source))).toBe(source);

      await updateCommand(["public-final-ab", "--repo", "demo-updated"], b.ctx);
      await renderCommand([], b.ctx);
      const beforeMove = await b.store.get("public-final-ab");
      await mvCommand(["public-final-ab", "--to", target.path], b.ctx);
      const moved = await target.store.get("public-final-ab");
      expect(moved?.repo).toBe("demo-updated");
      expect(moved?.public_followup).toEqual(beforeMove?.public_followup);
      expect(readFileSync(target.path, "utf8")).toContain(
        "<!-- tasks-axi:public-followup/v1:",
      );
    } finally {
      b.cleanup();
      target.cleanup();
    }
  });

  it("models required many-work completion and deduplicates accepted events", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b, relation("rel-code", "work-code-q1"));
      await bind(
        b,
        relation("rel-docs", "work-docs-q1", 1, {
          role: "contributes",
        }),
      );

      const first = await acceptEvent(b);
      expect(first.task.public_followup.delivery.state).toBe("pending-work");
      const duplicate = await acceptEvent(b);
      expect(duplicate.already).toBe(true);
      expect(duplicate.revision).toBe(first.revision);

      const completed = await acceptEvent(
        b,
        event("evt-docs-landed", "rel-docs", "work-docs-q1"),
      );
      expect(completed.task.public_followup.delivery.state).toBe("ready");
      expect(
        completed.task.public_followup.work_relations[0].accepted_event_ids,
      ).toEqual(["evt-code-landed"]);
      expect(
        completed.task.public_followup.work_relations[0].accepted_events[0]
          .deliverables.pr_url,
      ).toBe("https://github.com/o/r/pull/519");
    } finally {
      b.cleanup();
    }
  });

  it("keeps every required relation as an any-required readiness gate", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(
        b,
        "public-final-ab",
        request(),
        expected({ completion_policy: "any-required" }),
      );
      await bind(
        b,
        relation("rel-code", "work-code-q1", 1, { required: false }),
      );
      await bind(
        b,
        relation("rel-docs", "work-docs-q1", 1, {
          role: "contributes",
          required: true,
        }),
      );

      const fulfilled = await acceptEvent(b);
      expect(fulfilled.task.public_followup.delivery.state).toBe(
        "pending-work",
      );
      const completed = await acceptEvent(
        b,
        event("evt-docs-landed", "rel-docs", "work-docs-q1"),
      );
      expect(completed.task.public_followup.delivery.state).toBe("ready");
    } finally {
      b.cleanup();
    }
  });

  it("rejects credential-bearing PR URLs before accepting work", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b);
      await expect(
        acceptEvent(
          b,
          event("evt-unsafe-url", "rel-code", "work-code-q1", 1, {
            deliverables: {
              pr_url: "https://token:secret@github.com/o/r/pull/519",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(
        (await b.store.get("public-final-ab"))?.public_followup?.work_relations,
      ).toMatchObject([{ state: "bound", accepted_events: [] }]);
    } finally {
      b.cleanup();
    }
  });

  it("keeps a failed required relation actionable unless failure is expected", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b);
      const failed = await acceptEvent(
        b,
        event("evt-code-failed", "rel-code", "work-code-q1", 1, {
          outcome_type: "failed",
          deliverables: { error_code: "build-failed" },
          public_safe_outcome: "The work failed before landing.",
        }),
      );
      expect(failed.task.public_followup).toMatchObject({
        delivery: { state: "pending-work" },
        work_relations: [{ state: "failed" }],
      });
      const ready = JSON.parse(await run(b, "ready", ["--json"])) as Record<
        string,
        any
      >;
      expect(ready.count).toBe(0);
    } finally {
      b.cleanup();
    }
  });

  it("supersedes relations by generation and rejects stale predecessor events", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b);
      const successor = relation("rel-code-v2", "work-code-v2", 2);
      const args = [
        "public-final-ab",
        "--relation",
        "rel-code",
        "--successor-file",
        jsonFile(b, "successor.json", successor),
        "--json",
      ];
      const superseded = JSON.parse(
        await run(b, "supersede-work", args),
      ) as Record<string, any>;
      expect(superseded.task.public_followup.work_relations).toMatchObject([
        {
          relation_id: "rel-code",
          state: "superseded",
          successor_relation_id: "rel-code-v2",
        },
        { relation_id: "rel-code-v2", generation: 2, state: "bound" },
      ]);
      const duplicate = JSON.parse(
        await run(b, "supersede-work", args),
      ) as Record<string, any>;
      expect(duplicate.already).toBe(true);

      await expect(acceptEvent(b)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("Stale"),
      });
      const landed = await acceptEvent(
        b,
        event("evt-v2", "rel-code-v2", "work-code-v2", 2),
      );
      expect(landed.task.public_followup.delivery.state).toBe("ready");
      expect(landed.task.public_followup.delivery.delivery_key).toBe(
        superseded.task.public_followup.delivery.delivery_key,
      );
      expect(landed.task.public_followup.obligation_expires_at).toBe(
        "2026-10-01T00:00:00Z",
      );
    } finally {
      b.cleanup();
    }
  });

  it("accepts an atomic successor event and detects conflicting event-id reuse", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b);
      const successor = relation("rel-event-v2", "work-event-v2", 2);
      const supersededEvent = event(
        "evt-superseded",
        "rel-code",
        "work-code-q1",
        1,
        {
          outcome_type: "superseded",
          deliverables: {},
          public_safe_outcome: "The work moved to a successor.",
          successor,
        },
      );
      const accepted = await acceptEvent(b, supersededEvent);
      expect(accepted.task.public_followup.work_relations).toMatchObject([
        {
          relation_id: "rel-code",
          state: "superseded",
          successor_relation_id: "rel-event-v2",
          accepted_event_ids: ["evt-superseded"],
        },
        { relation_id: "rel-event-v2", generation: 2, state: "bound" },
      ]);
      expect((await acceptEvent(b, supersededEvent)).already).toBe(true);
      await expect(
        acceptEvent(b, {
          ...supersededEvent,
          successor: relation("rel-other-v2", "work-other-v2", 2),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      b.cleanup();
    }
  });

  it("supports reverse many-to-many work lookup without blocked-by edges", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await bind(b);
      await add(
        b,
        "public-final-cd",
        request({
          request_id: "req-second",
          context_binding: { version: "ctx1", value: "ctx1_second" },
        }),
      );
      await run(b, "bind-work", [
        "public-final-cd",
        "--relation-file",
        jsonFile(
          b,
          "second-relation.json",
          relation("rel-second", "work-code-q1"),
        ),
        "--json",
      ]);
      const listed = JSON.parse(
        await run(b, "list", [
          "--work-ref",
          "secondmate:demo/work-code-q1",
          "--json",
        ]),
      ) as Record<string, any>;
      expect(listed.count).toBe(2);
      expect(listed.public_followups.map((item: any) => item.id)).toEqual([
        "public-final-ab",
        "public-final-cd",
      ]);
      expect(b.read()).not.toContain("blocked-by:");
    } finally {
      b.cleanup();
    }
  });

  it("keeps worker readiness separate and blocks generic lifecycle bypasses", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await makeReady(b);
      const ready = await readyCommand([], b.ctx);
      expect(ready).toContain("ordinary-q1");
      expect(ready).toContain("ready_public_followups[");
      expect(ready).toContain("public-final-ab");
      const workerGroup = ready.slice(
        0,
        ready.indexOf("ready_public_followups"),
      );
      expect(workerGroup).not.toContain("public-final-ab");
      expect(ready).not.toContain("start public-final-ab");

      for (const command of [
        () => doneCommand(["public-final-ab", "--no-prune"], b.ctx),
        () => startCommand(["public-final-ab"], b.ctx),
        () => rmCommand(["public-final-ab"], b.ctx),
        () => updateCommand(["public-final-ab", "--kind", "ship"], b.ctx),
        () =>
          updateCommand(["public-final-ab", "--body", "unsafe rewrite"], b.ctx),
        () =>
          updateCommand(
            ["public-final-ab", "--title", "unsafe rewrite"],
            b.ctx,
          ),
      ]) {
        await expect(command()).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
      expect((await b.store.get("public-final-ab"))?.state).toBe("queued");
    } finally {
      b.cleanup();
    }
  });

  it("keeps same-backlog operational blockers as delivery gates", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await makeReady(b);
      await b.store.addDep("public-final-ab", {
        type: "blocked-by",
        id: "ordinary-q1",
      });
      const ready = JSON.parse(await run(b, "ready", ["--json"])) as Record<
        string,
        any
      >;
      expect(ready.count).toBe(0);
      await expect(begin(b)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("active blocker"),
      });
      await b.store.removeDep("public-final-ab", {
        type: "blocked-by",
        id: "ordinary-q1",
      });
      expect((await begin(b)).task.public_followup.delivery.state).toBe(
        "delivery-posting",
      );
    } finally {
      b.cleanup();
    }
  });

  it("requires a validated posted receipt, completes atomically, and is idempotent", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await makeReady(b);
      await expect(
        run(b, "record-delivery", [
          "public-final-ab",
          "--receipt-file",
          jsonFile(b, "premature-receipt.json", receipt()),
          "--json",
        ]),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const begun = await begin(b);
      expect(begun.task.public_followup.delivery).toMatchObject({
        state: "delivery-posting",
        attempt_count: 1,
      });
      await expect(
        run(b, "record-delivery", [
          "public-final-ab",
          "--receipt-file",
          jsonFile(b, "bad-receipt.json", receipt({ state: "failed" })),
          "--json",
        ]),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await b.store.get("public-final-ab"))?.state).toBe("queued");

      const args = [
        "public-final-ab",
        "--receipt-file",
        jsonFile(b, "receipt.json", receipt()),
        "--json",
      ];
      const completed = JSON.parse(
        await run(b, "record-delivery", args),
      ) as Record<string, any>;
      expect(completed.task).toMatchObject({
        state: "done",
        public_followup: {
          delivery: { state: "posted", receipt: { state: "posted" } },
        },
      });
      const duplicate = JSON.parse(
        await run(b, "record-delivery", args),
      ) as Record<string, any>;
      expect(duplicate.already).toBe(true);
      expect(duplicate.revision).toBe(completed.revision);
      await expect(
        reopenCommand(["public-final-ab"], b.ctx),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    } finally {
      b.cleanup();
    }
  });

  it("rejects a future-attempt receipt without mutating the obligation", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await makeReady(b);
      await begin(b);
      const before = await b.store.get("public-final-ab");
      const sourceBefore = b.read();
      expect(before?.public_followup?.delivery.attempt_count).toBe(1);

      await expect(
        run(b, "record-delivery", [
          "public-final-ab",
          "--receipt-file",
          jsonFile(b, "future-receipt.json", receipt({ attempt_count: 2 })),
          "--json",
        ]),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("recorded delivery attempt"),
      });

      const after = await b.store.get("public-final-ab");
      expect(b.read()).toBe(sourceBefore);
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        state: "queued",
        public_followup: {
          revision: 4,
          delivery: {
            state: "delivery-posting",
            attempt_count: 1,
            receipt: null,
          },
        },
      });
    } finally {
      b.cleanup();
    }
  });

  it.each([
    {
      state: "unknown",
      errorCode: "transport-ambiguous",
      totalChunks: 1,
      postedChunks: 0,
    },
    {
      state: "partial",
      errorCode: "delivery-partial",
      totalChunks: 2,
      postedChunks: 1,
    },
  ])(
    "accepts a late current-attempt receipt from $state",
    async ({ state, errorCode, totalChunks, postedChunks }) => {
      const b = makeBacklog(EMPTY);
      try {
        await makeReady(b);
        await begin(b);
        await run(b, "record-error", [
          "public-final-ab",
          "--error-file",
          jsonFile(b, `${state}-error.json`, {
            schema_version: 1,
            state,
            error_code: errorCode,
            occurred_at: "2026-07-14T13:01:00Z",
            next_attempt_at: null,
            total_chunks: totalChunks,
            posted_chunks: postedChunks,
          }),
          "--json",
        ]);

        const completed = JSON.parse(
          await run(b, "record-delivery", [
            "public-final-ab",
            "--receipt-file",
            jsonFile(
              b,
              `${state}-late-receipt.json`,
              receipt({
                attempt_count: 1,
                total_chunks: totalChunks,
                posted_chunks: totalChunks,
              }),
            ),
            "--json",
          ]),
        ) as Record<string, any>;
        expect(completed.task).toMatchObject({
          state: "done",
          public_followup: {
            delivery: {
              state: "posted",
              attempt_count: 1,
              receipt: { attempt_count: 1 },
            },
          },
        });
      } finally {
        b.cleanup();
      }
    },
  );

  it("never archives active obligations through section pruning", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await pruneCommand(["--state", "queued", "--keep", "0"], b.ctx);
      expect(await b.store.get("public-final-ab")).not.toBeNull();
      expect(b.archive()).toContain("ordinary-q1");
      expect(b.archive()).not.toContain("public-final-ab");
    } finally {
      b.cleanup();
    }
  });

  it("archives the full typed receipt under normal Done pruning", async () => {
    const b = makeBacklog(EMPTY);
    b.ctx.config.doneKeep = 0;
    try {
      await makeReady(b);
      await begin(b);
      const output = JSON.parse(
        await run(b, "record-delivery", [
          "public-final-ab",
          "--receipt-file",
          jsonFile(b, "archive-receipt.json", receipt()),
          "--json",
        ]),
      ) as Record<string, any>;
      expect(output.pruned).toBe(1);
      expect(await b.store.get("public-final-ab")).toBeNull();
      expect(b.archive()).toContain("public-final-ab");
      expect(b.archive()).toContain("tasks-axi:public-followup/v1:");
      const archivedLine = b
        .archive()
        .split("\n")
        .find((line) => line.includes("tasks-axi:public-followup/v1:"));
      const encoded = archivedLine?.match(/v1:([A-Za-z0-9_-]+)/)?.[1];
      expect(encoded).toBeDefined();
      const decoded = JSON.parse(
        Buffer.from(encoded ?? "", "base64url").toString("utf8"),
      ) as Record<string, any>;
      expect(decoded.delivery.receipt.state).toBe("posted");
    } finally {
      b.cleanup();
    }
  });

  it("allows only an explicit Captain waiver to finish without a receipt", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      await expect(
        run(b, "waive", [
          "public-final-ab",
          "--reason",
          "No safe historical context remains",
          "--approved-by",
          "operator",
          "--json",
        ]),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const waived = JSON.parse(
        await run(b, "waive", [
          "public-final-ab",
          "--reason",
          "No safe historical context remains",
          "--approved-by",
          "captain",
          "--json",
        ]),
      ) as Record<string, any>;
      expect(waived.task).toMatchObject({
        state: "done",
        public_followup: {
          delivery: {
            state: "waived",
            waiver: {
              approved_by: "captain",
              reason: "No safe historical context remains",
            },
          },
        },
      });
    } finally {
      b.cleanup();
    }
  });

  it("records only typed safe delivery errors", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await makeReady(b);
      await begin(b);
      const error = {
        schema_version: 1,
        state: "unknown",
        error_code: "transport-ambiguous",
        occurred_at: "2026-07-14T13:01:00Z",
        next_attempt_at: null,
        total_chunks: 1,
        posted_chunks: 0,
      };
      const result = JSON.parse(
        await run(b, "record-error", [
          "public-final-ab",
          "--error-file",
          jsonFile(b, "error.json", error),
          "--json",
        ]),
      ) as Record<string, any>;
      expect(result.task.public_followup.delivery).toMatchObject({
        state: "unknown",
        last_error_code: "transport-ambiguous",
      });
      await expect(
        run(b, "record-error", [
          "public-final-ab",
          "--error-file",
          jsonFile(b, "unsafe-error.json", {
            ...error,
            raw_platform_response: "private response",
          }),
          "--json",
        ]),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      b.cleanup();
    }
  });

  it("fails closed on malformed, missing, or stale reserved metadata", async () => {
    const malformed = makeBacklog(EMPTY);
    const missing = makeBacklog(EMPTY);
    try {
      await add(malformed);
      writeFileSync(
        malformed.path,
        malformed.read().replace(/v1:[A-Za-z0-9_-]+/, "v1:not-json"),
        "utf8",
      );
      await expect(
        malformed.store.get("public-final-ab"),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });

      await add(missing);
      writeFileSync(
        missing.path,
        missing
          .read()
          .split("\n")
          .filter((line) => !line.includes("tasks-axi:public-followup"))
          .join("\n"),
        "utf8",
      );
      await expect(missing.store.list({})).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("missing public-followup metadata"),
      });
    } finally {
      malformed.cleanup();
      missing.cleanup();
    }
  });

  it("rejects oversized metadata before persistence", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      const task = await b.store.get("public-final-ab");
      if (!task?.public_followup) throw new Error("missing fixture payload");
      const oversized = clonePublicFollowup(task.public_followup);
      oversized.work_relations = Array.from({ length: 7_500 }, (_, index) => ({
        ...relation(`rel-oversized-${index}`, `work-oversized-${index}`),
        state: "bound" as const,
        successor_relation_id: null,
        accepted_event_ids: [],
        accepted_events: [],
      }));
      oversized.delivery.state = "pending-work";
      oversized.revision += 1;

      await expect(
        b.store.updatePublicFollowup("public-final-ab", {
          expectedRevision: task.public_followup.revision,
          expectedPublicFollowup: task.public_followup,
          publicFollowup: oversized,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "public_followup metadata is too large",
      });
      expect((await b.store.get("public-final-ab"))?.public_followup).toEqual(
        task.public_followup,
      );
    } finally {
      b.cleanup();
    }
  });

  it("rejects private or unknown JSON fields and projects only the typed schema", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await expect(
        add(b, "public-final-ab", {
          ...request(),
          raw_request_text: "private incoming text",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const created = await add(b);
      writeFileSync(
        b.path,
        b
          .read()
          .replace(
            /(tasks-axi:public-followup\/v1:[A-Za-z0-9_-]+ -->)/,
            "$1\n  private text must stay out of JSON",
          ),
        "utf8",
      );
      const listed = JSON.parse(await run(b, "list", ["--json"])) as Record<
        string,
        any
      >;
      const serialized = JSON.stringify(listed);
      expect(serialized).not.toContain("raw_request_text");
      expect(serialized).not.toContain("author_id");
      expect(serialized).not.toContain("private text must stay out of JSON");
      expect(listed.public_followups[0].body).toBeNull();
      expect(created.task.public_followup.request).toEqual(request());
      expect(created.task).not.toHaveProperty("meta");
    } finally {
      b.cleanup();
    }
  });

  it("serializes concurrent public and ordinary writers without torn metadata", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      const task = await b.store.get("public-final-ab");
      if (!task?.public_followup) throw new Error("missing fixture payload");
      const first = clonePublicFollowup(task.public_followup);
      first.revision += 1;
      first.work_relations.push({
        ...relation(),
        state: "bound",
        successor_relation_id: null,
        accepted_event_ids: [],
        accepted_events: [],
      });
      first.delivery.state = "pending-work";
      const second = clonePublicFollowup(task.public_followup);
      second.revision += 1;
      second.work_relations.push({
        ...relation("rel-docs", "work-docs-q1", 1, { role: "contributes" }),
        state: "bound",
        successor_relation_id: null,
        accepted_event_ids: [],
        accepted_events: [],
      });
      second.delivery.state = "pending-work";

      const results = await Promise.allSettled([
        b.store.updatePublicFollowup("public-final-ab", {
          expectedRevision: 1,
          expectedPublicFollowup: task.public_followup,
          publicFollowup: first,
        }),
        b.store.updatePublicFollowup("public-final-ab", {
          expectedRevision: 1,
          expectedPublicFollowup: task.public_followup,
          publicFollowup: second,
        }),
        b.store.update("ordinary-q1", { title: "ordinary edit" }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
      });
      const after = await b.store.get("public-final-ab");
      expect(after?.public_followup?.revision).toBe(2);
      expect(after?.public_followup?.work_relations).toHaveLength(1);
      expect((await b.store.get("ordinary-q1"))?.title).toBe("ordinary edit");
      expect(() => parseBacklog(b.read())).not.toThrow();
    } finally {
      b.cleanup();
    }
  });

  it("rejects a same-revision typed hand edit made before lock acquisition", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      const task = await b.store.get("public-final-ab");
      if (!task?.public_followup) throw new Error("missing fixture payload");
      const next = clonePublicFollowup(task.public_followup);
      next.revision += 1;
      next.work_relations.push({
        ...relation(),
        state: "bound",
        successor_relation_id: null,
        accepted_event_ids: [],
        accepted_events: [],
      });
      next.delivery.state = "pending-work";

      const handEdited = clonePublicFollowup(task.public_followup);
      handEdited.request.public_safe_summary = "Different hand-edited promise";
      writeFileSync(
        b.path,
        b
          .read()
          .replace(
            /v1:[A-Za-z0-9_-]+/,
            `v1:${encodePublicFollowup(handEdited)}`,
          ),
        "utf8",
      );
      await expect(
        b.store.updatePublicFollowup("public-final-ab", {
          expectedRevision: 1,
          expectedPublicFollowup: task.public_followup,
          publicFollowup: next,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("changed"),
      });
      expect(
        (await b.store.get("public-final-ab"))?.public_followup?.request
          .public_safe_summary,
      ).toBe("Different hand-edited promise");
    } finally {
      b.cleanup();
    }
  });

  it("detects a source edit inside a public-followup write window", async () => {
    const b = makeBacklog(EMPTY);
    try {
      await add(b);
      const task = await b.store.get("public-final-ab");
      if (!task?.public_followup) throw new Error("missing fixture payload");
      const next = clonePublicFollowup(task.public_followup);
      next.revision += 1;
      next.work_relations.push({
        ...relation(),
        state: "bound",
        successor_relation_id: null,
        accepted_event_ids: [],
        accepted_events: [],
      });
      let edited = false;
      Object.defineProperty(next.delivery, "state", {
        configurable: true,
        enumerable: true,
        get() {
          if (!edited) {
            edited = true;
            writeFileSync(
              b.path,
              `${b.read()}manual concurrent edit\n`,
              "utf8",
            );
          }
          return "pending-work";
        },
      });
      await expect(
        b.store.updatePublicFollowup("public-final-ab", {
          expectedRevision: 1,
          expectedPublicFollowup: task.public_followup,
          publicFollowup: next,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("changed on disk"),
      });
      expect(b.read()).toContain("manual concurrent edit");
    } finally {
      b.cleanup();
    }
  });
});
