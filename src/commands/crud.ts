import {
  parseOptionalNonNegativeIntegerFlag,
  requireNonEmptyFlagValue,
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  requireId,
  takeAllFlags,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { takeBody } from "../body.js";
import { deriveLinks, extractTags } from "../backends/markdown-grammar.js";
import { renderMutation, stateLabel, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { blockedIds, heldTasks } from "../derive.js";
import { AxiError, notFound } from "../errors.js";
import { parseFields } from "../fields.js";
import { formatCountLine } from "../format.js";
import {
  MINT_SUFFIXES,
  mintId,
  mintIdForSuffix,
  validateDependencyId,
  validateId,
} from "../id.js";
import {
  STATES,
  type Dep,
  type State,
  type TaskInput,
  type TaskLink,
  type TaskPatch,
  type TaskUpdateChange,
} from "../model.js";
import type { Store } from "../store.js";
import { getSuggestions } from "../suggestions.js";
import { renderHelp, renderOutput, renderScalar } from "../toon.js";
import {
  LIST_EXTRA_FIELDS,
  renderTaskDetail,
  renderTaskList,
  showFullTextHint,
} from "../view.js";

export const ADD_HELP = `usage: tasks-axi add <id> "<title>" [flags]
aliases: create
flags:
  --kind <ship|scout|docs|...>, --repo <name>, --body <text> or --body-file <path>
  --start (place in In flight) | --queue (place in Queued, default)
  --blocked-by <id> (repeatable, must exist), --pr <url>, --report <path>, --priority <0-4>
  --mint [--prefix <p>]   mint a slug-xx id from the title instead of passing one
  --json   print the resulting task as a JSON object
examples:
  tasks-axi add lavish-foo-q9 "fix summary toggle" --kind ship --repo lavish-axi --start
  tasks-axi add fm-x "adopt lease" --blocked-by treehouse-lease-t4
  tasks-axi add "quick note" --mint`;

export const LIST_HELP = `usage: tasks-axi list [flags]
flags:
  --state <queued|in_flight|done|held>, --repo <name>, --kind <name>, --blocked
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
  --title <text>, --body <text> or --body-file <path>
  --archive-body   with --body/--body-file, archive the previous body
  --repo <name>, --kind <name>, --priority <0-4>, --pr <url>, --report <path>
  --json   print the resulting task as a JSON object
examples:
  tasks-axi show nm-release-validation --full
  tasks-axi update nm-release-validation --body-file notes.md --archive-body
  tasks-axi update fm-x --repo firstmate --kind ship`;

export const RM_HELP = `usage: tasks-axi rm <id>
aliases: delete
Fails while active tasks still block on this id.
flags:
  --json   print the result as a JSON object
examples:
  tasks-axi rm stale-task-q1`;

function parseDeps(args: string[]): Dep[] {
  return takeAllFlags(args, "--blocked-by").map((id) => ({
    type: "blocked-by" as const,
    id: validateDependencyId(id),
  }));
}

async function requireExistingBlockers(
  store: Store,
  deps: Dep[],
): Promise<void> {
  for (const dep of deps) {
    if (dep.type !== "blocked-by") continue;
    if (await store.get(dep.id)) continue;
    throw new AxiError(`blocker "${dep.id}" not found`, "VALIDATION_ERROR", [
      "Create the blocker task first, or choose an existing task id",
    ]);
  }
}

function requireSafeTagFlagValue(
  flag: string,
  value: string | undefined,
): string | undefined {
  const checked = requireNonEmptySingleLineFlagValue(flag, value);
  if (checked === undefined) return undefined;
  if (/[()]/.test(checked)) {
    throw new AxiError(
      `${flag} must not contain parentheses`,
      "VALIDATION_ERROR",
      [`Pass ${flag}=... without parentheses`],
    );
  }
  return checked.trim();
}

function requireTypedLinkUrl(
  flag: "--pr" | "--report",
  kind: TaskLink["kind"],
  value: string | undefined,
): string | undefined {
  const checked = requireNonEmptyFlagValue(flag, value);
  if (checked === undefined) return undefined;
  if (/[\r\n]/.test(checked)) {
    throw new AxiError(`${flag} must be a single line`, "VALIDATION_ERROR", [
      `Pass ${flag}=... without line breaks`,
    ]);
  }
  const url = checked.trim();
  if (
    !deriveLinks(url).some((link) => link.kind === kind && link.url === url)
  ) {
    const expected =
      kind === "pr"
        ? "an http(s) pull request URL ending in /pull/<number>"
        : "a data/<id>/report.md path";
    throw new AxiError(`${flag} must be ${expected}`, "VALIDATION_ERROR");
  }
  return url;
}

function parseLinks(pr?: string, report?: string): TaskLink[] {
  const links: TaskLink[] = [];
  const checkedPr = requireTypedLinkUrl("--pr", "pr", pr);
  const checkedReport = requireTypedLinkUrl("--report", "report", report);
  if (checkedPr !== undefined) links.push({ kind: "pr", url: checkedPr });
  if (checkedReport !== undefined) {
    links.push({ kind: "report", url: checkedReport });
  }
  return links;
}

type ListState = State | "held";

function parseListStateFlag(raw: string | undefined): ListState | undefined {
  if (raw === undefined) return undefined;
  if (raw === "held") return raw;
  if ((STATES as readonly string[]).includes(raw)) return raw as State;
  throw new AxiError(
    "--state must be one of queued, in_flight, done, held",
    "VALIDATION_ERROR",
  );
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-4]$/.test(raw)) {
    throw new AxiError("--priority must be an integer 0-4", "VALIDATION_ERROR");
  }
  return Number(raw);
}

