import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { MarkdownStore } from "../backends/markdown.js";
import {
  getFlag,
  getPositional,
  parseNonNegativeIntegerFlag,
  requireId,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { requireCtx, type TasksContext } from "../context.js";
import { readyTasks } from "../derive.js";
import { AxiError, notFound } from "../errors.js";
import { formatCountLine } from "../format.js";
import { validateDependencyId } from "../id.js";
import type { Dep, Task, TaskInput } from "../model.js";
import { getSuggestions } from "../suggestions.js";
import { field, renderDetail, renderHelp, renderOutput } from "../toon.js";
import { renderTaskList } from "../view.js";

export const START_HELP = `usage: tasks-axi start <id>
Move a task to In flight (idempotent).
examples:
  tasks-axi start firstmate-treehouse-lease-adopt`;

export const DONE_HELP = `usage: tasks-axi done <id> [flags]
aliases: close
flags:
  --pr <url>, --report <path>, --note "<text>"
  --keep <n> (default from config), --no-prune
examples:
  tasks-axi done sm-idle-handoff-q8 --pr https://github.com/o/r/pull/42
  tasks-axi done pr31-review-r6 --report data/pr31-review-r6/report.md`;

export const REOPEN_HELP = `usage: tasks-axi reopen <id>
Move a Done/In flight task back to Queued (idempotent).`;

export const BLOCK_HELP = `usage: tasks-axi block <id> --by <other>
Record a blocked-by dependency edge (idempotent).
examples:
  tasks-axi block firstmate-treehouse-lease-adopt --by treehouse-lease-t4`;

export const UNBLOCK_HELP = `usage: tasks-axi unblock <id> --by <other>
Clear a blocked-by dependency edge (idempotent).`;

export const READY_HELP = `usage: tasks-axi ready [--repo <name>]
List unblocked queued work - the tasks dispatchable right now.`;

export const MV_HELP = `usage: tasks-axi mv <id> --to <path-or-dir>
Move a task to another backlog file (generalizes a hand-rolled line move).
examples:
  tasks-axi mv hibit-cert-cleanup --to ../homemux/data/backlog.md`;

export async function startCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const id = requireId(getPositional([...rawArgs], 0), "id");

  const current = await store.get(id);
  if (!current) throw notFound(id);

  if (current.state === "in_flight") {
    return renderOutput([
      "already: true",
      renderDetail("start", { id, state: "in_flight" }, [
        field("id"),
        field("state"),
      ]),
    ]);
  }

  const task = await store.transition(id, "in_flight");
  return renderOutput([
    renderDetail("start", { id: task.id, state: task.state }, [
      field("id"),
      field("state"),
    ]),
    renderHelp(getSuggestions({ action: "start", id })),
  ]);
}

export async function doneCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];

  const pr = takeFlag(args, "--pr");
  const report = takeFlag(args, "--report");
  const note = takeFlag(args, "--note");
  const keepRaw = takeFlag(args, "--keep");
  const noPrune = takeBoolFlag(args, "--no-prune");
  const id = requireId(getPositional(args, 0), "id");
  const keep = parseNonNegativeIntegerFlag("--keep", keepRaw, config.doneKeep);

  const current = await store.get(id);
  if (!current) throw notFound(id);

  if (current.state === "done") {
    return renderOutput([
      "already: true",
      renderDetail("done", { id, state: "done", pruned: 0 }, [
        field("id"),
        field("state"),
        field("pruned"),
      ]),
    ]);
  }

  const opts: { pr?: string; report?: string; note?: string } = {};
  if (pr) opts.pr = pr;
  if (report) opts.report = report;
  if (note) opts.note = note;
  const task = await store.transition(id, "done", opts);

  let pruned = 0;
  if (!noPrune && store.prune) {
    const result = await store.prune({
      state: "done",
      keep,
      archive: true,
    });
    pruned = result.archived;
  }

  return renderOutput([
    renderDetail("done", { id: task.id, state: task.state, pruned }, [
      field("id"),
      field("state"),
      field("pruned"),
    ]),
    renderHelp(getSuggestions({ action: "done", id })),
  ]);
}

export async function reopenCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const id = requireId(getPositional([...rawArgs], 0), "id");

  const current = await store.get(id);
  if (!current) throw notFound(id);

  if (current.state === "queued") {
    return renderOutput([
      "already: true",
      renderDetail("reopen", { id, state: "queued" }, [
        field("id"),
        field("state"),
      ]),
    ]);
  }

  const task = await store.transition(id, "queued");
  return renderOutput([
    renderDetail("reopen", { id: task.id, state: task.state }, [
      field("id"),
      field("state"),
    ]),
    renderHelp(getSuggestions({ action: "reopen", id })),
  ]);
}

