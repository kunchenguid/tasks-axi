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
});
