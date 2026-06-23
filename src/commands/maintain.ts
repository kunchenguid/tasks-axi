import {
  parseNonNegativeIntegerFlag,
  parseStateFlag,
  requirePositionals,
  takeFlag,
} from "../args.js";
import { requireCtx, type TasksContext } from "../context.js";
import { unsupported } from "../errors.js";
import { getSuggestions } from "../suggestions.js";
import { field, renderDetail, renderHelp, renderOutput } from "../toon.js";

export const PRUNE_HELP = `usage: tasks-axi prune [--keep <n>] [--state done]
Trim a section to the N most recent tasks, archiving the rest (never deletes).
flags:
  --keep <n>   tasks to retain (default from config, usually 10)
  --state <queued|in_flight|done>   section to prune (default done)
examples:
  tasks-axi prune --keep 10`;

export const RENDER_HELP = `usage: tasks-axi render
Normalize the backlog file: rewrite every id'd task in canonical form.
Free-form lines are left untouched.`;

export async function pruneCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];

  if (!store.prune) {
    throw unsupported("prune", store.capabilities().backend);
  }

  const keepRaw = takeFlag(args, "--keep");
  const keep = parseNonNegativeIntegerFlag("--keep", keepRaw, config.doneKeep);
  const state = parseStateFlag("--state", takeFlag(args, "--state"), "done");
  requirePositionals(args, 0, 0, PRUNE_HELP.split("\n")[0]);

  const result = await store.prune({ state, keep, archive: true });

  return renderOutput([
    renderDetail(
      "prune",
      {
        state,
        kept: keep,
        archived: result.archived,
        ids: result.ids.length > 0 ? result.ids.join(",") : "none",
      },
      [field("state"), field("kept"), field("archived"), field("ids")],
    ),
    renderHelp(getSuggestions({ action: "prune" })),
  ]);
}

export async function renderCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  requirePositionals([...rawArgs], 0, 0, RENDER_HELP.split("\n")[0]);
  if (!store.render) {
    throw unsupported("render", store.capabilities().backend);
  }
  const count = await store.render();
  return renderOutput([
    renderDetail("render", { normalized: count }, [field("normalized")]),
  ]);
}
