import { encode } from "@toon-format/toon";
import { requireCtx, type TasksContext } from "../context.js";
import { blockedIds, readyTasks } from "../derive.js";
import type { Task } from "../model.js";
import { DELIVERY_STATES, PUBLIC_FOLLOWUP_KIND } from "../public-followup.js";
import { getSuggestions, withSuggestionGlobals } from "../suggestions.js";
import { field, renderHelp, renderList, renderOutput } from "../toon.js";
import { showFullTextHint, toRow } from "../view.js";

export const HOME_HELP = "";

const QUEUED_PREVIEW = 10;

const inFlightSchema = [
  field("id"),
  field("title"),
  field("kind"),
  field("repo"),
];
const queuedSchema = [
  field("id"),
  field("title"),
  field("kind"),
  field("blocked_by"),
];

export async function homeCommand(
  _args: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const all = (await store.list({})).items;

  const inFlight = all.filter((t) => t.state === "in_flight");
  const queued = all.filter(
    (t) => t.state === "queued" && t.kind !== PUBLIC_FOLLOWUP_KIND,
  );
  const publicFollowups = all.filter(
    (t) => t.kind === PUBLIC_FOLLOWUP_KIND && t.public_followup,
  );
  const doneCount = all.filter((t) => t.state === "done").length;
  const blocked = blockedIds(all);
  const readyCount = readyTasks(all).length;

  const rows = (tasks: Task[]) =>
    tasks.map((t) => toRow(t, { all, truncationHint: showFullTextHint(t) }));

  const blocks: string[] = [];

  blocks.push(
    inFlight.length > 0
      ? renderList("in_flight", rows(inFlight), inFlightSchema)
      : "in_flight: 0 tasks",
  );

  if (queued.length > 0) {
    const preview = queued.slice(0, QUEUED_PREVIEW);
    blocks.push(
      encode({ summary: { queued: queued.length, ready: readyCount } }),
    );
    blocks.push(renderList("queued", rows(preview), queuedSchema));
  } else {
    blocks.push("queued: 0 tasks");
  }

  if (publicFollowups.length > 0) {
    const counts = Object.fromEntries(
      DELIVERY_STATES.map((state) => [
        state,
        publicFollowups.filter(
          (task) => task.public_followup?.delivery.state === state,
        ).length,
      ]),
    );
    blocks.push(encode({ public_followups: counts }));
  } else {
    blocks.push("public_followups: 0 obligations");
  }

  blocks.push(`done: ${doneCount} retained`);

  const hints: string[] = [];
  if (queued.length > QUEUED_PREVIEW) {
    hints.push(
      `Run \`tasks-axi list --state queued\` for all ${queued.length} queued tasks`,
    );
  }
  if (blocked.size > 0) {
    hints.push("Run `tasks-axi ready` to see only unblocked work");
  }
  blocks.push(
    renderHelp([
      ...withSuggestionGlobals(hints, context?.suggestionGlobals),
      ...getSuggestions({
        action: "home",
        globals: context?.suggestionGlobals,
      }),
    ]),
  );

  return renderOutput(blocks);
}
