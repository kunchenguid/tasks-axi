import { readFileSync } from "node:fs";
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

    it("is idempotent when already done", async () => {
      const b = makeBacklog();
      try {
        const out = await doneCommand(["lease-core-t4"], b.ctx);
        expect(out).toContain("already: true");
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
  });
});
