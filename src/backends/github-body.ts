import { AxiError } from "../errors.js";
import type { Dep, Hold, Task } from "../model.js";
import { PUBLIC_FOLLOWUP_KIND } from "../public-followup.js";
import { ID_RE, buildProse, extractTags } from "./markdown-grammar.js";

/**
 * The managed block (design §4): one visible, fenced, versioned block at the
 * foot of the issue body that owns every structured field GitHub has no native
 * home for — including the queued/in-flight state tag (option B). The tag
 * syntax is character-for-character the canonical markdown tag grammar
 * (reused via `extractTags`/`buildProse`), so there is one tag grammar in the
 * codebase, not two; `(id:)` and `(state:)` are the only block-only tags.
 *
 * Validation is strict and loud: a mangled block is a structured read-time
 * error naming the issue, never a silent skip — E1 measured that GitHub's
 * pipeline round-trips the block byte-exactly, so any corruption is a
 * deliberate hand-edit the backend must surface.
 */

export const BLOCK_START = "<!-- tasks-axi:v1 -->";
export const BLOCK_END = "<!-- /tasks-axi -->";

/** Everything the managed block owns for one issue (design §4.1, §4.3). */
export interface ManagedFields {
  id: string;
  /** The queued/in-flight bit; tag absent means queued (option B). */
  inFlight: boolean;
  kind?: string;
  repo?: string;
  priority?: number;
  /** Explicit `(since DATE)` override of the native createdAt (migration case). */
  created?: string;
  hold?: Hold;
  deps: Dep[];
}

export interface ParsedIssueBody {
  /** The human prose (body minus the block), boundary blank lines dropped. */
  prose: string;
  /** Present iff the body carries the versioned managed block. */
  managed?: ManagedFields;
}

const ID_TAG_RE = /\(id:\s*([^()]*?)\s*\)/g;
const STATE_TAG_RE = /\(state:\s*([^()]*?)\s*\)/g;

function blockError(ref: string, detail: string): AxiError {
  return new AxiError(
    `Managed tasks-axi block on ${ref} is invalid: ${detail}`,
    "VALIDATION_ERROR",
    [
      "Fix the block by hand, or restore it from the last valid revision in the issue's edit history",
    ],
  );
}

