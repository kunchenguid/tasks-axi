import {
  parseNonNegativeIntegerFlag,
  parseStateFlag,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderMutation } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { unsupported } from "../errors.js";
import { getSuggestions } from "../suggestions.js";

export const PRUNE_HELP = `usage: tasks-axi prune [--keep <n>] [--state done]
Trim a section to the N most recent tasks, archiving the rest (never deletes).
flags:
  --keep <n>   tasks to retain (default from config, usually 10)
  --state <queued|in_flight|done>   section to prune (default done)
  --json   print the result as a JSON object
examples:
  tasks-axi prune --keep 10`;

export const RENDER_HELP = `usage: tasks-axi render
Normalize the backlog file: rewrite every id'd task in canonical form.
Free-form lines are left untouched.
flags:
  --json   print the result as a JSON object`;

export async function pruneCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];

  const json = takeBoolFlag(args, "--json");
  if (!store.prune) {
    throw unsupported("prune", store.capabilities().backend);
  }

  const keepRaw = takeFlag(args, "--keep");
  const keep = parseNonNegativeIntegerFlag("--keep", keepRaw, config.doneKeep);
  const state = parseStateFlag("--state", takeFlag(args, "--state"), "done");
  requirePositionals(args, 0, 0, PRUNE_HELP.split("\n")[0]);

  const result = await store.prune({ state, keep, archive: true });

  return renderMutation({
    json,
    confirm: `prune ${state} -> archived ${result.archived} (kept ${keep})`,
    jsonPayload: {
      ok: true,
      action: "prune",
      state,
      kept: keep,
      archived: result.archived,
      ids: result.ids,
    },
    suggestions: getSuggestions({
      action: "prune",
      globals: context?.suggestionGlobals,
    }),
  });
}

export async function renderCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, RENDER_HELP.split("\n")[0]);
  if (!store.render) {
    throw unsupported("render", store.capabilities().backend);
  }
  const count = await store.render();
  return renderMutation({
    json,
    confirm: `render -> normalized ${count}`,
    jsonPayload: { ok: true, action: "render", normalized: count },
    suggestions: getSuggestions({
      action: "render",
      globals: context?.suggestionGlobals,
    }),
  });
}
