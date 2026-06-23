import {
  getFlag,
  getPositional,
  hasFlag,
  requireId,
  takeAllFlags,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { takeBody } from "../body.js";
import { requireCtx, type TasksContext } from "../context.js";
import { blockedIds } from "../derive.js";
import { AxiError, notFound } from "../errors.js";
import { parseFields } from "../fields.js";
import { formatCountLine } from "../format.js";
import { mintId, validateDependencyId, validateId } from "../id.js";
import type { Dep, State, TaskInput, TaskLink, TaskPatch } from "../model.js";
import { getSuggestions } from "../suggestions.js";
import { renderHelp, renderOutput } from "../toon.js";
import {
  LIST_EXTRA_FIELDS,
  renderTaskDetail,
  renderTaskList,
} from "../view.js";

export const ADD_HELP = `usage: tasks-axi add <id> "<title>" [flags]
aliases: create
flags:
  --kind <ship|scout|docs|...>, --repo <name>, --body <text> or --body-file <path>
  --start (place in In flight) | --queue (place in Queued, default)
  --blocked-by <id> (repeatable), --pr <url>, --report <path>, --priority <0-4>
  --mint [--prefix <p>]   mint a slug-xx id from the title instead of passing one
examples:
  tasks-axi add lavish-foo-q9 "fix summary toggle" --kind ship --repo lavish-axi --start
  tasks-axi add fm-x "adopt lease" --blocked-by treehouse-lease-t4
  tasks-axi add "quick note" --mint`;

export const LIST_HELP = `usage: tasks-axi list [flags]
flags:
  --state <queued|in_flight|done>, --repo <name>, --kind <name>, --blocked
  --limit <n>, --fields <a,b,c>  (extra: ${Object.keys(LIST_EXTRA_FIELDS)
    .sort()
    .join(", ")})
examples:
  tasks-axi list --state queued
  tasks-axi list --repo no-mistakes --fields blocked_by,created
  tasks-axi list --blocked`;

export const SHOW_HELP = `usage: tasks-axi show <id> [--full]
aliases: view
examples:
  tasks-axi show homemux-h7
  tasks-axi show homemux-h7 --full`;

export const UPDATE_HELP = `usage: tasks-axi update <id> [flags]
aliases: edit
flags:
  --title <text>, --body <text> or --body-file <path>, --append "<note>"
  --repo <name>, --kind <name>, --priority <0-4>, --pr <url>, --report <path>
examples:
  tasks-axi update nm-release-validation --append "step 3 in progress on lavish #87"
  tasks-axi update fm-x --repo firstmate --kind ship`;

export const RM_HELP = `usage: tasks-axi rm <id>
aliases: delete
examples:
  tasks-axi rm stale-task-q1`;

function parseDeps(args: string[]): Dep[] {
  return takeAllFlags(args, "--blocked-by").map((id) => ({
    type: "blocked-by" as const,
    id: validateDependencyId(id),
  }));
}

function parseLinks(pr?: string, report?: string): TaskLink[] {
  const links: TaskLink[] = [];
  if (pr) links.push({ kind: "pr", url: pr });
  if (report) links.push({ kind: "report", url: report });
  return links;
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0 || n > 4) {
    throw new AxiError("--priority must be an integer 0-4", "VALIDATION_ERROR");
  }
  return n;
}

export async function addCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const kind = takeFlag(args, "--kind");
  const repo = takeFlag(args, "--repo");
  const body = takeBody(args);
  const pr = takeFlag(args, "--pr");
  const report = takeFlag(args, "--report");
  const priority = parsePriority(takeFlag(args, "--priority"));
  const deps = parseDeps(args);
  const start = takeBoolFlag(args, "--start");
  takeBoolFlag(args, "--queue");
  const mint = takeBoolFlag(args, "--mint");
  const prefix = takeFlag(args, "--prefix");
  const titleFlag = takeFlag(args, "--title");

  const positionals = args.filter((a) => !a.startsWith("-"));
  let id: string;
  let title: string;
  if (mint) {
    title = titleFlag ?? positionals[0] ?? "";
    if (!title) {
      throw new AxiError("--mint requires a title", "VALIDATION_ERROR", [
        'Run `tasks-axi add "<title>" --mint`',
      ]);
    }
    id = mintId(title, prefix);
  } else {
    id = validateId(requireId(positionals[0], "id"));
    title = titleFlag ?? positionals[1] ?? "";
    if (!title) {
      throw new AxiError("A title is required", "VALIDATION_ERROR", [
        'Run `tasks-axi add <id> "<title>"`',
      ]);
    }
  }

  // Idempotent: an existing id is a no-op that reports the current task.
  const existing = await store.get(id);
  if (existing) {
    const all = (await store.list({})).items;
    const blocks = [
      "already: true",
      renderTaskDetail(existing, all, false),
    ];
    return renderOutput(blocks);
  }

  const state: State = start ? "in_flight" : "queued";
  const input: TaskInput = { id, title, state, deps, links: parseLinks(pr, report) };
  if (kind) input.kind = kind;
  if (repo) input.repo = repo;
  if (body !== undefined) input.body = body;
  if (priority !== undefined) input.priority = priority;

  const task = await store.create(input);
  const all = (await store.list({})).items;
  const blocks = [
    renderTaskDetail(task, all, false),
    renderHelp(getSuggestions({ action: "add", id })),
  ];
  return renderOutput(blocks);
}

