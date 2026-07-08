import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { MarkdownStore } from "../backends/markdown.js";
import {
  parseNonNegativeIntegerFlag,
  requireNonEmptyFlagValue,
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  requireId,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderMutation, stateLabel, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { blockedIds, heldTasks, readyTasks } from "../derive.js";
import { AxiError, notFound } from "../errors.js";
import { formatCountLine } from "../format.js";
import { validateDependencyId } from "../id.js";
import type {
  Dep,
  Hold,
  HoldKind,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
} from "../model.js";
import { HOLD_KINDS } from "../model.js";
import type { Store } from "../store.js";
import { getSuggestions } from "../suggestions.js";
import { renderHelp, renderOutput } from "../toon.js";
import { renderTaskDetail, renderTaskList, showFullTextHint } from "../view.js";

export const START_HELP = `usage: tasks-axi start <id>
Move a task to In flight (idempotent).
flags:
  --json   print the resulting task as a JSON object
examples:
  tasks-axi start firstmate-treehouse-lease-adopt`;

export const DONE_HELP = `usage: tasks-axi done <id> [flags]
aliases: close
Re-running on an already Done task backfills links/notes without changing the close date.
flags:
  --pr <url>, --report <path>, --note "<text>"
  --keep <n> (default from config), --no-prune
  --json   print the resulting task as a JSON object
examples:
  tasks-axi done sm-idle-handoff-q8 --pr https://github.com/o/r/pull/42
  tasks-axi done pr31-review-r6 --report data/pr31-review-r6/report.md`;

export const REOPEN_HELP = `usage: tasks-axi reopen <id>
Move a Done/In flight task back to Queued (idempotent).
flags:
  --json   print the resulting task as a JSON object`;

export const BLOCK_HELP = `usage: tasks-axi block <id> --by <other>
Record a blocked-by dependency edge (idempotent).
The blocker named by --by must already exist.
flags:
  --json   print the resulting task as a JSON object
examples:
  tasks-axi block firstmate-treehouse-lease-adopt --by treehouse-lease-t4`;

export const UNBLOCK_HELP = `usage: tasks-axi unblock <id> --by <other>
Clear a blocked-by dependency edge (idempotent).
flags:
  --json   print the resulting task as a JSON object`;

export const HOLD_HELP = `usage: tasks-axi hold <id> --reason "<text>" [flags]
Record a structured dispatch hold (idempotent).
flags:
  --reason "<text>"   required single-line reason; no parentheses
  --until YYYY-MM-DD  date gate; inactive on and after that date
  --kind captain|external|load|parked|future
  --json   print the resulting task as a JSON object
examples:
  tasks-axi hold fm-x --reason "captain decision pending" --kind captain
  tasks-axi hold future-q1 --reason "start after launch" --until 2026-07-10`;

export const UNHOLD_HELP = `usage: tasks-axi unhold <id>
Clear a structured dispatch hold (idempotent).
flags:
  --json   print the resulting task as a JSON object`;

export const READY_HELP = `usage: tasks-axi ready [--repo <name>] [--include-held]
List unblocked, unheld queued work dispatchable right now.
Held work is excluded by default; --include-held shows it in a separate held group.`;

export const MV_HELP = `usage: tasks-axi mv <id> --to <path-or-dir>
Move a task to another backlog file (generalizes a hand-rolled line move).
Fails while active tasks still block on this id.
flags:
  --json   print the result as a JSON object
examples:
  tasks-axi mv hibit-cert-cleanup --to ../homemux/data/backlog.md`;

export async function startCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, START_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });

  const already = current.state === "in_flight";
  const task = already ? current : await store.transition(id, "in_flight");
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: already
      ? `start ${id} already in flight`
      : `start ${id} -> ${stateLabel(task.state)}`,
    already,
    jsonPayload: {
      ok: true,
      action: "start",
      ...(already ? { already: true } : {}),
      task: taskToJson(task, all),
    },
    suggestions: getSuggestions({
      action: "start",
      id,
      state: task.state,
      globals: context?.suggestionGlobals,
    }),
  });
}

