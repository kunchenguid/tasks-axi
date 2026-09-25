import { AxiError } from "../errors.js";
import { validateDependencyId } from "../id.js";
import type { Dep, Hold, TaskLink } from "../model.js";
import { HOLD_KINDS } from "../model.js";
import { PR_URL_EXPECTED } from "../pr-url.js";
import { deriveLinks, extractTags } from "./markdown-grammar.js";

/**
 * Backend-independent Task field normalization and validation, shared by every
 * Store implementation so a task accepted by one backend is accepted by all.
 * The grammar-shaped constraints (single-line values, no parentheses in tag
 * values, canonical-tag-free titles) are deliberately kept for non-markdown
 * backends too: they guarantee any task can be rendered into the canonical
 * markdown form (used by the beads backend's mirror and by `mv`).
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEP_REASON_EDGE_MARKER_RE =
  /(?:^|\s)(?:blocked-by|parent|discovered-from):\s/;

export function normalizeTitle(title: string): string {
  if (/[\r\n]/.test(title)) {
    throw new AxiError("Task title must be a single line", "VALIDATION_ERROR");
  }
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new AxiError("Task title must not be empty", "VALIDATION_ERROR");
  }
  if (extractTags(trimmed).title !== trimmed) {
    throw new AxiError(
      "Task title must not end with canonical task tags",
      "VALIDATION_ERROR",
    );
  }
  return trimmed;
}

export function normalizeTagValue(
  value: string | undefined,
  field: "kind" | "repo",
): string | undefined {
  if (value === undefined) return undefined;
  if (/[()\r\n]/.test(value)) {
    throw new AxiError(
      `Task ${field} must be a single line without parentheses`,
      "VALIDATION_ERROR",
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeLinkUrl(url: string): string {
  if (/[\r\n]/.test(url)) {
    throw new AxiError("Task link must be a single line", "VALIDATION_ERROR");
  }
  const trimmed = url.trim();
  if (trimmed === "") {
    throw new AxiError("Task link must not be empty", "VALIDATION_ERROR");
  }
  return trimmed;
}

export function normalizeTypedLink(link: TaskLink): TaskLink {
  const normalized = normalizeLinkUrl(link.url);
  // pr URLs must already be canonical; padded input is rejected, not trimmed
  const url = link.kind === "pr" ? link.url : normalized;
  const derived = deriveLinks(url);
  if (
    !derived.some(
      (candidate) => candidate.kind === link.kind && candidate.url === url,
    )
  ) {
    const expected =
      link.kind === "pr"
        ? PR_URL_EXPECTED
        : link.kind === "report"
          ? "a data/<id>/report.md path"
          : "an http(s) URL";
    throw new AxiError(
      `Task ${link.kind} link must be ${expected}`,
      "VALIDATION_ERROR",
    );
  }
  return { kind: link.kind, url };
}

export function normalizePriority(
  priority: number | undefined,
): number | undefined {
  if (priority === undefined) return undefined;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new AxiError(
      "Task priority must be an integer 0-4",
      "VALIDATION_ERROR",
    );
  }
  return priority;
}

export function normalizeHold(hold: Hold | undefined): Hold | undefined {
  if (hold === undefined) return undefined;
  if (/[\r\n()]/.test(hold.reason)) {
    throw new AxiError(
      "Task hold reason must be a single line without parentheses",
      "VALIDATION_ERROR",
    );
  }
  const reason = hold.reason.trim();
  if (reason === "") {
    throw new AxiError(
      "Task hold reason must not be empty",
      "VALIDATION_ERROR",
    );
  }
  const normalized: Hold = { reason };
  if (hold.kind !== undefined) {
    if (!(HOLD_KINDS as readonly string[]).includes(hold.kind)) {
      throw new AxiError(
        `Task hold kind must be one of ${HOLD_KINDS.join(", ")}`,
        "VALIDATION_ERROR",
      );
    }
    normalized.kind = hold.kind;
  }
  if (hold.until !== undefined) {
    normalized.until = normalizeDate(hold.until, "hold-until date");
  }
  return normalized;
}

export function normalizeDate(value: string, field: string): string {
  if (!DATE_RE.test(value)) {
    throw new AxiError(`Task ${field} must be YYYY-MM-DD`, "VALIDATION_ERROR");
  }
  return value;
}

function normalizeDepReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  if (/[\r\n]/.test(reason)) {
    throw new AxiError(
      "Task dependency reason must be a single line",
      "VALIDATION_ERROR",
    );
  }
  const trimmed = reason.trim();
  if (DEP_REASON_EDGE_MARKER_RE.test(trimmed)) {
    throw new AxiError(
      "Task dependency reason must not contain dependency markers",
      "VALIDATION_ERROR",
    );
  }
  return trimmed === "" ? undefined : trimmed;
}

export function normalizeDep(ownerId: string, dep: Dep): Dep {
  const reason = normalizeDepReason(dep.reason);
  const checked: Dep = { ...dep, id: validateDependencyId(dep.id) };
  if (reason === undefined) {
    delete checked.reason;
  } else {
    checked.reason = reason;
  }
  if (checked.id === ownerId) {
    throw new AxiError("A task cannot block itself", "VALIDATION_ERROR");
  }
  return checked;
}

export function appendTitleLink(title: string, link: TaskLink): string {
  const { url } = normalizeTypedLink(link);
  if (deriveLinks(title).some((link) => link.url === url)) return title;
  return normalizeTitle(`${title} ${url}`);
}

export function bodyHasLine(body: string | undefined, line: string): boolean {
  return body?.split("\n").includes(line) ?? false;
}

export function addBodyLine(body: string | undefined, line: string): string {
  return body ? `${body}\n${line}` : line;
}

export function sameHold(
  left: Hold | undefined,
  right: Hold | undefined,
): boolean {
  return (
    left?.reason === right?.reason &&
    left?.kind === right?.kind &&
    left?.until === right?.until
  );
}

export function sameMeta(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(left?.[key], right?.[key]))
  );
}
