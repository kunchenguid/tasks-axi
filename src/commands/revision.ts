import { encode } from "@toon-format/toon";
import { MarkdownStore } from "../backends/markdown.js";
import { resolveBacklogTarget } from "../backlog-path.js";
import {
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { unsupported } from "../errors.js";
import { REVISION_SCHEMA_VERSION } from "../revision.js";

export const REVISION_HELP = `usage: tasks-axi revision [--to <path-or-dir>] [--json]
Read an authoritative v1 revision for the current markdown mutation owner.
With --to, both source and destination revisions are read under one ordered lock set.
The opaque tokens bind exact bytes, missing-file state, and canonical owner identity.
Use the returned tokens with tasks-axi mv --cas; callers must not compute tokens themselves.
flags:
  --to <path-or-dir>  include the destination owner used by mv
  --json              print the revision snapshot as JSON
examples:
  tasks-axi revision --json
  tasks-axi revision --to ../worker/data/backlog.md --json`;

export async function revisionCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const to = requireNonEmptySingleLineFlagValue("--to", takeFlag(args, "--to"));
  requirePositionals(args, 0, 0, REVISION_HELP.split("\n")[0]);

  let revisions: unknown;
  if (to !== undefined) {
    if (!store.readMoveRevisions) {
      throw unsupported("owner revisions", store.capabilities().backend);
    }
    const target = new MarkdownStore({ path: resolveBacklogTarget(to) });
    const snapshot = await store.readMoveRevisions(target);
    revisions = snapshot;
  } else {
    if (!store.readOwnerRevision) {
      throw unsupported("owner revisions", store.capabilities().backend);
    }
    revisions = {
      schema_version: REVISION_SCHEMA_VERSION,
      source: await store.readOwnerRevision(),
    };
  }

  const payload = { ok: true, action: "revision", revisions };
  return json ? renderJson(payload) : encode(payload);
}
