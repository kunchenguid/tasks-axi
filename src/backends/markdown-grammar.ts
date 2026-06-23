import type { Dep, State, Task, TaskLink } from "../model.js";

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

/** Validate a caller-supplied id round-trips through the markdown grammar. */
export const ID_RE = new RegExp(`^${ID_CHARS}$`);

function matchTaskBullet(
  line: string,
  state: State,
): { id: string; rest: string } | null {
  const re =
    state === "in_flight"
      ? IN_FLIGHT_RE
      : state === "queued"
        ? QUEUED_RE
        : DONE_RE;
  const m = line.match(re);
  if (!m) return null;
  return { id: m[1], rest: m[2] };
}

// ---------------------------------------------------------------------------
// Inline tag extraction (canonical fields) + link/kind derivation
// ---------------------------------------------------------------------------

// Canonical tags are recognized only in the TRAILING tag-region of a line, so
// a mid-sentence parenthetical (e.g. "report.md (reported 2026-06-22): ...") is
// left untouched in the prose and never duplicated or relocated on re-render.
const DATE = "\\d{4}-\\d{2}-\\d{2}";
const TAIL_DEP = new RegExp(
  `\\s*(blocked-by|parent|discovered-from):\\s*(${ID_CHARS})\\s*$`,
);
const TAIL_REPO = /\s*\((?:[^()]*\+\s*)?repo:\s*([^)]+)\)\s*$/;
const TAIL_KIND = /\s*\(kind:\s*([^)]+)\)\s*$/;
const TAIL_PRIORITY = /\s*\(priority:\s*([0-4])\)\s*$/;
const TAIL_SINCE = new RegExp(`\\s*\\(since\\s+(${DATE})\\)\\s*$`);
const TAIL_CLOSED = new RegExp(
  `\\s*\\((?:merged|reported|done|closed)\\s+(${DATE})\\)\\s*$`,
);

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
  links: TaskLink[];
}

/**
 * Pull the canonical inline tags off the trailing tag-region of a bullet's
 * content, returning the clean prose title plus the structured fields. Links
 * and any leading kind word stay in the prose (so they are never duplicated on
 * re-render), and mid-sentence parentheticals are preserved verbatim.
 */
export function extractTags(rest: string): ExtractedTags {
  const links = deriveLinks(rest);
  const deps: Dep[] = [];
  let repo: string | undefined;
  let kindTag: string | undefined;
  let created: string | undefined;
  let closed: string | undefined;
  let priority: number | undefined;

  let title = rest;
  let stripping = true;
  while (stripping) {
    stripping = false;

    let m = title.match(TAIL_DEP);
    if (m) {
      deps.unshift({ type: m[1] as Dep["type"], id: m[2] });
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
  }

  title = title.trim();
  const kind = kindTag ?? leadingKind(title);

  return { title, kind, repo, deps, created, closed, priority, links };
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

  for (const dep of task.deps) {
    parts.push(`${dep.type}: ${dep.id}`);
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

  return parts.filter((p) => p.length > 0).join(" ");
}

function bulletPrefix(state: State, id: string): string {
  if (state === "in_flight") return `- **${id}** - `;
  if (state === "queued") return `- [ ] ${id} - `;
  return `- [x] ${id} - `;
}

/** Render a task to its canonical source lines (bullet + body continuations). */
export function renderTaskLines(task: Task): string[] {
  const first = bulletPrefix(task.state, task.id) + buildProse(task);
  const lines = [first];
  if (task.body && task.body.length > 0) {
    for (const bodyLine of task.body.split("\n")) {
      lines.push(`  ${bodyLine}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function sectionState(headerLine: string): State | undefined {
  const m = headerLine.match(/^##\s+(.*?)\s*$/);
  if (!m) return undefined;
  const text = m[1].toLowerCase();
  if (text === "in flight") return "in_flight";
  if (text === "queued") return "queued";
  if (text.startsWith("done")) return "done";
  return undefined;
}

function buildTask(
  id: string,
  rest: string,
  state: State,
  bodyLines: string[],
): Task {
  const tags = extractTags(rest);
  const task: Task = {
    id,
    title: tags.title,
    state,
    links: tags.links,
    deps: tags.deps,
  };
  if (tags.kind) task.kind = tags.kind;
  if (tags.repo) task.repo = tags.repo;
  if (bodyLines.length > 0) task.body = bodyLines.join("\n");
  if (tags.created) task.created = tags.created;
  if (tags.closed) task.closed = tags.closed;
  if (tags.priority !== undefined) task.priority = tags.priority;
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
    const bullet = state ? matchTaskBullet(line, state) : null;

    if (bullet && state) {
      flushRaw();
      const raw = [line];
      const bodyLines: string[] = [];
      // Consume indented continuation lines as the task body.
      while (
        i + 1 < lines.length &&
        lines[i + 1].length > 0 &&
        lines[i + 1].startsWith("  ")
      ) {
        i++;
        raw.push(lines[i]);
        bodyLines.push(lines[i].slice(2));
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

export function parseBacklog(src: string): BacklogDoc {
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
    if (/^##\s+/.test(line)) {
      closeSection();
      current = { headerLine: line, state: sectionState(line), entries: [] };
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