export async function doneCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];

  const json = takeBoolFlag(args, "--json");
  const pr = requireNonEmptyFlagValue("--pr", takeFlag(args, "--pr"));
  const report = requireNonEmptyFlagValue(
    "--report",
    takeFlag(args, "--report"),
  );
  const note = requireNonEmptyFlagValue("--note", takeFlag(args, "--note"));
  const keepRaw = takeFlag(args, "--keep");
  const noPrune = takeBoolFlag(args, "--no-prune");
  const positionals = requirePositionals(args, 1, 1, DONE_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");
  const keep = parseNonNegativeIntegerFlag("--keep", keepRaw, config.doneKeep);

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });

  const opts: { pr?: string; report?: string; note?: string } = {};
  if (pr !== undefined) opts.pr = pr;
  if (report !== undefined) opts.report = report;
  if (note !== undefined) opts.note = note;

  if (current.state === "done") {
    const patch = doneMetadataPatch(pr, report, note, current);
    const hasPatch = Object.keys(patch).length > 0;
    let task = current;
    if (hasPatch) {
      task = await store.update(id, patch);
    }
    const pruned = await pruneDone(store, keep, noPrune);
    const all = (await store.list({})).items;
    return renderMutation({
      json,
      confirm: `done ${id} already -> ${stateLabel(task.state)}${doneExtras(pr, report)}${prunedNote(pruned)}`,
      already: true,
      jsonPayload: {
        ok: true,
        action: "done",
        already: true,
        pruned,
        task: taskToJson(task, all),
      },
      ...(hasPatch
        ? { detail: renderTaskDetail(task, all, false, showFullTextHint(task)) }
        : {}),
      suggestions: getSuggestions({
        action: "done",
        id,
        state: task.state,
        globals: context?.suggestionGlobals,
      }),
    });
  }

  const task = await store.transition(id, "done", opts);
  const pruned = await pruneDone(store, keep, noPrune);
  const all = (await store.list({})).items;

  return renderMutation({
    json,
    confirm: `done ${id} -> ${stateLabel(task.state)}${doneExtras(pr, report)}${prunedNote(pruned)}`,
    jsonPayload: {
      ok: true,
      action: "done",
      pruned,
      task: taskToJson(task, all),
    },
    suggestions: getSuggestions({
      action: "done",
      id,
      state: task.state,
      globals: context?.suggestionGlobals,
    }),
  });
}

