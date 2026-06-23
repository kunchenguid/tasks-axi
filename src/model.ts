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

/** State plus the derived `blocked` projection used in display/filters. */
export type DerivedState = State | "blocked";

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
  /** The long, accumulating notes (truncated in list/show). */
  body?: string;
  /** Typed links: a PR url or a data/<id>/report.md path. */
  links: TaskLink[];
  /** Typed dependency edges (firstmate uses blocked-by today). */
  deps: Dep[];
  /** 0-4, optional (borrowed from beads; firstmate orders by list position). */
  priority?: number;
  /** Maps to `(since ...)`. */
  created?: string;
  updated?: string;
  /** Maps to `(merged ...)` / `(reported ...)`. */
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
  priority?: number;
  created?: string;
  closed?: string;
  meta?: Record<string, unknown>;
}

/** A patch for `update`. Undefined fields are left unchanged. */
export interface TaskPatch {
  title?: string;
  /** Replace the body wholesale. */
  body?: string;
  /** Append a note to the body (the answer to the growing status line). */
  appendBody?: string;
  repo?: string;
  kind?: string;
  /** Links to add (existing links are preserved). */
  addLinks?: TaskLink[];
  priority?: number;
  meta?: Record<string, unknown>;
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

/** A list query. `blocked`/ready derivation is computed in the CLI layer. */
export interface TaskQuery {
  state?: State;
  repo?: string;
  kind?: string;
  limit?: number;
}
