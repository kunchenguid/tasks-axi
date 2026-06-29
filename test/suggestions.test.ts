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

  it("suppresses scoped hints when an active kind filter cannot be preserved", () => {
    const lines = getSuggestions({
      action: "list",
      filters: { kind: "docs" },
    });
    expect(lines).toEqual([
      "Run `tasks-axi show <id>` for full notes on a task",
    ]);
  });

  it("never suggests start after an in-flight add (state-aware)", () => {
    const lines = getSuggestions({
      action: "add",
      id: "x-q1",
      state: "in_flight",
    });
    expect(lines).toEqual([
      "Run `tasks-axi done x-q1 --pr <url>` when it ships",
      "Run `tasks-axi block x-q1 --by <other>` to record a dependency",
    ]);
    expect(lines.some((l) => l.includes("tasks-axi start"))).toBe(false);
  });

  it("suggests start after a queued add", () => {
    const lines = getSuggestions({
      action: "add",
      id: "x-q1",
      state: "queued",
    });
    expect(lines).toContain(
      "Run `tasks-axi start x-q1` to move it to in flight",
    );
  });

  it("suggests reopen after re-adding a done task", () => {
    const lines = getSuggestions({ action: "add", id: "x-q1", state: "done" });
    expect(lines).toEqual([
      "Run `tasks-axi reopen x-q1` to move it back to queued",
    ]);
  });

  it("carries repo scope into empty ready follow-ups", () => {
    const lines = getSuggestions({
      action: "ready",
      isEmpty: true,
      filters: { repo: "demo repo" },
    });
    expect(lines).toEqual([
      "Run `tasks-axi list --state queued --repo='demo repo'` to see all queued work (incl. blocked)",
    ]);
  });
});
