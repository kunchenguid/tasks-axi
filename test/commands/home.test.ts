import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { addCommand } from "../../src/commands/crud.js";
import { homeCommand } from "../../src/commands/home.js";
import { makeBacklog } from "../helpers.js";

describe("home", () => {
  it("shows in_flight and queued sections with counts and hints", async () => {
    const b = makeBacklog();
    try {
      const out = await homeCommand([], b.ctx);
      expect(out).toContain("in_flight[");
      expect(out).toContain("summary:");
      expect(out).toContain("queued[");
      expect(out.match(/^queued(?:\[|:)/gm)).toHaveLength(1);
      expect(out).toContain("done:");
      expect(out).toContain("help[");
      expect(() => decode(out)).not.toThrow();
      // the long body never appears in the dashboard
      expect(out).not.toContain("Follow-up note added later");
    } finally {
      b.cleanup();
    }
  });

  it("gives definitive zero states for an empty backlog", async () => {
    const b = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
    try {
      const out = await homeCommand([], b.ctx);
      expect(out).toContain("in_flight: 0 tasks");
      expect(out).toContain("queued: 0 tasks");
    } finally {
      b.cleanup();
    }
  });

  it("uses show --full as the dashboard truncation escape hatch", async () => {
    const b = makeBacklog();
    try {
      await addCommand(["long-title-q1", "x".repeat(100)], b.ctx);
      const out = await homeCommand([], b.ctx);
      expect(out).toContain("use show long-title-q1 --full");
      expect(out).not.toContain("use --full to see complete text");
    } finally {
      b.cleanup();
    }
  });
});
