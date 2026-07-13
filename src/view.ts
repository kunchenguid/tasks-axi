import { truncate } from "./body.js";
import { activeBlockers, isHoldActive } from "./derive.js";
import type { Task } from "./model.js";
import { field, renderDetail, renderList, type FieldDef } from "./toon.js";

/**
 * Task → TOON projection (AXI house style §2, §3). Rows are built as full flat
 * records carrying every derivable field; the schema is the projection. The
 * default list schema is a compact 5 fields; everything else is opt-in via
 * `--fields`, validated against LIST_EXTRA_FIELDS.
 */

const TITLE_LIST_LIMIT = 80;
const BODY_LIMIT = 500;

export interface RowOptions {
  /** The full task set, for deriving active blockers. */
  all: Task[];
  /** Show untruncated title/body. */
  full?: boolean;
  /** Escape hatch text for truncated fields. */
  truncationHint?: string;
}

export function showFullTextHint(task: Task): string {
  return `use show ${task.id} --full to see complete text`;
}

export function toRow(task: Task, opts: RowOptions): Record<string, unknown> {
  const blockers = activeBlockers(task, opts.all);
  const held = isHoldActive(task);
  const title = task.public_followup?.request.public_safe_summary ?? task.title;
  return {
    id: task.id,
    title: opts.full
      ? title
      : truncate(title, TITLE_LIST_LIMIT, opts.truncationHint),
    state: task.state,
    blocked: blockers.length > 0 ? "yes" : "no",
    blocked_by: blockers.length > 0 ? blockers.join(",") : "none",
    held: held ? "yes" : "no",
    hold_reason: task.hold?.reason ?? "-",
    hold_kind: task.hold?.kind ?? "-",
    hold_until: task.hold?.until ?? "-",
    kind: task.kind ?? "task",
    repo: task.public_followup ? "-" : (task.repo ?? "-"),
    priority: task.priority ?? "-",
    created: task.created ?? "-",
    closed: task.closed ?? "-",
    delivery_state: task.public_followup?.delivery.state ?? "-",
    deps:
      task.deps.length > 0
        ? task.deps.map((d) => `${d.type}:${d.id}`).join(",")
        : "none",
    links:
      !task.public_followup && task.links.length > 0
        ? task.links.map((l) => `${l.kind}:${l.url}`).join(",")
        : "none",
    body: task.public_followup
      ? ""
      : opts.full
        ? (task.body ?? "")
        : truncate(task.body, BODY_LIMIT, opts.truncationHint),
  };
}

export const LIST_DEFAULT: FieldDef[] = [
  field("id"),
  field("state"),
  field("kind"),
  field("repo"),
  field("title"),
];

/** Allow-list of additional list columns requestable with `--fields a,b,c`. */
export const LIST_EXTRA_FIELDS: Record<string, FieldDef> = {
  blocked: field("blocked"),
  blocked_by: field("blocked_by"),
  body: field("body"),
  created: field("created"),
  closed: field("closed"),
  delivery_state: field("delivery_state"),
  deps: field("deps"),
  held: field("held"),
  hold_kind: field("hold_kind"),
  hold_reason: field("hold_reason"),
  hold_until: field("hold_until"),
  links: field("links"),
  priority: field("priority"),
};

const DETAIL_SCHEMA: FieldDef[] = [
  field("id"),
  field("title"),
  field("state"),
  field("blocked"),
  field("blocked_by"),
  field("held"),
  field("hold_reason"),
  field("hold_kind"),
  field("hold_until"),
  field("kind"),
  field("repo"),
  field("priority"),
  field("created"),
  field("closed"),
  field("deps"),
  field("links"),
  field("body"),
];

export function renderTaskList(
  label: string,
  tasks: Task[],
  all: Task[],
  extra: FieldDef[] = [],
): string {
  const rows = tasks.map((t) =>
    toRow(t, {
      all,
      truncationHint: showFullTextHint(t),
    }),
  );
  return renderList(label, rows, [...LIST_DEFAULT, ...extra]);
}

export function renderTaskDetail(
  task: Task,
  all: Task[],
  full: boolean,
  truncationHint?: string,
): string {
  const row = toRow(task, { all, full, truncationHint });
  return renderDetail("task", row, DETAIL_SCHEMA);
}