function requireTitle(
  raw: string,
  message: string,
  suggestion: string,
): string {
  if (/[\r\n]/.test(raw)) {
    throw new AxiError("Task title must be a single line", "VALIDATION_ERROR");
  }
  const title = raw.trim();
  if (title === "") {
    throw new AxiError(message, "VALIDATION_ERROR", [suggestion]);
  }
  if (extractTags(title).title !== title) {
    throw new AxiError(
      "Task title must not end with canonical task tags",
      "VALIDATION_ERROR",
    );
  }
  return title;
}

async function mintAvailableId(
  store: Store,
  title: string,
  prefix?: string,
): Promise<string> {
  const first = mintId(title, prefix);
  if (!(await store.get(first))) return first;

  for (const suffix of MINT_SUFFIXES) {
    const candidate = mintIdForSuffix(title, suffix, prefix);
    if (candidate === first) continue;
    if (!(await store.get(candidate))) return candidate;
  }

  throw new AxiError("Could not mint a unique id for this title", "CONFLICT", [
    'Pass an explicit id, e.g. `tasks-axi add <id> "title"`',
  ]);
}

export async function addCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const kind = requireSafeTagFlagValue("--kind", takeFlag(args, "--kind"));
  const repo = requireSafeTagFlagValue("--repo", takeFlag(args, "--repo"));
  const body = requireNonEmptyFlagValue("--body", takeBody(args));
  const pr = takeFlag(args, "--pr");
  const report = takeFlag(args, "--report");
  const priority = parsePriority(takeFlag(args, "--priority"));
  const deps = parseDeps(args);
  const json = takeBoolFlag(args, "--json");
  const start = takeBoolFlag(args, "--start");
  const queue = takeBoolFlag(args, "--queue");
  const mint = takeBoolFlag(args, "--mint");
  const rawPrefix = takeFlag(args, "--prefix");
  const titleFlag = takeFlag(args, "--title");

  if (start && queue) {
    throw new AxiError(
      "Use only one of --start or --queue",
      "VALIDATION_ERROR",
    );
  }
  if (rawPrefix !== undefined && !mint) {
    throw new AxiError(
      "--prefix can only be used with --mint",
      "VALIDATION_ERROR",
      ['Run `tasks-axi add "<title>" --mint --prefix <p>`, or omit --prefix'],
    );
  }
  const prefix = requireNonEmptySingleLineFlagValue("--prefix", rawPrefix);

  const positionals = requirePositionals(
    args,
    mint ? 0 : 1,
    titleFlag === undefined ? (mint ? 1 : 2) : mint ? 0 : 1,
    ADD_HELP.split("\n")[0],
  );
  let id: string;
  let title: string;
  if (mint) {
    title = requireTitle(
      titleFlag ?? positionals[0] ?? "",
      "--mint requires a title",
      'Run `tasks-axi add "<title>" --mint`',
    );
    id = await mintAvailableId(store, title, prefix);
  } else {
    id = validateId(requireId(positionals[0], "id"));
    title = requireTitle(
      titleFlag ?? positionals[1] ?? "",
      "A title is required",
      'Run `tasks-axi add <id> "<title>"`',
    );
  }

  if (deps.some((dep) => dep.id === id)) {
    throw new AxiError("A task cannot block itself", "VALIDATION_ERROR");
  }
  await requireExistingBlockers(store, deps);
  const links = parseLinks(pr, report);

  if (!mint) {
    const existing = await store.get(id);
    if (existing) {
      const all = (await store.list({})).items;
      return renderMutation({
        json,
        confirm: `add ${id} already exists -> ${stateLabel(existing.state)}`,
        already: true,
        jsonPayload: {
          ok: true,
          action: "add",
          already: true,
          task: taskToJson(existing, all),
        },
        detail: renderTaskDetail(
          existing,
          all,
          false,
          showFullTextHint(existing),
        ),
        suggestions: getSuggestions({
          action: "add",
          id,
          state: existing.state,
          globals: context?.suggestionGlobals,
        }),
      });
    }
  }

  const state: State = start ? "in_flight" : "queued";
  const input: TaskInput = {
    id,
    title,
    state,
    deps,
    links,
  };
  if (kind) input.kind = kind;
  if (repo) input.repo = repo;
  if (body !== undefined) input.body = body;
  if (priority !== undefined) input.priority = priority;

  const task = await store.create(input);
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: `added ${id}${addAttrs(task)} -> ${stateLabel(task.state)}`,
    jsonPayload: { ok: true, action: "add", task: taskToJson(task, all) },
    detail: renderTaskDetail(task, all, false, showFullTextHint(task)),
    suggestions: getSuggestions({
      action: "add",
      id,
      state: task.state,
      globals: context?.suggestionGlobals,
    }),
  });
}