/** The `(pr X, report Y)` parenthetical for a done confirmation, omitted when bare. */
function doneExtras(
  pr: string | undefined,
  report: string | undefined,
): string {
  const parts: string[] = [];
  if (pr !== undefined) parts.push(`pr ${pr}`);
  if (report !== undefined) parts.push(`report ${report}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** A trailing `; pruned N` note, shown only when something was archived. */
function prunedNote(pruned: number): string {
  return pruned > 0 ? `; pruned ${pruned}` : "";
}

async function pruneDone(
  store: Store,
  keep: number,
  noPrune: boolean,
): Promise<number> {
  if (noPrune || !store.prune) return 0;
  const result = await store.prune({
    state: "done",
    keep,
    archive: true,
  });
  return result.archived;
}

function doneMetadataPatch(
  pr: string | undefined,
  report: string | undefined,
  note: string | undefined,
  current?: Task,
): TaskPatch {
  const patch: TaskPatch = {};
  const addLinks: TaskLink[] = [];
  if (pr !== undefined) addLinks.push({ kind: "pr", url: pr });
  if (report !== undefined) addLinks.push({ kind: "report", url: report });
  if (addLinks.length > 0) patch.addLinks = addLinks;
  if (note !== undefined && !bodyHasLine(current?.body, note)) {
    patch.appendBody = note;
  }
  return patch;
}

function bodyHasLine(body: string | undefined, line: string): boolean {
  return body?.split("\n").includes(line) ?? false;
}

export async function reopenCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(
    args,
    1,
    1,
    REOPEN_HELP.split("\n")[0],
  );
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });

  const already = current.state === "queued";
  const task = already ? current : await store.transition(id, "queued");
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: already
      ? `reopen ${id} already queued`
      : `reopen ${id} -> ${stateLabel(task.state)}`,
    already,
    jsonPayload: {
      ok: true,
      action: "reopen",
      ...(already ? { already: true } : {}),
      task: taskToJson(task, all),
    },
    suggestions: getSuggestions({
      action: "reopen",
      id,
      state: task.state,
      globals: context?.suggestionGlobals,
    }),
  });
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

function requireHoldReason(value: string | undefined): string {
  const checked = requireNonEmptySingleLineFlagValue("--reason", value);
  if (checked === undefined) {
    throw new AxiError("--reason <text> is required", "VALIDATION_ERROR", [
      'Pass a reason, e.g. --reason "captain decision pending"',
    ]);
  }
  if (/[()]/.test(checked)) {
    throw new AxiError(
      "--reason must not contain parentheses",
      "VALIDATION_ERROR",
      ["Parentheses are reserved for markdown hold tags"],
    );
  }
  return checked.trim();
}

function parseHoldKind(value: string | undefined): HoldKind | undefined {
  const checked = requireNonEmptySingleLineFlagValue("--kind", value);
  if (checked === undefined) return undefined;
  if (!(HOLD_KINDS as readonly string[]).includes(checked)) {
    throw new AxiError(
      `--kind must be one of ${HOLD_KINDS.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  return checked as HoldKind;
}

function parseDateFlag(
  flag: string,
  value: string | undefined,
): string | undefined {
  const checked = requireNonEmptySingleLineFlagValue(flag, value);
  if (checked === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checked)) {
    throw new AxiError(`${flag} must be YYYY-MM-DD`, "VALIDATION_ERROR");
  }
  return checked;
}

function sameHold(left: Hold | undefined, right: Hold | undefined): boolean {
  return (
    left?.reason === right?.reason &&
    left?.kind === right?.kind &&
    left?.until === right?.until
  );
}

async function requireExistingBlocker(store: Store, id: string): Promise<void> {
  if (await store.get(id)) return;
  throw new AxiError(`blocker "${id}" not found`, "VALIDATION_ERROR", [
    "Create the blocker task first, or choose an existing task id",
  ]);
}

export async function blockCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const by = requireBy(args);
  const positionals = requirePositionals(args, 1, 1, BLOCK_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });
  if (by === id) {
    throw new AxiError("A task cannot block itself", "VALIDATION_ERROR");
  }
  await requireExistingBlocker(store, by);
  const dep: Dep = { type: "blocked-by", id: by };
  const added = await store.addDep(id, dep);

  const all = (await store.list({})).items;
  const task = all.find((t) => t.id === id) ?? current;
  return renderMutation({
    json,
    confirm: added
      ? `block ${id} -> blocked-by ${by}`
      : `block ${id} already blocked-by ${by}`,
    already: !added,
    jsonPayload: {
      ok: true,
      action: "block",
      ...(added ? {} : { already: true }),
      blocked_by: by,
      task: taskToJson(task, all),
    },
    suggestions: getSuggestions({
      action: "block",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}

export async function unblockCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const by = requireBy(args);
  const positionals = requirePositionals(
    args,
    1,
    1,
    UNBLOCK_HELP.split("\n")[0],
  );
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });
  const removed = await store.removeDep(id, { type: "blocked-by", id: by });

  const all = (await store.list({})).items;
  const task = all.find((t) => t.id === id) ?? current;
  return renderMutation({
    json,
    confirm: removed
      ? `unblock ${id} -> cleared ${by}`
      : `unblock ${id} already not blocked-by ${by}`,
    already: !removed,
    jsonPayload: {
      ok: true,
      action: "unblock",
      ...(removed ? {} : { already: true }),
      blocked_by: by,
      task: taskToJson(task, all),
    },
    suggestions: getSuggestions({
      action: "unblock",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}

export async function holdCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const reason = requireHoldReason(takeFlag(args, "--reason"));
  const until = parseDateFlag("--until", takeFlag(args, "--until"));
  const kind = parseHoldKind(takeFlag(args, "--kind"));
  const positionals = requirePositionals(args, 1, 1, HOLD_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });

  const hold: Hold = {
    reason,
    ...(kind !== undefined ? { kind } : {}),
    ...(until !== undefined ? { until } : {}),
  };
  const already = sameHold(current.hold, hold);
  const task = already ? current : await store.update(id, { hold });
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: already
      ? `hold ${id} already held`
      : `hold ${id} -> held${holdAttrs(hold)}`,
    already,
    jsonPayload: {
      ok: true,
      action: "hold",
      ...(already ? { already: true } : {}),
      task: taskToJson(task, all),
    },
    detail: renderTaskDetail(task, all, false, showFullTextHint(task)),
    suggestions: getSuggestions({
      action: "hold",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}

function holdAttrs(hold: Hold): string {
  const parts: string[] = [];
  if (hold.kind) parts.push(hold.kind);
  if (hold.until) parts.push(`until ${hold.until}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export async function unholdCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, UNHOLD_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const current = await store.get(id);
  if (!current) throw notFound(id, { globals: context?.suggestionGlobals });

  const already = current.hold === undefined;
  const task = already ? current : await store.update(id, { hold: null });
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: already ? `unhold ${id} already not held` : `unhold ${id} -> cleared`,
    already,
    jsonPayload: {
      ok: true,
      action: "unhold",
      ...(already ? { already: true } : {}),
      task: taskToJson(task, all),
    },
    detail: renderTaskDetail(task, all, false, showFullTextHint(task)),
    suggestions: getSuggestions({
      action: "unhold",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}

export async function readyCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const repo = requireNonEmptySingleLineFlagValue(
    "--repo",
    takeFlag(args, "--repo"),
  );
  const includeHeld = takeBoolFlag(args, "--include-held");
  requirePositionals(args, 0, 0, READY_HELP.split("\n")[0]);

  const all = (await store.list({})).items;
  let items = readyTasks(all);
  const blocked = blockedIds(all);
  let held = heldTasks(all).filter(
    (t) => t.state === "queued" && !blocked.has(t.id),
  );
  if (repo) items = items.filter((t) => t.repo === repo);
  if (repo) held = held.filter((t) => t.repo === repo);
  const isEmpty = items.length === 0;

  const blocks: string[] = [formatCountLine({ count: items.length })];
  if (isEmpty) {
    blocks.push("ready: 0 unblocked queued tasks");
  } else {
    blocks.push(renderTaskList("ready", items, all));
  }
  if (includeHeld && held.length > 0) {
    blocks.push(
      renderTaskList("held", held, all, [
        { type: "field", key: "hold_reason" },
        { type: "field", key: "hold_kind" },
        { type: "field", key: "hold_until" },
      ]),
    );
  }
  blocks.push(
    renderHelp(
      getSuggestions({
        action: "ready",
        isEmpty,
        globals: context?.suggestionGlobals,
        filters: {
          ...(repo !== undefined ? { repo } : {}),
        },
      }),
    ),
  );
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
  if (task.hold) input.hold = { ...task.hold };
  if (task.priority !== undefined) input.priority = task.priority;
  input.created = task.created ?? null;
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

  const json = takeBoolFlag(args, "--json");
  const to = requireNonEmptySingleLineFlagValue("--to", takeFlag(args, "--to"));
  if (to === undefined) {
    throw new AxiError("--to <path-or-dir> is required", "VALIDATION_ERROR", [
      "Name the destination backlog, e.g. `--to ../other/data/backlog.md`",
    ]);
  }
  const positionals = requirePositionals(args, 1, 1, MV_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const task = await store.get(id);
  if (!task) throw notFound(id, { globals: context?.suggestionGlobals });

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

  if (store instanceof MarkdownStore) {
    await store.moveTo(id, target);
  } else {
    await target.create(taskToInput(task));
    await store.remove(id);
  }

  return renderMutation({
    json,
    confirm: `mv ${id} -> ${targetPath}`,
    jsonPayload: {
      ok: true,
      action: "mv",
      id,
      from: config.path,
      to: targetPath,
    },
    suggestions: getSuggestions({
      action: "mv",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}
