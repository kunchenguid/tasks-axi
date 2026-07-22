import { AxiError } from "../errors.js";
import type { Dep, Hold, HoldKind, State, Task, TaskLink } from "../model.js";
import { HOLD_KINDS } from "../model.js";
import {
  PUBLIC_FOLLOWUP_KIND,
  assertPublicFollowupTaskState,
  decodePublicFollowup,
  encodePublicFollowup,
} from "../public-followup.js";

/**
 * The markdown grammar: pure parse / render with no I/O.
 *
 * Strategy for the byte-exact round-trip (report §2.4, decision D1):
 *  - Every entry keeps its exact original source lines (`raw`). An unmodified
 *    task and any free-form line is emitted verbatim, so `render(parse(src))`
 *    equals `src` byte-for-byte on a file nobody has mutated.
 *  - When a task is mutated, it is marked `dirty` and re-rendered from its
 *    structured fields into a canonical, re-parseable form. Untouched entries
 *    stay verbatim, so a targeted task edit never disturbs the rest of the file.
 *  - `render()` (the verb) marks every task dirty to normalize the whole file.
 *
 * Free-form (no-id) lines are preserved verbatim and never operated on by id
 * (decision D7).
 */

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export interface TaskEntry {
  kind: "task";
  task: Task;
  /** Exact original source lines (bullet + indented continuations). */
  raw: string[];
  /** When true, render from `task`; otherwise emit `raw` verbatim. */
  dirty: boolean;
}

export interface RawEntry {
  kind: "raw";
  lines: string[];
}

export type Entry = TaskEntry | RawEntry;

export interface Section {
  /** Exact header line, e.g. "## In flight" or "## Done (10 most recent)". */
  headerLine: string;
  /** Recognized task-bearing state, or undefined for a passthrough section. */
  state?: State;
  entries: Entry[];
}

export interface BacklogDoc {
  finalNewline: boolean;
  /** Lines before the first `## ` section header (H1, blanks). */
  preamble: string[];
  sections: Section[];
}

// ---------------------------------------------------------------------------
// Bullet patterns
// ---------------------------------------------------------------------------

const ID_CHARS = "[A-Za-z0-9][A-Za-z0-9._-]*";
const IN_FLIGHT_RE = new RegExp(`^- \\*\\*(${ID_CHARS})\\*\\* - (.*)$`);
const QUEUED_RE = new RegExp(`^- \\[ \\] (${ID_CHARS}) - (.*)$`);
const DONE_RE = new RegExp(`^- \\[x\\] (${ID_CHARS}) - (.*)$`);
const TASK_SHAPED_RE = new RegExp(
  `^- (?:\\[[^\\]]*\\]\\s*(${ID_CHARS})|\\*\\*(${ID_CHARS})\\*\\*) - .*$`,
);

/** Validate a caller-supplied id round-trips through the markdown grammar. */
export const ID_RE = new RegExp(`^${ID_CHARS}$`);

function semanticLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function matchOne(
  line: string,
  re: RegExp,
): { id: string; rest: string } | null {
  const m = line.match(re);
  return m ? { id: m[1], rest: m[2] } : null;
}

function matchTaskBullet(
  line: string,
  state: State,
): { id: string; rest: string } | null {
  if (state === "done") return matchOne(line, DONE_RE);
  if (state === "queued") return matchOne(line, QUEUED_RE);
  // In flight: firstmate writes the GitHub-style `- [ ] <id>` checkbox (the same
  // bullet as Queued; the section header is what distinguishes the state), while
  // older tasks-axi output used `- **<id>**`. Recognize both so a file either
  // tool wrote is readable by the other.
  return matchOne(line, IN_FLIGHT_RE) ?? matchOne(line, QUEUED_RE);
}

// ---------------------------------------------------------------------------
// Inline tag extraction (canonical fields) + link/kind derivation
// ---------------------------------------------------------------------------