function requireBy(args: string[]): string {
  const by = takeFlag(args, "--by");
  if (!by) {
    throw new AxiError("--by <id> is required", "VALIDATION_ERROR", [
      "Name the other task, e.g. `--by treehouse-lease-t4`",
    ]);
  }
  return validateDependencyId(by);
}

export async function blockCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const by = requireBy(args);
  const id = requireId(getPositional(args, 0), "id");

  if (!(await store.get(id))) throw notFound(id);
  const dep: Dep = { type: "blocked-by", id: by };
  const added = await store.addDep(id, dep);

  const blocks: string[] = [];
  if (!added) blocks.push("already: true");
  blocks.push(
    renderDetail("block", { id, blocked_by: by }, [
      field("id"),
      field("blocked_by"),
    ]),
  );
  blocks.push(renderHelp(getSuggestions({ action: "block", id })));
  return renderOutput(blocks);
}

export async function unblockCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const by = requireBy(args);
  const id = requireId(getPositional(args, 0), "id");

  if (!(await store.get(id))) throw notFound(id);
  const removed = await store.removeDep(id, { type: "blocked-by", id: by });

  const blocks: string[] = [];
  if (!removed) blocks.push("already: true");
  blocks.push(
    renderDetail("unblock", { id, blocked_by: by }, [
      field("id"),
      field("blocked_by"),
    ]),
  );
  blocks.push(renderHelp(getSuggestions({ action: "unblock", id })));
  return renderOutput(blocks);
}

export async function readyCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const repo = getFlag(args, "--repo");

  const all = (await store.list({})).items;
  let items = readyTasks(all);
  if (repo) items = items.filter((t) => t.repo === repo);
  const isEmpty = items.length === 0;

  const blocks: string[] = [formatCountLine({ count: items.length })];
  if (isEmpty) {
    blocks.push("ready: 0 unblocked queued tasks");
  } else {
    blocks.push(renderTaskList("ready", items, all));
  }
  blocks.push(renderHelp(getSuggestions({ action: "ready", isEmpty })));
  return renderOutput(blocks);
}

function resolveBacklogTarget(to: string): string {
  const base = isAbsolute(to) ? to : resolve(process.cwd(), to);
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const candidate of ["data/backlog.md", "backlog.md"]) {
      const full = resolve(base, candidate);
      if (existsSync(full)) return full;
    }
    return resolve(base, "data/backlog.md");
  }
  return base;
}

function taskToInput(task: Task): TaskInput {
  const input: TaskInput = {
    id: task.id,
    title: task.title,
    state: task.state,
    deps: task.deps.map((dep) => ({ ...dep })),
    links: task.links.map((link) => ({ ...link })),
  };
  if (task.kind) input.kind = task.kind;
  if (task.repo) input.repo = task.repo;
  if (task.body) input.body = task.body;
  if (task.priority !== undefined) input.priority = task.priority;
  if (task.created) input.created = task.created;
  if (task.closed) input.closed = task.closed;
  if (task.meta) input.meta = { ...task.meta };
  return input;
}

export async function mvCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];

  const to = takeFlag(args, "--to");
  if (!to) {
    throw new AxiError("--to <path-or-dir> is required", "VALIDATION_ERROR", [
      "Name the destination backlog, e.g. `--to ../other/data/backlog.md`",
    ]);
  }
  const id = requireId(getPositional(args, 0), "id");

  if (!(await store.get(id))) throw notFound(id);

  const targetPath = resolveBacklogTarget(to);
  if (resolve(targetPath) === resolve(config.path)) {
    throw new AxiError(
      "--to resolves to the current backlog",
      "VALIDATION_ERROR",
    );
  }
  const target = new MarkdownStore({ path: targetPath });
  if (await target.get(id)) {
    throw new AxiError(
      `Task "${id}" already exists in the destination backlog`,
      "CONFLICT",
    );
  }

  const task = await store.remove(id);
  const input = taskToInput(task);
  try {
    await target.create(input);
  } catch (error) {
    try {
      await store.create(input);
    } catch {
      throw new AxiError(
        "Move failed and the source task could not be restored",
        "UNKNOWN",
      );
    }
    throw error;
  }

  return renderOutput([
    renderDetail("moved", { id, from: config.path, to: targetPath }, [
      field("id"),
      field("from"),
      field("to"),
    ]),
  ]);
}
