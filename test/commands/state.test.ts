import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockCommand,
  doneCommand,
  holdCommand,
  mvCommand,
  readyCommand,
  reopenCommand,
  startCommand,
  unblockCommand,
  unholdCommand,
} from "../../src/commands/state.js";
import { listCommand } from "../../src/commands/crud.js";
import { makeBacklog } from "../helpers.js";

describe("state commands", () => {
  it("rejects malformed primary ids before store lookup", async () => {
    const b = makeBacklog();
    const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
    try {
      const cases = [
        () => startCommand(["bad:id"], b.ctx),
        () => doneCommand(["bad:id", "--no-prune"], b.ctx),
        () => reopenCommand(["bad:id"], b.ctx),
        () => blockCommand(["bad:id", "--by", "owns-widget-h7"], b.ctx),
        () => unblockCommand(["bad:id", "--by", "owns-widget-h7"], b.ctx),
        () => holdCommand(["bad:id", "--reason", "wait"], b.ctx),
        () => unholdCommand(["bad:id"], b.ctx),
        () => mvCommand(["bad:id", "--to", target.path], b.ctx),
      ];
      for (const run of cases) {
        await expect(run()).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
    } finally {
      b.cleanup();
      target.cleanup();
    }
  });

  describe("start", () => {
    it("moves a task to in_flight", async () => {
      const b = makeBacklog();
      try {
        const out = await startCommand(["cert-cleanup"], b.ctx);
        expect(out).toContain("ok: start cert-cleanup -> In flight");
        expect(out).toContain("Run `tasks-axi done cert-cleanup --pr <url>`");
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent when already in_flight", async () => {
      const b = makeBacklog();
      try {
        await startCommand(["cert-cleanup"], b.ctx);
        const out = await startCommand(["cert-cleanup"], b.ctx);
        expect(out).toContain("already: true");
        expect(out).toContain("ok: start cert-cleanup already in flight");
        // Even on a no-op, the hint reflects the post-op state (done, not start).
        expect(out).toContain("Run `tasks-axi done cert-cleanup --pr <url>`");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable task with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await startCommand(["cert-cleanup", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          task: { id: string; state: string };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("start");
        expect(parsed.task).toMatchObject({
          id: "cert-cleanup",
          state: "in_flight",
        });
        expect(out).not.toContain("help[");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments before mutating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          startCommand(["cert-cleanup", "extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("done", () => {
    it("closes, records the pr, and reports pruned count", async () => {
      const b = makeBacklog();
      try {
        const out = await doneCommand(
          [
            "cert-cleanup",
            "--pr",
            "https://github.com/o/r/pull/9",
            "--no-prune",
          ],
          b.ctx,
        );
        expect(out).toContain(
          "done cert-cleanup -> Done (pr https://github.com/o/r/pull/9)",
        );
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/9");
        expect(read).toContain("(merged 2026-07-01)");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable task and pruned count with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await doneCommand(
          [
            "cert-cleanup",
            "--pr",
            "https://github.com/o/r/pull/9",
            "--no-prune",
            "--json",
          ],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          pruned: number;
          task: {
            id: string;
            state: string;
            links: { kind: string; url: string }[];
          };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("done");
        expect(parsed.pruned).toBe(0);
        expect(parsed.task.state).toBe("done");
        expect(parsed.task.links).toContainEqual({
          kind: "pr",
          url: "https://github.com/o/r/pull/9",
        });
      } finally {
        b.cleanup();
      }
    });

    it("prunes and archives by default to the configured keep", async () => {
      const b = makeBacklog(undefined, "2026-07-01");
      try {
        await doneCommand(["cert-cleanup", "--keep", "2"], b.ctx);
        expect(b.archive()).toContain("## Archived");
      } finally {
        b.cleanup();
      }
    });

    it("retries prune when the task is already done", async () => {
      const b = makeBacklog(undefined, "2026-07-01");
      const archivePath = join(b.dir, "done-archive.md");
      try {
        mkdirSync(archivePath);
        await expect(
          doneCommand(["cert-cleanup", "--keep", "2"], b.ctx),
        ).rejects.toThrow(/EISDIR/);
        expect(b.read()).toContain("- [x] cert-cleanup");

        rmSync(archivePath, { recursive: true, force: true });
        const out = await doneCommand(["cert-cleanup", "--keep", "2"], b.ctx);
        expect(out).toContain("already: true");
        expect(out).toMatch(/; pruned [1-9]/);
        expect(b.archive()).toContain("## Archived");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a missing value before consuming the next flag", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(["cert-cleanup", "--pr", "--no-prune"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
        expect(b.read()).not.toContain("--no-prune");
        expect(b.archive()).toBe("");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an empty link flag before closing the task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(["cert-cleanup", "--pr=", "--no-prune"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
        expect(b.read()).not.toContain("- [x] cert-cleanup");
        expect(b.archive()).toBe("");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a malformed pr link before closing the task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(
            ["cert-cleanup", "--pr", "https://github.com/o/r/issues/9"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
        expect(b.read()).not.toContain("issues/9");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a whitespace note before closing the task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(["cert-cleanup", "--note", "   ", "--no-prune"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects unknown flags before closing the task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(["cert-cleanup", "--prr", "url"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects negative keep before closing the task", async () => {
      const b = makeBacklog();
      try {
        await expect(
          doneCommand(["cert-cleanup", "--keep", "-1"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [ ] cert-cleanup");
        expect(b.archive()).toBe("");
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent when already done", async () => {
      const b = makeBacklog();
      try {
        const out = await doneCommand(["lease-core-t4"], b.ctx);
        expect(out).toContain("already: true");
      } finally {
        b.cleanup();
      }
    });

    it("backfills metadata on an already done task without pruning", async () => {
      const b = makeBacklog();
      try {
        const out = await doneCommand(
          [
            "lease-core-t4",
            "--pr",
            "https://github.com/o/r/pull/77",
            "--note",
            "backfilled review evidence",
            "--keep",
            "0",
            "--no-prune",
          ],
          b.ctx,
        );
        expect(out).toContain("already: true");
        expect(out).toContain("https://github.com/o/r/pull/77");
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/77");
        expect(read).toContain("backfilled review evidence");
        expect(read).toContain("(merged 2026-06-22)");
        expect(read).not.toContain("(merged 2026-07-01)");
        expect(b.archive()).toBe("");
      } finally {
        b.cleanup();
      }
    });

    it("preserves body edits made before an already-done note update", async () => {
      const b = makeBacklog();
      try {
        const originalUpdate = b.store.update.bind(
          b.store,
        ) as typeof b.store.update;
        let injected = false;
        b.store.update = async (taskId, patch) => {
          if (!injected) {
            injected = true;
            writeFileSync(
              b.path,
              b
                .read()
                .replace(
                  /^(- \[x\] lease-core-t4 - .*)$/m,
                  "$1\n  concurrent audit note",
                ),
              "utf8",
            );
          }
          return originalUpdate(taskId, patch);
        };

        await doneCommand(
          [
            "lease-core-t4",
            "--note",
            "backfilled review evidence",
            "--no-prune",
          ],
          b.ctx,
        );

        const read = b.read();
        expect(read).toContain("concurrent audit note");
        expect(read).toContain("backfilled review evidence");
      } finally {
        b.cleanup();
      }
    });

    it("does not duplicate an already-done note on retry", async () => {
      const b = makeBacklog();
      try {
        await doneCommand(
          ["lease-core-t4", "--note", "retry-safe note", "--no-prune"],
          b.ctx,
        );
        await doneCommand(
          ["lease-core-t4", "--note", "retry-safe note", "--no-prune"],
          b.ctx,
        );
        expect(b.read().match(/retry-safe note/g)).toHaveLength(1);
      } finally {
        b.cleanup();
      }
    });

    it("does not rewrite when an already-done note already exists", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Done\n- [x] done-q1 - manually spaced title   (done 2026-07-01)\n  retry-safe note\n\n",
      );
      try {
        const before = b.read();
        const out = await doneCommand(
          ["done-q1", "--note", "retry-safe note", "--no-prune"],
          b.ctx,
        );
        expect(out).toContain("already: true");
        expect(b.read()).toBe(before);
      } finally {
        b.cleanup();
      }
    });
  });

  describe("reopen", () => {
    it("moves a done task back to queued and clears the closed stamp", async () => {
      const b = makeBacklog();
      try {
        const out = await reopenCommand(["lease-core-t4"], b.ctx);
        expect(out).toContain("ok: reopen lease-core-t4 -> Queued");
        expect(out).toContain("Run `tasks-axi start lease-core-t4`");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments before mutating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          reopenCommand(["lease-core-t4", "extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("- [x] lease-core-t4");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("block / unblock", () => {
    it("adds and clears a blocked-by edge idempotently", async () => {
      const b = makeBacklog();
      try {
        const added = await blockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7"],
          b.ctx,
        );
        expect(added).toContain(
          "ok: block cert-cleanup -> blocked-by owns-widget-h7",
        );
        expect(b.read()).toContain("blocked-by: owns-widget-h7");

        const again = await blockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7"],
          b.ctx,
        );
        expect(again).toContain("already: true");
        expect(again).toContain(
          "ok: block cert-cleanup already blocked-by owns-widget-h7",
        );

        const cleared = await unblockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7"],
          b.ctx,
        );
        expect(cleared).not.toContain("already: true");
        expect(cleared).toContain(
          "ok: unblock cert-cleanup -> cleared owns-widget-h7",
        );
        expect(b.read()).not.toContain("blocked-by: owns-widget-h7");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable task with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await blockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7", "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          blocked_by: string;
          task: { id: string; blocked: boolean; blocked_by: string[] };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("block");
        expect(parsed.blocked_by).toBe("owns-widget-h7");
        expect(parsed.task.blocked).toBe(true);
        expect(parsed.task.blocked_by).toContain("owns-widget-h7");
      } finally {
        b.cleanup();
      }
    });

    it("requires --by", async () => {
      const b = makeBacklog();
      try {
        await expect(
          blockCommand(["cert-cleanup"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects invalid blocker ids", async () => {
      const b = makeBacklog();
      try {
        await expect(
          blockCommand(["cert-cleanup", "--by", "bad:id"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          unblockCommand(["cert-cleanup", "--by", "bad:id"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("bad:id");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a missing blocker target before changing dependencies", async () => {
      const b = makeBacklog();
      try {
        await expect(
          blockCommand(["cert-cleanup", "--by", "missing-q1"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blocked-by: missing-q1");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a self-block before changing dependencies", async () => {
      const b = makeBacklog();
      try {
        await expect(
          blockCommand(["cert-cleanup", "--by", "cert-cleanup"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blocked-by: cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments before changing dependencies", async () => {
      const b = makeBacklog();
      try {
        await expect(
          blockCommand(
            ["cert-cleanup", "extra", "--by", "owns-widget-h7"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("blocked-by: owns-widget-h7");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("ready", () => {
    it("lists unblocked queued work and excludes blocked tasks", async () => {
      const b = makeBacklog();
      try {
        await blockCommand(["cert-cleanup", "--by", "owns-widget-h7"], b.ctx);
        const out = await readyCommand([], b.ctx);
        expect(out).toContain("ready[");
        expect(out).not.toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("excludes held tasks by default", async () => {
      const b = makeBacklog();
      try {
        await holdCommand(
          [
            "cert-cleanup",
            "--reason",
            "captain decision pending",
            "--kind",
            "captain",
          ],
          b.ctx,
        );
        const out = await readyCommand([], b.ctx);
        expect(out).toContain("ready[");
        expect(out).not.toContain("cert-cleanup");
        expect(b.read()).toContain(
          "(hold: captain decision pending) (hold-kind: captain)",
        );
      } finally {
        b.cleanup();
      }
    });

    it("treats future hold-until as held and past hold-until as ready", async () => {
      const b = makeBacklog(
        [
          "# Backlog",
          "",
          "## Queued",
          "- [ ] future-q1 - future work (hold: wait for launch) (hold-until: 2999-01-01)",
          "- [ ] past-q1 - past work (hold: old wait) (hold-until: 2000-01-01)",
          "",
          "## Done",
          "",
        ].join("\n"),
      );
      try {
        const out = await readyCommand([], b.ctx);
        expect(out).not.toContain("future-q1");
        expect(out).toContain("past-q1");
      } finally {
        b.cleanup();
      }
    });

    it("shows active held tasks in a separate group with --include-held", async () => {
      const b = makeBacklog();
      try {
        await holdCommand(
          [
            "cert-cleanup",
            "--reason",
            "load clears",
            "--kind",
            "load",
            "--until",
            "2999-01-01",
          ],
          b.ctx,
        );
        const out = await readyCommand(["--include-held"], b.ctx);
        expect(out).toContain("ready[");
        expect(out).toContain("held[");
        expect(out).toContain("hold_reason");
        expect(out).toContain("load clears");
        expect(out).toContain("2999-01-01");
      } finally {
        b.cleanup();
      }
    });

    it("filters list to active held tasks with --state held", async () => {
      const b = makeBacklog();
      try {
        await holdCommand(["cert-cleanup", "--reason", "park it"], b.ctx);
        const out = await listCommand(
          ["--state", "held", "--fields", "held,hold_reason"],
          b.ctx,
        );
        expect(out).toContain("cert-cleanup");
        expect(out).toContain("held");
        expect(out).toContain("park it");
        expect(out).not.toContain("lease-adopt");
      } finally {
        b.cleanup();
      }
    });

    it("gives a definitive empty state", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await readyCommand([], b.ctx);
        expect(out).toContain("ready: 0 unblocked queued tasks");
      } finally {
        b.cleanup();
      }
    });

    it("carries repo scope into empty ready suggestions", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await readyCommand(["--repo", "monorepo"], b.ctx);
        expect(out).toContain(
          "Run `tasks-axi list --state queued --repo=monorepo` to see all queued work (incl. blocked)",
        );
      } finally {
        b.cleanup();
      }
    });

    it("rejects unknown flags", async () => {
      const b = makeBacklog();
      try {
        await expect(
          readyCommand(["--repoo", "demo"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it.each<[string, string[]]>([
      ["empty", ["--repo="]],
      ["whitespace", ["--repo", "   "]],
      ["multiline", ["--repo", "demo\nops"]],
    ])("rejects a %s repo filter", async (_case, flagArgs) => {
      const b = makeBacklog();
      try {
        await expect(readyCommand(flagArgs, b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });
  });

  describe("hold", () => {
    it("records and clears a structured hold idempotently", async () => {
      const b = makeBacklog();
      try {
        const held = await holdCommand(
          [
            "cert-cleanup",
            "--reason",
            "captain decision pending",
            "--kind",
            "captain",
            "--until",
            "2999-01-01",
          ],
          b.ctx,
        );
        expect(held).toContain("ok: hold cert-cleanup -> held");
        expect(held).toContain("hold_reason: captain decision pending");
        expect(b.read()).toContain(
          "(hold: captain decision pending) (hold-kind: captain) (hold-until: 2999-01-01)",
        );

        const heldAgain = await holdCommand(
          [
            "cert-cleanup",
            "--reason",
            "captain decision pending",
            "--kind",
            "captain",
            "--until",
            "2999-01-01",
          ],
          b.ctx,
        );
        expect(heldAgain).toContain("already: true");
        expect(heldAgain).toContain("ok: hold cert-cleanup already held");

        const cleared = await unholdCommand(["cert-cleanup"], b.ctx);
        expect(cleared).toContain("ok: unhold cert-cleanup -> cleared");
        expect(b.read()).not.toContain("(hold:");

        const clearedAgain = await unholdCommand(["cert-cleanup"], b.ctx);
        expect(clearedAgain).toContain("already: true");
        expect(clearedAgain).toContain(
          "ok: unhold cert-cleanup already not held",
        );
      } finally {
        b.cleanup();
      }
    });

    it("fails closed on unknown ids", async () => {
      const b = makeBacklog();
      try {
        await expect(
          holdCommand(["missing-q1", "--reason", "wait"], b.ctx),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          unholdCommand(["missing-q1"], b.ctx),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects missing or unsafe hold fields before mutating", async () => {
      const b = makeBacklog();
      try {
        await expect(
          holdCommand(["cert-cleanup"], b.ctx),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
        await expect(
          holdCommand(["cert-cleanup", "--reason", "wait (blocked)"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
          holdCommand(
            ["cert-cleanup", "--reason", "wait", "--until", "07/10/2026"],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).not.toContain("(hold:");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("mv", () => {
    it("moves a task to another backlog file", async () => {
      const b = makeBacklog();
      const target = makeBacklog(
        "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
      );
      try {
        const out = await mvCommand(
          ["cert-cleanup", "--to", target.path],
          b.ctx,
        );
        expect(out).toContain(`ok: mv cert-cleanup -> ${target.path}`);
        expect(b.read()).not.toContain("cert-cleanup");
        expect(readFileSync(target.path, "utf8")).toContain("cert-cleanup");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("emits a machine-readable result with --json", async () => {
      const b = makeBacklog();
      const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await mvCommand(
          ["cert-cleanup", "--to", target.path, "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          id: string;
          from: string;
          to: string;
        };
        expect(parsed).toMatchObject({
          ok: true,
          action: "mv",
          id: "cert-cleanup",
          to: target.path,
        });
        expect(readFileSync(target.path, "utf8")).toContain("cert-cleanup");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("resolves a directory to its data/backlog.md", async () => {
      const b = makeBacklog();
      const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        // place a backlog at <dir>/data/backlog.md
        const fs = await import("node:fs");
        fs.mkdirSync(join(target.dir, "data"), { recursive: true });
        fs.writeFileSync(
          join(target.dir, "data", "backlog.md"),
          "# Backlog\n\n## Queued\n\n## Done\n",
        );
        await mvCommand(["cert-cleanup", "--to", target.dir], b.ctx);
        expect(
          readFileSync(join(target.dir, "data", "backlog.md"), "utf8"),
        ).toContain("cert-cleanup");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("moves the task from a fresh locked source read", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] race-q1 - stale title\n\n## Done\n",
      );
      const target = makeBacklog(
        "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
      );
      const originalGet = b.store.get.bind(b.store);
      let edited = false;
      b.store.get = async (taskId: string) => {
        const task = await originalGet(taskId);
        if (taskId === "race-q1" && !edited) {
          edited = true;
          writeFileSync(
            b.path,
            "# Backlog\n\n## Queued\n- [ ] race-q1 - fresh title\n\n## Done\n",
            "utf8",
          );
        }
        return task;
      };
      try {
        await mvCommand(["race-q1", "--to", target.path], b.ctx);
        expect(edited).toBe(true);
        expect(readFileSync(target.path, "utf8")).toContain("fresh title");
        expect(readFileSync(target.path, "utf8")).not.toContain("stale title");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("leaves the source intact when destination validation fails", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] bad-q1 - invalid parsed repo (repo: foo(bar)\n\n## Done\n",
      );
      const target = makeBacklog(
        "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
      );
      try {
        await expect(
          mvCommand(["bad-q1", "--to", target.path], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("bad-q1");
        expect(readFileSync(target.path, "utf8")).not.toContain("bad-q1");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("preserves a missing created date when moving legacy tasks", async () => {
      const b = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] legacy-q1 - legacy without since\n\n## Done\n",
      );
      const target = makeBacklog(
        "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
      );
      try {
        await mvCommand(["legacy-q1", "--to", target.path], b.ctx);

        const moved = readFileSync(target.path, "utf8");
        expect(moved).toContain("- [ ] legacy-q1 - legacy without since");
        expect(moved).not.toContain("(since ");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("moves opposite directions without deadlocking", async () => {
      const left = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] left-q1 - move right\n\n## Done\n",
      );
      const right = makeBacklog(
        "# Backlog\n\n## Queued\n- [ ] right-q1 - move left\n\n## Done\n",
      );
      try {
        await Promise.all([
          mvCommand(["left-q1", "--to", right.path], left.ctx),
          mvCommand(["right-q1", "--to", left.path], right.ctx),
        ]);

        expect(left.read()).toContain("right-q1");
        expect(left.read()).not.toContain("left-q1");
        expect(readFileSync(right.path, "utf8")).toContain("left-q1");
        expect(readFileSync(right.path, "utf8")).not.toContain("right-q1");
      } finally {
        left.cleanup();
        right.cleanup();
      }
    });

    it("rejects moving a task that active tasks still block on", async () => {
      const b = makeBacklog();
      const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await b.store.addDep("cert-cleanup", {
          type: "blocked-by",
          id: "owns-widget-h7",
        });
        await expect(
          mvCommand(["owns-widget-h7", "--to", target.path], b.ctx),
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
        expect(readFileSync(target.path, "utf8")).not.toContain(
          "owns-widget-h7",
        );
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });

    it("requires --to", async () => {
      const b = makeBacklog();
      try {
        await expect(mvCommand(["cert-cleanup"], b.ctx)).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      } finally {
        b.cleanup();
      }
    });

    it("rejects a whitespace --to before moving", async () => {
      const b = makeBacklog();
      try {
        await expect(
          mvCommand(["cert-cleanup", "--to", "   "], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra positional arguments before moving", async () => {
      const b = makeBacklog();
      const target = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        await expect(
          mvCommand(["cert-cleanup", "extra", "--to", target.path], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.read()).toContain("cert-cleanup");
        expect(readFileSync(target.path, "utf8")).not.toContain("cert-cleanup");
      } finally {
        b.cleanup();
        target.cleanup();
      }
    });
  });
});