export async function listCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const { extraDefs } = parseFields(takeFlag(args, "--fields"), LIST_EXTRA_FIELDS);
  const state = getFlag(args, "--state") as State | undefined;
  const repo = getFlag(args, "--repo");
  const kind = getFlag(args, "--kind");
  const onlyBlocked = hasFlag(args, "--blocked");
  const limitRaw = getFlag(args, "--limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  // The full set is needed to derive `blocked` (a dep-graph projection), so the
  // list command filters in the CLI rather than pushing every filter to the
  // store. The store's own filtering is exercised by `home` and `ready`.
  const all = (await store.list({})).items;
  const blocked = blockedIds(all);

  let matched = all;
  if (state) matched = matched.filter((t) => t.state === state);
  if (repo) matched = matched.filter((t) => t.repo === repo);
  if (kind) matched = matched.filter((t) => (t.kind ?? "task") === kind);
  if (onlyBlocked) matched = matched.filter((t) => blocked.has(t.id));

  const total = matched.length;
  const items =
    limit !== undefined && limit >= 0 ? matched.slice(0, limit) : matched;
  const isEmpty = items.length === 0;

  const countLine = formatCountLine({
    count: items.length,
    limit,
    totalCount: total,
  });

  const blocks: string[] = [countLine];
  if (isEmpty) {
    blocks.push(emptyState(state, repo, kind, onlyBlocked));
  } else {
    blocks.push(renderTaskList("tasks", items, all, extraDefs));
  }
  blocks.push(renderHelp(getSuggestions({ action: "list", isEmpty })));
  return renderOutput(blocks);
}

function emptyState(
  state: string | undefined,
  repo: string | undefined,
  kind: string | undefined,
  blocked: boolean,
): string {
  const qualifiers = [
    blocked ? "blocked" : "",
    state ?? "",
    kind ? `kind=${kind}` : "",
    repo ? `repo=${repo}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const scope = qualifiers ? `${qualifiers} ` : "";
  return `tasks: 0 ${scope}tasks in this backlog`;
}

export async function showCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const full = takeBoolFlag(args, "--full");
  const id = requireId(getPositional(args, 0), "id");

  const task = await store.get(id);
  if (!task) throw notFound(id);

  const all = (await store.list({})).items;
  const isBlocked = blockedIds(all).has(id);

  const blocks = [renderTaskDetail(task, all, full)];
  const help = getSuggestions({ action: "show", id, blocked: isBlocked });
  if (help.length > 0) blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

export async function updateCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const append = takeFlag(args, "--append");
  const repo = takeFlag(args, "--repo");
  const kind = takeFlag(args, "--kind");
  const priority = parsePriority(takeFlag(args, "--priority"));
  const pr = takeFlag(args, "--pr");
  const report = takeFlag(args, "--report");
  const id = requireId(args.find((a) => !a.startsWith("-")), "id");

  const patch: TaskPatch = {};
  if (title !== undefined) patch.title = title;
  if (body !== undefined) patch.body = body;
  if (append !== undefined) patch.appendBody = append;
  if (repo !== undefined) patch.repo = repo;
  if (kind !== undefined) patch.kind = kind;
  if (priority !== undefined) patch.priority = priority;
  const addLinks = parseLinks(pr, report);
  if (addLinks.length > 0) patch.addLinks = addLinks;

  if (Object.keys(patch).length === 0) {
    throw new AxiError("Nothing to update", "VALIDATION_ERROR", [
      'Pass a field, e.g. --append "<note>", --title, --body, --repo, --kind',
    ]);
  }

  if (!(await store.get(id))) throw notFound(id);
  const task = await store.update(id, patch);
  const all = (await store.list({})).items;
  const blocks = [
    renderTaskDetail(task, all, false),
    renderHelp(getSuggestions({ action: "update", id })),
  ];
  return renderOutput(blocks);
}

export async function rmCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const id = requireId(getPositional([...rawArgs], 0), "id");

  if (!(await store.get(id))) throw notFound(id);
  await store.remove(id);

  const blocks = [
    `removed:\n  id: ${id}`,
    renderHelp(getSuggestions({ action: "rm", id })),
  ];
  return renderOutput(blocks);
}
