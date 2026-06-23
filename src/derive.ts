import type { Task } from "./model.js";

/**
 * Derived `blocked` / `ready` projections, computed in the CLI from the full
 * task list + the dependency graph (report §8: `ready` is not a Store method,
 * so every backend gets it for free).
 *
 * A task is `blocked` iff it is not done and has a `blocked-by` edge pointing
 * at a task that exists and is not done. Command mutations reject new dangling
 * blockers, but a legacy hand-edited dangling edge is treated as resolved -
 * firstmate drops the edge when the blocker lands, so a missing blocker almost
 * always means it is done.
 */
export function blockedIds(tasks: Task[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocked = new Set<string>();
  for (const task of tasks) {
    if (task.state === "done") continue;
    for (const dep of task.deps) {
      if (dep.type !== "blocked-by") continue;
      const blocker = byId.get(dep.id);
      if (blocker && blocker.state !== "done") {
        blocked.add(task.id);
        break;
      }
    }
  }
  return blocked;
}

/** Unblocked queued work — the literal implementation of "dispatch what was unblocked". */
export function readyTasks(tasks: Task[]): Task[] {
  const blocked = blockedIds(tasks);
  return tasks.filter((t) => t.state === "queued" && !blocked.has(t.id));
}

/** The unresolved blocked-by edges for a task (blockers that are not done). */
export function activeBlockers(task: Task, tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.deps
    .filter((d) => d.type === "blocked-by")
    .map((d) => d.id)
    .filter((id) => {
      const blocker = byId.get(id);
      return blocker ? blocker.state !== "done" : false;
    });
}
