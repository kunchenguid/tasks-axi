import { describe, expect, it } from "vitest";
import { pruneCommand, renderCommand } from "../../src/commands/maintain.js";
import { makeBacklog } from "../helpers.js";

describe("maintenance commands", () => {
  describe("prune", () => {
    it("trims Done to the keep count and archives the surplus", async () => {
      const b = makeBacklog();
      try {
        const out = await pruneCommand(["--keep", "2"], b.ctx);
        expect(out).toMatch(/ok: prune done -> archived [1-9]\d* \(kept 2\)/);
        expect(b.archive()).toContain("## Archived");
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable result with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await pruneCommand(["--keep", "2", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          state: string;
          kept: number;
          archived: number;
          ids: string[];
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("prune");
        expect(parsed.state).toBe("done");
        expect(parsed.kept).toBe(2);
        expect(parsed.archived).toBeGreaterThan(0);
        expect(Array.isArray(parsed.ids)).toBe(true);
        expect(out).not.toContain("help[");
      } finally {
        b.cleanup();
      }
    });

    it("rejects a negative keep", async () => {
      const b = makeBacklog();
      try {
        await expect(
          pruneCommand(["--keep", "-1"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects a negative configured keep", async () => {
      const b = makeBacklog();
      try {
        await expect(
          pruneCommand([], {
            ...b.ctx,
            config: { ...b.ctx.config, doneKeep: -1 },
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid state", async () => {
      const b = makeBacklog();
      try {
        await expect(
          pruneCommand(["--state", "in-flight"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("rejects unknown flags before pruning", async () => {
      const b = makeBacklog();
      try {
        await expect(
          pruneCommand(["--keeep", "2"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(b.archive()).toBe("");
      } finally {
        b.cleanup();
      }
    });
  });

  describe("render", () => {
    it("normalizes the file and reports the count", async () => {
      const b = makeBacklog();
      try {
        const out = await renderCommand([], b.ctx);
        expect(out).toMatch(/ok: render -> normalized \d+/);
      } finally {
        b.cleanup();
      }
    });

    it("emits a machine-readable result with --json", async () => {
      const b = makeBacklog();
      try {
        const out = await renderCommand(["--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          action: string;
          normalized: number;
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.action).toBe("render");
        expect(typeof parsed.normalized).toBe("number");
      } finally {
        b.cleanup();
      }
    });

    it("rejects extra arguments before rendering", async () => {
      const b = makeBacklog();
      try {
        await expect(
          renderCommand(["extra"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });
  });
});
