import { describe, expect, it } from "vitest";
import { pruneCommand, renderCommand } from "../../src/commands/maintain.js";
import { makeBacklog } from "../helpers.js";

describe("maintenance commands", () => {
  describe("prune", () => {
    it("trims Done to the keep count and archives the surplus", async () => {
      const b = makeBacklog();
      try {
        const out = await pruneCommand(["--keep", "2"], b.ctx);
        expect(out).toContain("prune:");
        expect(out).toMatch(/archived: [1-9]/);
        expect(b.archive()).toContain("## Archived");
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
  });

  describe("render", () => {
    it("normalizes the file and reports the count", async () => {
      const b = makeBacklog();
      try {
        const out = await renderCommand([], b.ctx);
        expect(out).toMatch(/normalized: \d+/);
      } finally {
        b.cleanup();
      }
    });
  });
});
