import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TransitionOpts,
} from "./model.js";

/**
 * Backend capability descriptor (report §8). Optional capabilities degrade
 * gracefully: the CLI computes a missing capability from the core verbs, or
 * returns a structured error naming the capability — never a raw backend error.
 */
export interface Capabilities {
  /** Backend identifier, e.g. "markdown". */
  backend: string;
  deps: boolean;
  prune: boolean;
  comments: boolean;
  fullTextSearch: boolean;
  realtimeSync: boolean;
  /** Can it represent backend-specific states beyond queued/in_flight/done? */
  customStates: boolean;
  /** Does the server assign its own ids (remote trackers)? */
  serverMintsIds: boolean;
}

export interface PruneOptions {
  state: State;
  keep: number;
  archive: boolean;
}

export interface PruneResult {
  archived: number;
  ids: string[];
}

/**
 * The single narrow seam every backend implements (report §8). The CLI layer
 * (arg parsing, TOON rendering, suggestions, help) never knows which backend
 * is active. `ready`/`blocked`/`held` are derived in the CLI from `list`, the
 * dependency graph, and structured hold tags, so every backend gets them for
 * free.
 *
 * The core contract is create/get/update/remove/list/transition/addDep/
 * removeDep. `prune` and `render` are optional and capability-gated.
 */
export interface Store {
  capabilities(): Capabilities;

  // CRUD
  create(input: TaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  remove(id: string): Promise<Task>;

  // query
  list(query: TaskQuery): Promise<{ items: Task[]; total: number }>;

  // state + dependencies
  transition(id: string, to: State, opts?: TransitionOpts): Promise<Task>;
  addDep(id: string, dep: Dep): Promise<boolean>;
  removeDep(id: string, dep: Dep): Promise<boolean>;

  // maintenance (optional, capability-gated)
  prune?(options: PruneOptions): Promise<PruneResult>;
  /** Normalize the persisted view (markdown: rewrite every item canonically). */
  render?(): Promise<number>;
}
