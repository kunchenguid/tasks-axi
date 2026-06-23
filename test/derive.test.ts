import { describe, expect, it } from "vitest";
import { activeBlockers, blockedIds, readyTasks } from "../src/derive.js";
import type { Task } from "../src/model.js";

function task(id: string, state: Task["state"], deps: Task["deps"] = []): Task {
  return { id, title: id, state, links: [], deps };
}

describe("derive", () => {
  const tasks: Task[] = [
    task("a", "queued", [{ type: "blocked-by", id: "b" }]),
    task("b", "in_flight"),
    task("c", "queued", [{ type: "blocked-by", id: "d" }]),
    task("d", "done"),
    task("e", "queued"),
    task("f", "queued", [{ type: "blocked-by", id: "ghost" }]),
  ];

  it("marks a task blocked when a blocker is not done", () => {
    expect(blockedIds(tasks).has("a")).toBe(true);
  });

  it("does not mark a task blocked when its blocker is done", () => {
    expect(blockedIds(tasks).has("c")).toBe(false);
  });

  it("treats a missing blocker as resolved (not blocking)", () => {
    expect(blockedIds(tasks).has("f")).toBe(false);
  });

  it("ready = queued tasks with no unresolved blocker", () => {
    const ready = readyTasks(tasks).map((t) => t.id).sort();
    expect(ready).toEqual(["c", "e", "f"]);
  });

  it("activeBlockers lists only the unresolved blockers", () => {
    expect(activeBlockers(tasks[0], tasks)).toEqual(["b"]);
    expect(activeBlockers(tasks[2], tasks)).toEqual([]);
  });
});
