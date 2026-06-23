import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TasksContext } from "../../src/context.js";

describe("minted id collisions", () => {
  afterEach(() => {
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });

  it("retries when the first minted id already exists", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", () => ({
      randomBytes: () => Buffer.from([0]),
    }));

    const { MarkdownStore } = await import("../../src/backends/markdown.js");
    const { addCommand } = await import("../../src/commands/crud.js");
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-mint-"));
    const path = join(dir, "backlog.md");
    writeFileSync(
      path,
      "# Backlog\n\n## Queued\n- [ ] collision-title-00 - taken\n",
      "utf8",
    );
    const store = new MarkdownStore({ path, now: () => "2026-07-01" });
    const ctx: TasksContext = {
      store,
      config: { backend: "markdown", path, doneKeep: 10 },
    };

    try {
      const out = await addCommand(["collision title", "--mint"], ctx);
      expect(out).toContain("id: collision-title-01");
      expect(out).not.toContain("already: true");
      expect(readFileSync(path, "utf8")).toContain("collision-title-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
