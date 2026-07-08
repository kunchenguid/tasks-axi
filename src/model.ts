/**
 * The tasks-axi data model (report §5).
 *
 * A Task is a small structured record. The model is rich enough for firstmate
 * and maps cleanly onto external trackers; the exotic firstmate fields live in
 * a free-form `meta` bag rather than as columns.
 */

/** The three explicit states (= the three markdown sections). */
export const STATES = ["queued", "in_flight", "done"] as const;
export type State = (typeof STATES)[number];

/** Explicit state plus derived `blocked`/`held` projections used in display/filters. */
export type DerivedState = State | "blocked" | "held";

export const HOLD_KINDS = [
  "captain",
  "external",
  "load",
  "parked",
  "future",
] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export interface Hold {
  /** Human-readable reason for pausing dispatch. */
  reason: string;
  /** Optional coarse bucket for scanning held work. */
  kind?: HoldKind;
  /** YYYY-MM-DD date gate. The hold is inactive on and after this date. */
  until?: string;
}

/**
 * Dependency edge types. firstmate uses only `blocked-by` today; `parent` and
 * `discovered-from` are the agent-native edges borrowed from beads (report §3).
 */
export type DepType = "blocked-by" | "parent" | "discovered-from";

export type LinkKind = "pr" | "report" | "doc";

export interface TaskLink {
  kind: LinkKind;
  url: string;
}

export interface Dep {
  type: DepType;
  id: string;
  /**
   * Free-text rationale carried by firstmate's `blocked-by: <id> - <reason>`
   * form. Preserved across a round-trip; does not affect `blocked`/`ready`
   * (which key off the blocker id alone).
   */
  reason?: string;
}

export interface Task {
  /** Join key: "homemux-h7". Caller-supplied or minted slug-xx. */
  id: string;
  /** One-line summary (the prose before the long notes). */
  title: string;
  /** Which markdown section the task lives in. */
  state: State;
  /** ship | scout | docs | status | roadmap | secondmate | task | ... */
  kind?: string;
  /** "firstmate", "no-mistakes", "hibit-monorepo" */
  repo?: string;
  /** The task body, used for full notes and truncated in list/show. */
  body?: string;
  /** Typed links: PR url, data/<id>/report.md path, or generic doc url. */
  links: TaskLink[];
  /** Typed dependency edges (firstmate uses blocked-by today). */
  deps: Dep[];
  /** Structured dispatch hold. Active holds keep queued work out of ready. */
  hold?: Hold;
  /** 0-4, optional (borrowed from beads; firstmate orders by list position). */
  priority?: number;
  /** Maps to `(since ...)`. */
  created?: string;
  updated?: string;
  /** Maps to `(merged ...)` / `(reported ...)` / `(done ...)` on render. */
  closed?: string;
  /** Home, harness, external-tracker id/url, and other exotica. */
  meta?: Record<string, unknown>;
}

/** Input for creating a task. `id` and `title` are required. */
export interface TaskInput {
  id: string;
  title: string;
  state?: State;
  kind?: string;
  repo?: string;
  body?: string;
  links?: TaskLink[];
  deps?: Dep[];
  hold?: Hold;
  priority?: number;
  created?: string | null;
  closed?: string;
  meta?: Record<string, unknown>;
}

/** A patch for `update`. Undefined fields are left unchanged. */
export interface TaskPatch {
  title?: string;
  /** Replace the body wholesale with the curated current notes. */
  body?: string;
  /** Archive the previous body before a changed body replacement. */
  archiveBody?: boolean;
  /** Add body lines when they are not already present. */
  addBodyLines?: string[];
  repo?: string;
  kind?: string;
  /** Links to add (existing links are preserved). */
  addLinks?: TaskLink[];
  /** Set a structured hold, or clear it with null. */
  hold?: Hold | null;
  priority?: number;
  meta?: Record<string, unknown>;
}

export type TaskUpdateChange =
  | "title"
  | "body"
  | "archive"
  | "repo"
  | "kind"
  | "priority"
  | "links"
  | "hold"
  | "meta";

export interface TaskUpdateResult {
  /** The updated task, or the existing task when the patch was a no-op. */
  task: Task;
  /** Fields that actually changed; empty when the patch was idempotent. */
  changed: TaskUpdateChange[];
}

/** Options for a state transition. */
export interface TransitionOpts {
  /** PR url to record (done). */
  pr?: string;
  /** report path to record (done). */
  report?: string;
  /** A note to append to the body. */
  note?: string;
  /** ISO-ish date stamp; defaults to today. */
  date?: string;
}

/** A list query. `blocked`/`ready`/`held` derivation is computed in the CLI layer. */
export interface TaskQuery {
  state?: State;
  repo?: string;
  kind?: string;
  limit?: number;
}
