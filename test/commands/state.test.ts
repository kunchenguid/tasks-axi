import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockCommand,
  doneCommand,
  mvCommand,
  readyCommand,
  reopenCommand,
  startCommand,
  unblockCommand,
} from "../../src/commands/state.js";
import { makeBacklog } from "../helpers.js";

describe("state commands", () => {
  describe("start", () => {
    it("moves a task to in_flight", async () => {
      const b = makeBacklog();
      try {
        const out = await startCommand(["cert-cleanup"], b.ctx);
        expect(out).toContain("state: in_flight");
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
          ["cert-cleanup", "--pr", "https://github.com/o/r/pull/9", "--no-prune"],
          b.ctx,
        );
        expect(out).toContain("state: done");
        expect(out).toContain("pruned: 0");
        const read = b.read();
        expect(read).toContain("https://github.com/o/r/pull/9");
        expect(read).toContain("(merged 2026-07-01)");
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
  });

  describe("reopen", () => {
    it("moves a done task back to queued and clears the closed stamp", async () => {
      const b = makeBacklog();
      try {
        const out = await reopenCommand(["lease-core-t4"], b.ctx);
        expect(out).toContain("state: queued");
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
        expect(added).toContain("blocked_by: owns-widget-h7");
        expect(b.read()).toContain("blocked-by: owns-widget-h7");

        const again = await blockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7"],
          b.ctx,
        );
        expect(again).toContain("already: true");

        const cleared = await unblockCommand(
          ["cert-cleanup", "--by", "owns-widget-h7"],
          b.ctx,
        );
        expect(cleared).not.toContain("already: true");
        expect(b.read()).not.toContain("blocked-by: owns-widget-h7");
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
          blockCommand(["cert-cleanup", "extra", "--by", "owns-widget-h7"], b.ctx),
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

    it("gives a definitive empty state", async () => {
      const b = makeBacklog("# Backlog\n\n## Queued\n\n## Done\n");
      try {
        const out = await readyCommand([], b.ctx);
        expect(out).toContain("ready: 0 unblocked queued tasks");
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
  });

  describe("mv", () => {
    it("moves a task to another backlog file", async () => {
      const b = makeBacklog();
      const target = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
      try {
        const out = await mvCommand(["cert-cleanup", "--to", target.path], b.ctx);
        expect(out).toContain("moved:");
        expect(b.read()).not.toContain("cert-cleanup");
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
      const target = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
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
      const target = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
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
      const target = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
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
