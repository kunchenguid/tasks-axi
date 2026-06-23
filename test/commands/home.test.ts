import { describe, expect, it } from "vitest";
import { homeCommand } from "../../src/commands/home.js";
import { makeBacklog } from "../helpers.js";

describe("home", () => {
  it("shows in_flight and queued sections with counts and hints", async () => {
    const b = makeBacklog();
    try {
      const out = await homeCommand([], b.ctx);
      expect(out).toContain("in_flight[");
      expect(out).toContain("queued[");
      expect(out).toContain("done:");
      expect(out).toContain("help[");
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
});
