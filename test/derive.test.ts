import { describe, expect, it } from "vitest";
import {
  activeBlockers,
  blockedIds,
  heldTasks,
  isHoldActive,
  readyTasks,
} from "../src/derive.js";
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

  it("excludes active held tasks from ready unless requested", () => {
    const held = {
      ...task("held-q1", "queued"),
      hold: { reason: "wait for captain", kind: "captain" as const },
    };
    const normal = task("normal-q1", "queued");
    expect(readyTasks([held, normal]).map((t) => t.id)).toEqual(["normal-q1"]);
    expect(
      readyTasks([held, normal], { includeHeld: true }).map((t) => t.id),
    ).toEqual(["held-q1", "normal-q1"]);
  });

  it("date-gates holds by local YYYY-MM-DD", () => {
    const future = {
      ...task("future-q1", "queued"),
      hold: { reason: "future", until: "2999-01-01" },
    };
    const past = {
      ...task("past-q1", "queued"),
      hold: { reason: "past", until: "2000-01-01" },
    };
    expect(isHoldActive(future, { today: "2026-07-08" })).toBe(true);
    expect(isHoldActive(past, { today: "2026-07-08" })).toBe(false);
    expect(heldTasks([future, past], { today: "2026-07-08" })).toEqual([
      future,
    ]);
    expect(readyTasks([future, past], { today: "2026-07-08" })).toEqual([
      past,
    ]);
  });

  it("activeBlockers lists only the unresolved blockers", () => {
    expect(activeBlockers(tasks[0], tasks)).toEqual(["b"]);
    expect(activeBlockers(tasks[2], tasks)).toEqual([]);
  });

  it("a blocked-by edge with a free-text reason still blocks (graph keys off the id)", () => {
    const withReason: Task[] = [
      task("p", "queued", [
        {
          type: "blocked-by",
          id: "q",
          reason: "waits on the login refactor",
        },
      ]),
      task("q", "in_flight"),
    ];
    expect(blockedIds(withReason).has("p")).toBe(true);
    expect(readyTasks(withReason).map((t) => t.id)).toEqual([]);
  });

  it("multiple reason-bearing blocked-by edges each participate in readiness", () => {
    const withReasons: Task[] = [
      task("p", "queued", [
        {
          type: "blocked-by",
          id: "q",
          reason: "first blocker done",
        },
        {
          type: "blocked-by",
          id: "r",
          reason: "waits on second blocker",
        },
      ]),
      task("q", "done"),
      task("r", "in_flight"),
    ];
    expect(activeBlockers(withReasons[0], withReasons)).toEqual(["r"]);
    expect(blockedIds(withReasons).has("p")).toBe(true);
    expect(readyTasks(withReasons).map((t) => t.id)).toEqual([]);
  });
});