// Canonical tags are recognized only in the TRAILING tag-region of a line, so
// a mid-sentence parenthetical (e.g. "report.md (reported 2026-06-22): ...") is
// left untouched in the prose and never duplicated or relocated on re-render.
const DATE = "\\d{4}-\\d{2}-\\d{2}";
// A trailing dependency edge, optionally carrying firstmate's free-text reason
// after a ` - ` delimiter, e.g. `blocked-by: fix-login-k3 - waits on the login
// refactor`. The id stops at the first space, and the reason stops before the
// next trailing dependency marker.
const DEP_MARKER = "(?:blocked-by|parent|discovered-from)";
const TAIL_DEP = new RegExp(
  `\\s*(${DEP_MARKER}):\\s*(${ID_CHARS})(?:\\s+-\\s+((?:(?!\\s+${DEP_MARKER}:\\s).)+?))?\\s*$`,
);
const TAIL_REPO = /\s*\((?:[^()]*\+\s*)?repo:\s*([^)]+)\)\s*$/;
const TAIL_KIND = /\s*\(kind:\s*([^)]+)\)\s*$/;
const TAIL_PRIORITY = /\s*\(priority:\s*([0-4])\)\s*$/;
const TAIL_SINCE = new RegExp(`\\s*\\(since\\s+(${DATE})\\)\\s*$`);
const TAIL_CLOSED = new RegExp(
  `\\s*\\((?:merged|reported|done|closed)\\s+(${DATE})\\)\\s*$`,
);
const TAIL_HOLD = /\s*\(hold:\s*([^()]+)\)\s*$/;
const TAIL_HOLD_KIND = new RegExp(
  `\\s*\\(hold-kind:\\s*(${HOLD_KINDS.join("|")})\\)\\s*$`,
);
const TAIL_HOLD_UNTIL = new RegExp(`\\s*\\(hold-until:\\s*(${DATE})\\)\\s*$`);

const PR_LINK = /https?:\/\/\S+?\/pull\/\d+/g;
const REPORT_LINK = /\bdata\/\S+?\/report\.md\b/g;
const GENERIC_URL = /https?:\/\/\S+/g;

const LEADING_KIND: Array<[RegExp, string]> = [
  [/^PERSISTENT SECONDMATE\b/, "secondmate"],
  [/^SHIP\b/, "ship"],
  [/^SCOUT\b/, "scout"],
  [/^DOCS-ONLY\b/, "docs"],
];

/** The kind implied by a leading prose word (legacy display), or undefined. */
export function leadingKind(title: string): string | undefined {
  for (const [re, kind] of LEADING_KIND) {
    if (re.test(title)) return kind;
  }
  return undefined;
}

function titleHasLeadingKind(title: string, kind: string): boolean {
  return leadingKind(title) === kind;
}

function trimUrl(url: string): string {
  return url.replace(/[).,;]+$/, "");
}

/** Derive typed links by scanning prose (links live in the prose, not as tags). */
export function deriveLinks(text: string): TaskLink[] {
  const links: TaskLink[] = [];
  const seen = new Set<string>();
  const add = (kind: TaskLink["kind"], raw: string) => {
    const url = trimUrl(raw);
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ kind, url });
  };
  for (const m of text.matchAll(PR_LINK)) add("pr", m[0]);
  for (const m of text.matchAll(REPORT_LINK)) add("report", m[0]);
  for (const m of text.matchAll(GENERIC_URL)) {
    if (!/\/pull\/\d+/.test(m[0])) add("doc", m[0]);
  }
  return links;
}

export interface ExtractedTags {
  title: string;
  kind?: string;
  repo?: string;
  deps: Dep[];
  created?: string;
  closed?: string;
  priority?: number;
  hold?: Hold;
  links: TaskLink[];
}

/**
 * Pull the canonical inline tags off the trailing tag-region of a bullet's
 * content, returning the clean prose title plus the structured fields. Links
 * and any leading kind word stay in the prose (so they are never duplicated on
 * re-render), and mid-sentence parentheticals are preserved verbatim.
 */
