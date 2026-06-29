/**
 * Confirmation-forward output for write operations (AXI house style §6, §9).
 *
 * Every mutation leads with a terse `ok:` line that confirms the *resulting
 * state*, not just the next step, so an agent can see what landed without a
 * follow-up read. The same verbs also accept `--json` for a deterministic,
 * machine-readable result object (the human-readable TOON form stays default).
 */

import { activeBlockers } from "./derive.js";
import type { State, Task } from "./model.js";
import { renderHelp, renderOutput } from "./toon.js";

const STATE_LABELS: Record<State, string> = {
  queued: "Queued",
  in_flight: "In flight",
  done: "Done",
};

/** Human-readable resulting-state name for confirmation lines. */
export function stateLabel(state: State): string {
  return STATE_LABELS[state];
}

/**
 * The leading confirmation line every mutation prints. Emitted as a plain
 * `ok: <message>` line (a top-level TOON scalar) so it stays a readable,
 * terse confirmation of the resulting state and a deterministic success
 * marker. Confirmation messages are built from bounded values (ids, names,
 * validated urls/paths, counts), so the line round-trips through TOON without
 * quoting; the `--json` form is the guaranteed-parseable machine signal.
 */
export function renderConfirm(message: string): string {
  return `ok: ${message}`;
}

/** Pretty-printed JSON result for `--json` (machine-readable, opt-in). */
export function renderJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

export interface MutationOutput {
  /** When true, emit the JSON payload instead of the human-readable blocks. */
  json: boolean;
  /** The machine-readable result object for `--json`. */
  jsonPayload: Record<string, unknown>;
  /** The leading `ok:` confirmation message (resulting state). */
  confirm: string;
  /** Emit the `already: true` no-op signal. */
  already?: boolean;
  /** An optional structured detail block (e.g. the full task record). */
  detail?: string;
  /** State-aware next-step hints (already resolved to lines). */
  suggestions?: string[];
}

/**
 * Assemble a mutation's output: a single JSON object under `--json`, otherwise
 * the confirmation-forward TOON blocks (confirm line, optional `already`,
 * optional detail, then state-aware hints).
 */
export function renderMutation(output: MutationOutput): string {
  if (output.json) return renderJson(output.jsonPayload);
  const blocks = [renderConfirm(output.confirm)];
  if (output.already) blocks.push("already: true");
  if (output.detail) blocks.push(output.detail);
  if (output.suggestions && output.suggestions.length > 0) {
    blocks.push(renderHelp(output.suggestions));
  }
  return renderOutput(blocks);
}

/**
 * Clean JSON projection of a task for `--json`: real values, untruncated text,
 * `null` for absent fields, plus the derived `blocked`/`blocked_by` when the
 * full task set is supplied.
 */
export function taskToJson(task: Task, all?: Task[]): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    state: task.state,
    kind: task.kind ?? null,
    repo: task.repo ?? null,
    priority: task.priority ?? null,
    created: task.created ?? null,
    closed: task.closed ?? null,
    deps: task.deps.map((d) => ({
      type: d.type,
      id: d.id,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
    })),
    links: task.links.map((l) => ({ kind: l.kind, url: l.url })),
    body: task.body ?? null,
  };
  if (all) {
    const blockers = activeBlockers(task, all);
    json.blocked = blockers.length > 0;
    json.blocked_by = blockers;
  }
  return json;
}
