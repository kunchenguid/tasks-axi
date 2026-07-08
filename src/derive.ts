import type { Task } from "./model.js";

export interface DateGatedOptions {
  /** YYYY-MM-DD local date used for date-gated holds. Defaults to today. */
  today?: string;
}

export interface ReadyOptions extends DateGatedOptions {
  /** Include active held tasks in the ready projection. */
  includeHeld?: boolean;
}

export function currentLocalDate(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Derived `blocked` / `ready` / `held` projections, computed in the CLI from
 * the full task list, dependency graph, and structured hold tags (report §8:
 * these are not Store methods, so every backend gets them for free).
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

/** True when a structured hold is currently active. */
export function isHoldActive(
  task: Task,
  options: DateGatedOptions = {},
): boolean {
  if (!task.hold) return false;
  if (!task.hold.until) return task.state !== "done";
  const today = options.today ?? currentLocalDate();
  return task.state !== "done" && task.hold.until > today;
}

/** Active held work, excluding Done tasks. */
export function heldTasks(
  tasks: Task[],
  options: DateGatedOptions = {},
): Task[] {
  return tasks.filter((task) => isHoldActive(task, options));
}

/** Unblocked, unheld queued work - unless includeHeld asks for active holds too. */
export function readyTasks(tasks: Task[], options: ReadyOptions = {}): Task[] {
  const blocked = blockedIds(tasks);
  return tasks.filter(
    (t) =>
      t.state === "queued" &&
      !blocked.has(t.id) &&
      (options.includeHeld || !isHoldActive(t, options)),
  );
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