export function extractTags(rest: string): ExtractedTags {
  const deps: Dep[] = [];
  let repo: string | undefined;
  let kindTag: string | undefined;
  let created: string | undefined;
  let closed: string | undefined;
  let priority: number | undefined;
  let holdReason: string | undefined;
  let holdKind: HoldKind | undefined;
  let holdUntil: string | undefined;

  let title = rest;
  let stripping = true;
  while (stripping) {
    stripping = false;

    let m = title.match(TAIL_DEP);
    if (m) {
      const dep: Dep = { type: m[1] as Dep["type"], id: m[2] };
      if (m[3] !== undefined) dep.reason = m[3];
      deps.unshift(dep);
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_REPO);
    if (m) {
      if (repo === undefined) repo = m[1].trim();
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_KIND);
    if (m) {
      if (kindTag === undefined) kindTag = m[1].trim();
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_PRIORITY);
    if (m) {
      if (priority === undefined) priority = Number(m[1]);
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_SINCE);
    if (m) {
      if (created === undefined) created = m[1];
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_CLOSED);
    if (m) {
      if (closed === undefined) closed = m[1];
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_HOLD_UNTIL);
    if (m) {
      if (holdUntil === undefined) holdUntil = m[1];
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_HOLD_KIND);
    if (m) {
      if (holdKind === undefined) holdKind = m[1] as HoldKind;
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
    m = title.match(TAIL_HOLD);
    if (m) {
      if (holdReason === undefined) holdReason = m[1].trim();
      title = title.slice(0, m.index);
      stripping = true;
      continue;
    }
  }

  title = title.trim();
  const kind = kindTag ?? leadingKind(title);
  const links = deriveLinks(title);
  const hold =
    holdReason !== undefined
      ? {
          reason: holdReason,
          ...(holdKind !== undefined ? { kind: holdKind } : {}),
          ...(holdUntil !== undefined ? { until: holdUntil } : {}),
        }
      : undefined;

  return { title, kind, repo, deps, created, closed, priority, hold, links };
}

// ---------------------------------------------------------------------------
// Canonical render of a single task
// ---------------------------------------------------------------------------

function closureVerb(task: Task): string {
  if (task.links.some((l) => l.kind === "pr")) return "merged";
  if (task.links.some((l) => l.kind === "report")) return "reported";
  return "done";
}

/** Build the canonical single-line prose (clean title + canonical tags). */
export function buildProse(task: Task): string {
  const parts: string[] = [task.title.trim()];

  // A bare edge sits right after the title (firstmate's `blocked-by: <id>
  // (repo: …)`); an edge carrying a reason must come last - see below.
  for (const dep of task.deps) {
    if (!dep.reason) parts.push(`${dep.type}: ${dep.id}`);
  }
  if (task.repo) parts.push(`(repo: ${task.repo})`);
  if (task.kind && !titleHasLeadingKind(task.title, task.kind)) {
    parts.push(`(kind: ${task.kind})`);
  }
  if (task.priority !== undefined) parts.push(`(priority: ${task.priority})`);
  if (task.state !== "done" && task.created) {
    parts.push(`(since ${task.created})`);
  }
  if (task.state === "done" && task.closed) {
    parts.push(`(${closureVerb(task)} ${task.closed})`);
  }
  if (task.hold) {
    parts.push(`(hold: ${task.hold.reason})`);
    if (task.hold.kind) parts.push(`(hold-kind: ${task.hold.kind})`);
    if (task.hold.until) parts.push(`(hold-until: ${task.hold.until})`);
  }
  // A reason runs as free text to the end of the line, so an edge that has one
  // is emitted after the parenthetical tags - both to match firstmate's real
  // `(repo: …) blocked-by: <id> - <reason>` form and so a re-parse strips the
  // parentheticals first and the reason never swallows a trailing tag.
  for (const dep of task.deps) {
    if (dep.reason) parts.push(`${dep.type}: ${dep.id} - ${dep.reason}`);
  }

  return parts.filter((p) => p.length > 0).join(" ");
}

function bulletPrefix(state: State, id: string): string {
  if (state === "done") return `- [x] ${id} - `;
  // Both in-flight and queued render as the GitHub-style unchecked checkbox to
  // match firstmate's real backlog format; the section header carries the state.
  // A legacy `- **<id>**` line is still parsed, but normalizes to `- [ ]` so a
  // mutated file stays readable by firstmate (never rewritten the other way).
  return `- [ ] ${id} - `;
}

/** Render a task to its canonical source lines (bullet + typed metadata + body). */
export function renderTaskLines(task: Task): string[] {
  const first = bulletPrefix(task.state, task.id) + buildProse(task);
  const lines = [first];
  if (task.kind === PUBLIC_FOLLOWUP_KIND) {
    if (!task.public_followup) {
      throw new AxiError(
        `Task "${task.id}" is missing public-followup metadata`,
        "VALIDATION_ERROR",
      );
    }
    lines.push(
      `  <!-- tasks-axi:public-followup/v1:${encodePublicFollowup(task.public_followup)} -->`,
    );
  } else if (task.public_followup) {
    throw new AxiError(
      `Task "${task.id}" has public-followup metadata without kind=public-followup`,
      "VALIDATION_ERROR",
    );
  }
  if (task.body && task.body.length > 0) {
    for (const bodyLine of task.body.split("\n")) {
      // Blank body paragraphs stay blank (not two spaces). Indented content
      // keeps the 2-space continuation prefix used throughout the grammar.
      lines.push(bodyLine === "" ? "" : `  ${bodyLine}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function sectionState(headerLine: string): State | undefined {
  const m = semanticLine(headerLine).match(/^##\s+(.*?)\s*$/);
  if (!m) return undefined;
  const text = m[1].toLowerCase();
  if (text === "in flight") return "in_flight";
  if (text === "queued") return "queued";
  if (text.startsWith("done")) return "done";
  return undefined;
}

function archiveSectionState(headerLine: string): State | undefined {
  return /^##\s+Archived\s+\d{4}-\d{2}-\d{2}\s*$/.test(semanticLine(headerLine))
    ? "done"
    : undefined;
}

/**
 * Structured body drops trailing blank lines (section/item separators that
 * still belong to the item block in `raw` for byte-exact emit and removal).
 * Internal blank lines between paragraphs are kept.
 */
function structuredBody(bodyLines: string[]): string | undefined {
  let end = bodyLines.length;
  while (end > 0 && bodyLines[end - 1] === "") end--;
  if (end === 0) return undefined;
  return bodyLines.slice(0, end).join("\n");
}

const PUBLIC_FOLLOWUP_MARKER = "tasks-axi:public-followup";
const PUBLIC_FOLLOWUP_METADATA_RE =
  /^<!-- tasks-axi:public-followup\/v(\d+):([A-Za-z0-9_-]+) -->$/;

function extractPublicFollowupMetadata(
  id: string,
  kind: string | undefined,
  bodyLines: string[],
): { bodyLines: string[]; publicFollowup?: Task["public_followup"] } {
  const markerIndexes = bodyLines
    .map((line, index) => (line.includes(PUBLIC_FOLLOWUP_MARKER) ? index : -1))
    .filter((index) => index >= 0);

  if (markerIndexes.length === 0) {
    if (kind === PUBLIC_FOLLOWUP_KIND) {
      throw new AxiError(
        `Task "${id}" is missing public-followup metadata`,
        "VALIDATION_ERROR",
      );
    }
    return { bodyLines };
  }

  if (markerIndexes.length !== 1 || markerIndexes[0] !== 0) {
    throw new AxiError(
      `Task "${id}" has malformed or misplaced public-followup metadata`,
      "VALIDATION_ERROR",
    );
  }
  const match = bodyLines[0].match(PUBLIC_FOLLOWUP_METADATA_RE);
  if (!match || match[1] !== "1") {
    throw new AxiError(
      `Task "${id}" has unsupported public-followup metadata`,
      "VALIDATION_ERROR",
    );
  }
  if (kind !== PUBLIC_FOLLOWUP_KIND) {
    throw new AxiError(
      `Task "${id}" has public-followup metadata without kind=public-followup`,
      "VALIDATION_ERROR",
    );
  }
  return {
    bodyLines: bodyLines.slice(1),
    publicFollowup: decodePublicFollowup(match[2]),
  };
}

function buildTask(
  id: string,
  rest: string,
  state: State,
  bodyLines: string[],
): Task {
  const tags = extractTags(rest);
  const metadata = extractPublicFollowupMetadata(id, tags.kind, bodyLines);
  const task: Task = {
    id,
    title: tags.title,
    state,
    links: tags.links,
    deps: tags.deps,
  };
  if (tags.kind) task.kind = tags.kind;
  if (tags.repo) task.repo = tags.repo;
  if (metadata.publicFollowup) {
    if (tags.hold) {
      throw new AxiError(
        `Task "${id}" cannot use dispatch holds as a public-followup`,
        "VALIDATION_ERROR",
      );
    }
    assertPublicFollowupTaskState(state, metadata.publicFollowup, id);
    task.public_followup = metadata.publicFollowup;
  }
  const body = structuredBody(metadata.bodyLines);
  if (body !== undefined) task.body = body;
  if (tags.created) task.created = tags.created;
  if (tags.closed) task.closed = tags.closed;
  if (tags.priority !== undefined) task.priority = tags.priority;
  if (tags.hold) task.hold = tags.hold;
  return task;
}

function parseEntries(lines: string[], state: State | undefined): Entry[] {
  const entries: Entry[] = [];
  let rawRun: string[] = [];

  const flushRaw = () => {
    if (rawRun.length > 0) {
      entries.push({ kind: "raw", lines: rawRun });
      rawRun = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bullet = state ? matchTaskBullet(semanticLine(line), state) : null;

    if (bullet && state) {
      flushRaw();
      const raw = [line];
      const bodyLines: string[] = [];
      // Item block = header plus every following indented OR blank line, up to
      // the next item header or free-form column-0 content. Blank separators
      // between body paragraphs stay inside the block (and move with it).
      // Membership is by position, not content: indented lines that look like
      // markdown headings (e.g. `  ## Intent`) are body, never section
      // boundaries (column-0 `## ` is already split out before parseEntries).
      // A trailing blank before the next item/section belongs to this block.
      while (i + 1 < lines.length) {
        const next = semanticLine(lines[i + 1]);
        if (next.trim().length === 0) {
          i++;
          raw.push(lines[i]);
          bodyLines.push("");
          continue;
        }
        if (next.startsWith("  ")) {
          i++;
          raw.push(lines[i]);
          bodyLines.push(next.slice(2));
          continue;
        }
        break;
      }
      entries.push({
        kind: "task",
        task: buildTask(bullet.id, bullet.rest, state, bodyLines),
        raw,
        dirty: false,
      });
      continue;
    }

    rawRun.push(line);
  }

  flushRaw();
  return entries;
}

type SectionStateResolver = (headerLine: string) => State | undefined;

function parseDocument(
  src: string,
  resolveSectionState: SectionStateResolver,
): BacklogDoc {
  if (src === "") {
    return { finalNewline: false, preamble: [], sections: [] };
  }
  const finalNewline = src.endsWith("\n");
  const body = finalNewline ? src.slice(0, -1) : src;
  const lines = body.split("\n");

  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  let buffer: string[] = [];

  const closeSection = () => {
    if (current) {
      current.entries = parseEntries(buffer, current.state);
      sections.push(current);
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^##\s+/.test(semanticLine(line))) {
      closeSection();
      current = {
        headerLine: line,
        state: resolveSectionState(line),
        entries: [],
      };
      continue;
    }
    if (current) {
      buffer.push(line);
    } else {
      preamble.push(line);
    }
  }
  closeSection();

  return { finalNewline, preamble, sections };
}

export function parseBacklog(src: string): BacklogDoc {
  return parseDocument(src, sectionState);
}

/** Parse append-only Done archive blocks without treating them as active sections. */
export function parseDoneArchive(src: string): BacklogDoc {
  return parseDocument(src, archiveSectionState);
}

function taskShapedIdentity(line: string): string | undefined {
  const match = semanticLine(line).match(TASK_SHAPED_RE);
  return match?.[1] ?? match?.[2];
}

export function hasMalformedTaskIdentity(
  doc: BacklogDoc,
  id: string,
): boolean {
  if (doc.preamble.some((line) => taskShapedIdentity(line) === id)) return true;
  return doc.sections.some((section) =>
    section.entries.some(
      (entry) =>
        entry.kind === "raw" &&
        entry.lines.some((line) => taskShapedIdentity(line) === id),
    ),
  );
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderEntry(entry: Entry): string[] {
  if (entry.kind === "raw") return entry.lines;
  return entry.dirty ? renderTaskLines(entry.task) : entry.raw;
}

export function renderBacklog(doc: BacklogDoc): string {
  const lines: string[] = [...doc.preamble];
  for (const section of doc.sections) {
    lines.push(section.headerLine);
    for (const entry of section.entries) {
      lines.push(...renderEntry(entry));
    }
  }
  if (doc.preamble.length === 0 && doc.sections.length === 0) return "";
  return lines.join("\n") + (doc.finalNewline ? "\n" : "");
}
