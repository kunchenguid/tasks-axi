import { describe, expect, it } from "vitest";
import { getSuggestions } from "../src/suggestions.js";

describe("suggestions", () => {
  it("carries shell-quoted global context into commands", () => {
    const lines = getSuggestions({
      action: "list",
      globals: { backend: "markdown", file: "other backlog.md" },
    });
    expect(lines).toContain(
      "Run `tasks-axi show <id> --backend=markdown --file='other backlog.md'` for full notes on a task",
    );
  });

  it.each(["one\ntwo", "path`withtick"])(
    "omits suggestions when global context cannot be preserved",
    (file) => {
      expect(
        getSuggestions({
          action: "list",
          globals: { file },
        }),
      ).toEqual([]);
    },
  );

  it("carries supported repo filters into scoped list follow-ups", () => {
    const lines = getSuggestions({
      action: "list",
      filters: { repo: "demo repo" },
      globals: { file: "other.md" },
    });
    expect(lines).toContain(
      "Run `tasks-axi show <id> --file=other.md` for full notes on a task",
    );
    expect(lines).toContain(
      "Run `tasks-axi ready --repo='demo repo' --file=other.md` to see unblocked queued work",
    );
  });

  it("omits scoped hints when a filter cannot be preserved", () => {
    const lines = getSuggestions({
      action: "list",
      filters: { repo: "bad`repo" },
    });
    expect(lines).toEqual([
      "Run `tasks-axi show <id>` for full notes on a task",
    ]);
  });
});
