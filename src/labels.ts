import { AxiError } from "./errors.js";
import type { Task } from "./model.js";

/**
 * Labels are a generic multi-value topic/scenario tag set carried on every
 * task. The set is canonical: duplicates collapse and order is sorted, so the
 * markdown `(labels: a, b)` token is idempotent across re-renders.
 *
 * Name validation happens at the CLI boundary (conservative charset, bounded
 * length). The grammar accepts hand-edited values without name validation,
 * like dangling `blocked-by` ids. Backend create and label-update operations
 * enforce token safety (no commas, parentheses, or line breaks) on supplied
 * values to keep the canonical tag parseable.
 */

/** Lowercase letters, digits, `-`, `_`, `.`, `/`, `:` (the `-` is last). */
export const LABEL_RE = /^[a-z0-9._:/-]+$/;

/** Longest accepted label name. */
export const LABEL_MAX_LENGTH = 64;

/**
 * Validate one label name at the CLI boundary, returning the trimmed name.
 * Throws an actionable VALIDATION_ERROR otherwise.
 */
export function validateLabel(flag: string, raw: string): string {
  if (raw.trim() === "") {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... with a non-empty label name`,
    ]);
  }
  const name = raw.trim();
  if (name.length > LABEL_MAX_LENGTH || !LABEL_RE.test(name)) {
    throw new AxiError(
      `invalid label "${name}": use ${LABEL_MAX_LENGTH} or fewer characters of lowercase letters, digits, '-', '_', '.', '/', ':'`,
      "VALIDATION_ERROR",
      [`e.g. ${flag} topic:t3 or ${flag} release-q3/checkout`],
    );
  }
  return name;
}

/**
 * Collapse a label list into the canonical set: trim, drop empties, dedupe,
 * sort. Lenient on purpose — hand-edited values are preserved, not rejected.
 */
export function canonicalizeLabels(names: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name !== "") seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Backend-side label normalization: token-safety first (commas, parentheses,
 * and line breaks would corrupt the canonical `(labels: a, b)` token), then
 * canonical set collapse. Returns [] for an empty/absent set.
 */
export function normalizeLabels(names: string[] | undefined): string[] {
  if (names === undefined) return [];
  for (const raw of names) {
    if (/[\r\n(),]/.test(raw)) {
      throw new AxiError(
        "Task labels must not contain commas, parentheses, or line breaks",
        "VALIDATION_ERROR",
      );
    }
  }
  return canonicalizeLabels(names);
}

/** Sorted-set equality (both sides are canonical, so index compare is exact). */
export function sameLabels(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/** True when the task carries every requested label (AND semantics). */
export function matchesLabels(
  task: Pick<Task, "labels">,
  required: readonly string[],
): boolean {
  return required.every((label) => task.labels?.includes(label) ?? false);
}