function semantic(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function takeBlockTag(
  line: string,
  re: RegExp,
  name: string,
  ref: string,
): { value?: string; rest: string } {
  let value: string | undefined;
  const rest = line.replace(re, (_match, captured: string) => {
    if (value !== undefined) {
      throw blockError(ref, `duplicate (${name}:) tag`);
    }
    value = captured;
    return " ";
  });
  return { value, rest };
}

function parseTagLine(
  line: string,
  ref: string,
): Omit<ManagedFields, "deps"> & { deps: Dep[] } {
  const idTag = takeBlockTag(line, ID_TAG_RE, "id", ref);
  if (idTag.value === undefined) {
    throw blockError(ref, "missing (id:) tag");
  }
  if (!ID_RE.test(idTag.value)) {
    throw blockError(ref, `invalid task id "${idTag.value}"`);
  }
  const stateTag = takeBlockTag(idTag.rest, STATE_TAG_RE, "state", ref);
  if (stateTag.value !== undefined && stateTag.value !== "in-flight") {
    throw blockError(
      ref,
      `unknown (state:) value "${stateTag.value}" (only "in-flight"; queued is the tag's absence)`,
    );
  }

  const tags = extractTags(stateTag.rest);
  if (tags.duplicateSingletons.length > 0) {
    throw blockError(ref, `duplicate (${tags.duplicateSingletons[0]}:) tag`);
  }
  if (tags.title !== "") {
    throw blockError(ref, `unrecognized content "${tags.title}"`);
  }
  if (tags.closed !== undefined) {
    throw blockError(
      ref,
      "closure tags do not belong in the block; GitHub's native closed state owns the terminal boundary",
    );
  }
  if (tags.kind === PUBLIC_FOLLOWUP_KIND) {
    throw blockError(
      ref,
      "public-followup obligations are not supported by the github backend",
    );
  }

  const fields: Omit<ManagedFields, "deps"> & { deps: Dep[] } = {
    id: idTag.value,
    inFlight: stateTag.value === "in-flight",
    deps: tags.deps,
  };
  if (tags.kind !== undefined) fields.kind = tags.kind;
  if (tags.repo !== undefined) fields.repo = tags.repo;
  if (tags.priority !== undefined) fields.priority = tags.priority;
  if (tags.created !== undefined) fields.created = tags.created;
  if (tags.hold !== undefined) fields.hold = tags.hold;
  return fields;
}

function parseDepLine(line: string, ref: string): Dep[] {
  const tags = extractTags(line);
  if (
    tags.title !== "" ||
    tags.deps.length === 0 ||
    tags.kind !== undefined ||
    tags.repo !== undefined ||
    tags.priority !== undefined ||
    tags.created !== undefined ||
    tags.closed !== undefined ||
    tags.hold !== undefined
  ) {
    throw blockError(ref, `unrecognized dependency line "${line}"`);
  }
  return tags.deps;
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && semantic(lines[start]).trim() === "") start++;
  while (end > start && semantic(lines[end - 1]).trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Split an issue body into human prose and the managed block's fields.
 * No versioned start marker means the issue is invisible to tasks-axi,
 * exactly as a free-form markdown line is (decision D7's spirit).
 */
export function parseIssueBody(body: string, ref: string): ParsedIssueBody {
  const lines = body.split("\n");
  const startIdxs: number[] = [];
  const endIdxs: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = semantic(line).trim();
    if (trimmed === BLOCK_START) startIdxs.push(index);
    if (trimmed === BLOCK_END) endIdxs.push(index);
  });

  if (startIdxs.length === 0) {
    if (body.includes(BLOCK_START)) {
      throw blockError(ref, "the start marker is not on its own line");
    }
    if (endIdxs.length > 0 || body.includes(BLOCK_END)) {
      throw blockError(ref, "end marker without a start marker");
    }
    return { prose: trimBoundaryBlankLines(lines).join("\n") };
  }
  if (startIdxs.length > 1) {
    throw blockError(ref, "duplicate start markers");
  }
  if (endIdxs.length === 0) {
    throw blockError(ref, "missing end marker");
  }
  if (endIdxs.length > 1) {
    throw blockError(ref, "duplicate end markers");
  }
  const [start] = startIdxs;
  const [end] = endIdxs;
  if (end < start) {
    throw blockError(ref, "end marker precedes the start marker");
  }

  const blockLines = lines
    .slice(start + 1, end)
    .map(semantic)
    .filter((line) => line.trim() !== "");
  if (blockLines.length === 0) {
    throw blockError(ref, "missing the (id:) tag line");
  }

  const managed = parseTagLine(blockLines[0], ref);
  for (const depLine of blockLines.slice(1)) {
    managed.deps.push(...parseDepLine(depLine, ref));
  }

  // Prose after the end marker is preserved but rejoins above the block on the
  // next write (strip-and-regenerate keeps the block at the foot).
  const before = trimBoundaryBlankLines(lines.slice(0, start));
  const after = trimBoundaryBlankLines(lines.slice(end + 1));
  const proseLines =
    before.length > 0 && after.length > 0
      ? [...before, "", ...after]
      : [...before, ...after];
  return { prose: proseLines.join("\n"), managed };
}

/** Render the block canonically: tag line first, one dependency per line. */
export function renderManagedBlock(fields: ManagedFields): string {
  // Reuse the canonical markdown tag order by rendering a titleless pseudo-task
  // (buildProse drops empty parts; state "queued" keeps `(since)` eligible and
  // closure tags impossible — closure is native GitHub state, never a block tag).
  const pseudo: Task = {
    id: fields.id,
    title: "",
    state: "queued",
    links: [],
    deps: [],
  };
  if (fields.kind !== undefined) pseudo.kind = fields.kind;
  if (fields.repo !== undefined) pseudo.repo = fields.repo;
  if (fields.priority !== undefined) pseudo.priority = fields.priority;
  if (fields.created !== undefined) pseudo.created = fields.created;
  if (fields.hold !== undefined) pseudo.hold = fields.hold;

  const tagParts = [`(id: ${fields.id})`];
  if (fields.inFlight) tagParts.push("(state: in-flight)");
  const tags = buildProse(pseudo);
  if (tags !== "") tagParts.push(tags);

  const lines = [BLOCK_START, tagParts.join(" ")];
  for (const dep of fields.deps) {
    lines.push(
      dep.reason
        ? `${dep.type}: ${dep.id} - ${dep.reason}`
        : `${dep.type}: ${dep.id}`,
    );
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/** Strip-and-regenerate composition: prose above, one blank line, block at the foot. */
export function composeIssueBody(prose: string, block: string): string {
  validateIssueProse(prose);
  return prose === "" ? block : `${prose}\n\n${block}`;
}

export function validateIssueProse(prose: string): void {
  const reserved = prose
    .split("\n")
    .map(semantic)
    .find((line) => {
      const trimmed = line.trim();
      return trimmed === BLOCK_START || trimmed === BLOCK_END;
    });
  if (reserved !== undefined) {
    throw new AxiError(
      "Issue prose cannot contain reserved tasks-axi marker lines",
      "VALIDATION_ERROR",
      ["Remove or rewrite the marker line before retrying"],
    );
  }
}