/** The `(kind, repo X)` parenthetical for an add confirmation, omitted when bare. */
function addAttrs(task: { kind?: string; repo?: string }): string {
  const parts: string[] = [];
  if (task.kind) parts.push(task.kind);
  if (task.repo) parts.push(`repo ${task.repo}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export async function listCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const { extraDefs } = parseFields(
    takeFlag(args, "--fields"),
    LIST_EXTRA_FIELDS,
  );
  const state = parseListStateFlag(takeFlag(args, "--state"));
  const repo = requireNonEmptySingleLineFlagValue(
    "--repo",
    takeFlag(args, "--repo"),
  );
  const kind = requireNonEmptySingleLineFlagValue(
    "--kind",
    takeFlag(args, "--kind"),
  );
  const onlyBlocked = takeBoolFlag(args, "--blocked");
  const limit = parseOptionalNonNegativeIntegerFlag(
    "--limit",
    takeFlag(args, "--limit"),
  );
  requirePositionals(args, 0, 0, LIST_HELP.split("\n")[0]);

  // The full set is needed to derive `blocked` (a dep-graph projection), so the
  // list command filters in the CLI rather than pushing every filter to the
  // store. The store's own filtering is exercised by `home` and `ready`.
  const all = (await store.list({})).items;
  const blocked = blockedIds(all);
  const held = new Set(heldTasks(all).map((t) => t.id));

  let matched = all;
  if (state === "held") {
    matched = matched.filter((t) => held.has(t.id));
  } else if (state) {
    matched = matched.filter((t) => t.state === state);
  }
  if (repo) matched = matched.filter((t) => t.repo === repo);
  if (kind) matched = matched.filter((t) => (t.kind ?? "task") === kind);
  if (onlyBlocked) matched = matched.filter((t) => blocked.has(t.id));

  const total = matched.length;
  const items =
    limit !== undefined && limit >= 0 ? matched.slice(0, limit) : matched;
  const isEmpty = total === 0;

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
  blocks.push(
    renderHelp(
      getSuggestions({
        action: "list",
        isEmpty,
        globals: context?.suggestionGlobals,
        filters: {
          ...(state !== undefined ? { state } : {}),
          ...(repo !== undefined ? { repo } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
      }),
    ),
  );
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
  return renderScalar("tasks", `0 ${scope}tasks in this backlog`);
}

export async function showCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const full = takeBoolFlag(args, "--full");
  const positionals = requirePositionals(args, 1, 1, SHOW_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  const task = await store.get(id);
  if (!task) throw notFound(id, { globals: context?.suggestionGlobals });

  const all = (await store.list({})).items;
  const isBlocked = blockedIds(all).has(id);

  const blocks = [renderTaskDetail(task, all, full)];
  const help = getSuggestions({
    action: "show",
    id,
    blocked: isBlocked,
    globals: context?.suggestionGlobals,
  });
  if (help.length > 0) blocks.push(renderHelp(help));
  return renderOutput(blocks);
}

export async function updateCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];

  const json = takeBoolFlag(args, "--json");
  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const archiveBody = takeBoolFlag(args, "--archive-body");
  const repo = requireNonEmptySingleLineFlagValue(
    "--repo",
    takeFlag(args, "--repo"),
  );
  const kind = requireNonEmptySingleLineFlagValue(
    "--kind",
    takeFlag(args, "--kind"),
  );
  const priority = parsePriority(takeFlag(args, "--priority"));
  const pr = takeFlag(args, "--pr");
  const report = takeFlag(args, "--report");
  const positionals = requirePositionals(
    args,
    1,
    1,
    UPDATE_HELP.split("\n")[0],
  );
  const id = requireId(positionals[0], "id");

  const patch: TaskPatch = {};
  if (title !== undefined) {
    patch.title = requireTitle(
      title,
      "--title must not be empty",
      'Pass a non-empty title, e.g. --title "new title"',
    );
  }
  if (body !== undefined) {
    patch.body = requireNonEmptyFlagValue("--body", body);
    if (archiveBody) patch.archiveBody = true;
  }
  if (archiveBody && body === undefined) {
    throw new AxiError(
      "--archive-body requires --body or --body-file",
      "VALIDATION_ERROR",
      [
        "Inspect the current task first, then pass a replacement body with --body or --body-file",
      ],
    );
  }
  if (repo !== undefined) {
    patch.repo = repo;
  }
  if (kind !== undefined) {
    patch.kind = kind;
  }
  if (priority !== undefined) patch.priority = priority;
  const addLinks = parseLinks(pr, report);
  if (addLinks.length > 0) patch.addLinks = addLinks;

  if (Object.keys(patch).length === 0) {
    throw new AxiError("Nothing to update", "VALIDATION_ERROR", [
      "Pass a field, e.g. --title, --body, --body-file, --repo, or --kind",
    ]);
  }

  if (!(await store.get(id))) {
    throw notFound(id, { globals: context?.suggestionGlobals });
  }
  const result = await store.update(id, patch);
  const task = result.task;
  const changed = orderUpdateChanges(result.changed);
  const already = changed.length === 0;
  const all = (await store.list({})).items;
  return renderMutation({
    json,
    confirm: already
      ? `updated ${id} already`
      : `updated ${id} (${changed.join(", ")})`,
    already,
    jsonPayload: {
      ok: true,
      action: "update",
      ...(already ? { already: true } : {}),
      changed,
      task: taskToJson(task, all),
    },
    detail: renderTaskDetail(task, all, false, showFullTextHint(task)),
    suggestions: getSuggestions({
      action: "update",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}

function orderUpdateChanges(changed: TaskUpdateChange[]): TaskUpdateChange[] {
  const order: TaskUpdateChange[] = [
    "title",
    "body",
    "archive",
    "repo",
    "kind",
    "priority",
    "links",
    "hold",
    "meta",
  ];
  return order.filter((field) => changed.includes(field));
}

export async function rmCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, RM_HELP.split("\n")[0]);
  const id = requireId(positionals[0], "id");

  if (!(await store.get(id))) {
    throw notFound(id, { globals: context?.suggestionGlobals });
  }
  await store.remove(id);

  return renderMutation({
    json,
    confirm: `removed ${id}`,
    jsonPayload: { ok: true, action: "rm", id, removed: true },
    suggestions: getSuggestions({
      action: "rm",
      id,
      globals: context?.suggestionGlobals,
    }),
  });
}
