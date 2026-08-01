import { blockedIds, currentLocalDate, isHoldActive } from "../derive.js";
import { AxiError } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import { PUBLIC_FOLLOWUP_KIND } from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import {
  createGhIssuesClient,
  type GhIssuesClient,
  type IssueData,
  type IssuePatch,
} from "./gh.js";
import {
  composeIssueBody,
  parseIssueBody,
  renderManagedBlock,
  validateIssueProse,
  type ManagedFields,
} from "./github-body.js";
import { deriveLinks } from "./markdown-grammar.js";
import {
  addBodyLine,
  bodyHasLine,
  normalizeDate,
  normalizeDep,
  normalizeHold,
  normalizePriority,
  normalizeTagValue,
  normalizeTitle,
  normalizeTypedLink,
  sameHold,
} from "./validate.js";

/**
 * The GitHub Issues backend (design option B, block-authoritative):
 *
 * - GitHub's native `state` + `state_reason` own the terminal boundary: closed
 *   is `done`, closed as not_planned/duplicate is `resolution: dropped`, and a
 *   hand-close or hand-reopen in the UI is always a valid state edit.
 * - The visible managed block (github-body.ts) owns everything else, including
 *   the queued/in-flight state tag; the task id lives only in the block, so a
 *   retitle can never orphan a task.
 * - Every label is a write-time projection of already-derived truth (in-flight,
 *   blocked, held), refreshed globally on every write and never read back for
 *   logic — so any single write heals all projection drift, and a stale label
 *   is a display lag, never a logic bug. `render` is the manual resync verb.
 * - Reads are one memoized GraphQL query per process; writes are field-scoped
 *   PATCHes against the freshly-read body. There is no lock: GitHub offers no
 *   write precondition on issues, so the residual TOCTOU window on
 *   body-rewriting operations is accepted and documented in the README rather
 *   than papered over.
 */

/**
 * Every label the backend projects lives under this prefix, so the managed
 * namespace is durable, collision-free with human labels, and bulk-manageable
 * (e.g. `gh label list --search tasks-axi:`).
 */
export const LABEL_PREFIX = "tasks-axi:";

export interface GithubLabels {
  inFlight: string;
  blocked: string;
  held: string;
}

export interface GithubStoreOptions {
  /** "owner/name" of the repository holding the backlog issues. */
  repo: string;
  /** Injectable GitHub client (tests); defaults to shelling out to `gh`. */
  client?: GhIssuesClient;
  /** Projection label names (defaults: in-flight, blocked, held). */
  labels?: Partial<GithubLabels>;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
  warn?: (message: string) => void;
}

interface GithubRecord {
  issue: IssueData;
  managed: ManagedFields;
  /** The human prose (issue body minus the managed block). */
  prose: string;
  task: Task;
}

const STATE_ORDER: Record<State, number> = { in_flight: 0, queued: 1, done: 2 };

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

function setProse(record: GithubRecord, prose: string): void {
  validateIssueProse(prose);
  record.prose = prose;
  if (prose === "") {
    delete record.task.body;
  } else {
    record.task.body = prose;
  }
}

function proseLinks(record: GithubRecord): TaskLink[] {
  return deriveLinks(`${record.task.title}\n${record.prose}`);
}

function unsupportedPublicFollowup(): AxiError {
  return new AxiError(
    "The github backend does not support public-followup",
    "UNSUPPORTED",
  );
}

export class GithubStore implements Store {
  private readonly client: GhIssuesClient;
  private readonly labels: GithubLabels;
  private readonly now: () => string;
  private readonly warn: (message: string) => void;
  private cache?: Promise<GithubRecord[]>;

  constructor(options: GithubStoreOptions) {
    this.client = options.client ?? createGhIssuesClient(options.repo);
    this.labels = {
      inFlight: options.labels?.inFlight ?? `${LABEL_PREFIX}in-flight`,
      blocked: options.labels?.blocked ?? `${LABEL_PREFIX}blocked`,
      held: options.labels?.held ?? `${LABEL_PREFIX}held`,
    };
    const names = this.managedLabelNames();
    if (names.some((name) => name.trim() === "") || new Set(names).size !== 3) {
      throw new AxiError(
        "github projection label names must be non-empty and distinct",
        "VALIDATION_ERROR",
        ["Fix the [github] *_label values in .tasks.toml"],
      );
    }
    if (names.some((name) => !name.startsWith(LABEL_PREFIX))) {
      throw new AxiError(
        `github projection label names must carry the "${LABEL_PREFIX}" prefix`,
        "VALIDATION_ERROR",
        [
          "The prefix keeps every projected label in one durable, bulk-manageable namespace",
          "Fix the [github] *_label values in .tasks.toml",
        ],
      );
    }
    this.now = options.now ?? currentLocalDate;
    this.warn =
      options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  capabilities(): Capabilities {
    return {
      backend: "github",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: false,
      serverMintsIds: false,
      publicFollowups: false,
    };
  }

  // -------------------------------------------------------------------------
  // Read path: one memoized GraphQL query per process
  // -------------------------------------------------------------------------

  private loadAll(): Promise<GithubRecord[]> {
    this.cache ??= this.fetchAll();
    return this.cache;
  }

  private async fetchAll(): Promise<GithubRecord[]> {
    const issues = await this.client.listIssues();
    const records: GithubRecord[] = [];
    const byId = new Map<string, GithubRecord>();
    for (const issue of issues) {
      const parsed = parseIssueBody(issue.body, `issue #${issue.number}`);
      // No versioned marker means the issue is not managed and stays invisible
      // to tasks-axi, so human-filed issues coexist freely.
      if (!parsed.managed) continue;
      const duplicate = byId.get(parsed.managed.id);
      if (duplicate) {
        throw new AxiError(
          `Duplicate task id "${parsed.managed.id}" in issues #${duplicate.issue.number} and #${issue.number}`,
          "VALIDATION_ERROR",
          ["Remove or fix the managed block on one of the two issues"],
        );
      }
      const record: GithubRecord = {
        issue,
        managed: parsed.managed,
        prose: parsed.prose,
        task: this.toTask(issue, parsed.managed, parsed.prose),
      };
      byId.set(record.task.id, record);
      records.push(record);
    }
    this.sortRecords(records);
    this.markLabelDrift(records);
    this.markParentDrift(records);
    return records;
  }

  private toTask(
    issue: IssueData,
    managed: ManagedFields,
    prose: string,
  ): Task {
    const state: State =
      issue.state === "closed"
        ? "done"
        : managed.inFlight
          ? "in_flight"
          : "queued";
    const task: Task = {
      id: managed.id,
      title: issue.title,
      state,
      links: deriveLinks(`${issue.title}\n${prose}`),
      deps: managed.deps,
    };
    if (managed.kind !== undefined) task.kind = managed.kind;
    if (managed.repo !== undefined) task.repo = managed.repo;
    if (prose !== "") task.body = prose;
    if (managed.hold !== undefined) task.hold = managed.hold;
    if (managed.priority !== undefined) task.priority = managed.priority;
    task.created = managed.created ?? dateOf(issue.createdAt);
    task.updated = dateOf(issue.updatedAt);
    if (state === "done") {
      task.closed = dateOf(issue.closedAt ?? issue.updatedAt);
      if (
        issue.stateReason === "not_planned" ||
        issue.stateReason === "duplicate"
      ) {
        task.resolution = "dropped";
      }
    }
    const meta: Record<string, unknown> = {
      issue: issue.number,
      url: issue.url,
    };
    if (issue.stateReason) meta.state_reason = issue.stateReason;
    task.meta = meta;
    return task;
  }

  private sortRecords(records: GithubRecord[]): void {
    records.sort((a, b) => {
      const order = STATE_ORDER[a.task.state] - STATE_ORDER[b.task.state];
      if (order !== 0) return order;
      // Open work reads oldest-first like a backlog; Done reads newest-first.
      return a.task.state === "done"
        ? b.issue.number - a.issue.number
        : a.issue.number - b.issue.number;
    });
  }

  private findRecord(records: GithubRecord[], id: string): GithubRecord {
    const record = records.find((r) => r.task.id === id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return record;
  }

  private requireExistingDeps(records: GithubRecord[], deps: Dep[]): void {
    for (const dep of deps) {
      if (records.some((r) => r.task.id === dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(`${label} "${dep.id}" not found`, "VALIDATION_ERROR", [
        "Create the dependency task first, or choose an existing task id",
      ]);
    }
  }

  private requireNoActiveDependents(records: GithubRecord[], id: string): void {
    const dependents = records
      .filter(
        (r) =>
          r.task.state !== "done" &&
          r.task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((r) => r.task.id);
    if (dependents.length === 0) return;
    throw new AxiError(
      `Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Projection labels: write-time display of derived truth, never read back
  // -------------------------------------------------------------------------

  private managedLabelNames(): string[] {
    return [this.labels.inFlight, this.labels.blocked, this.labels.held];
  }

  /** The derived display set per task (closed issues carry no state labels). */
  private expectedLabels(records: GithubRecord[]): Map<string, string[]> {
    const tasks = records.map((r) => r.task);
    const blocked = blockedIds(tasks);
    const today = this.now();
    const expected = new Map<string, string[]>();
    for (const { task } of records) {
      const labels: string[] = [];
      if (task.state !== "done") {
        if (task.state === "in_flight") labels.push(this.labels.inFlight);
        if (blocked.has(task.id)) labels.push(this.labels.blocked);
        if (isHoldActive(task, { today })) labels.push(this.labels.held);
      }
      expected.set(task.id, labels);
    }
    return expected;
  }

  private driftedRecords(
    records: GithubRecord[],
  ): Array<{ record: GithubRecord; want: string[] }> {
    const expected = this.expectedLabels(records);
    const managedNames = this.managedLabelNames();
    const drifted: Array<{ record: GithubRecord; want: string[] }> = [];
    for (const record of records) {
      const want = expected.get(record.task.id) ?? [];
      const have = record.issue.labels.filter((label) =>
        managedNames.includes(label),
      );
      const same =
        have.length === want.length &&
        want.every((label) => have.includes(label));
      if (!same) drifted.push({ record, want });
    }
    return drifted;
  }

  /** Read-side drift note: chips that disagree with derived truth (design §3.4). */
  private markLabelDrift(records: GithubRecord[]): void {
    for (const { record } of this.driftedRecords(records)) {
      record.task.meta = { ...record.task.meta, label_drift: true };
    }
  }

  // -------------------------------------------------------------------------
  // Native sub-issue links: a write-time projection of `parent:` edges. The
  // block stays the source of truth; the native link is display/navigation.
  // GitHub allows one parent per issue, so only the FIRST parent edge is
  // projected; further parent edges stay block-only. A native parent pointing
  // at an issue outside the managed set is a human link and is left alone.
  // -------------------------------------------------------------------------

  private parentDrifted(
    records: GithubRecord[],
  ): Array<{ record: GithubRecord; want: number | null }> {
    const byId = new Map(records.map((r) => [r.task.id, r]));
    const managedNumbers = new Set(records.map((r) => r.issue.number));
    const drifted: Array<{ record: GithubRecord; want: number | null }> = [];
    for (const record of records) {
      const parentDep = record.task.deps.find((dep) => dep.type === "parent");
      const parent = parentDep ? byId.get(parentDep.id) : undefined;
      const want = parent ? parent.issue.number : null;
      const have = record.issue.parentNumber;
      if (want === have) continue;
      if (want === null && (have === null || !managedNumbers.has(have))) {
        continue;
      }
      drifted.push({ record, want });
    }
    return drifted;
  }

  private markParentDrift(records: GithubRecord[]): void {
    for (const { record } of this.parentDrifted(records)) {
      record.task.meta = { ...record.task.meta, parent_drift: true };
    }
  }

  private markParentProjectionDegraded(
    record: GithubRecord,
    error: unknown,
  ): void {
    record.task.meta = {
      ...record.task.meta,
      parent_drift: true,
      parent_projection_degraded: true,
    };
    const rawReason =
      error instanceof Error ? error.message : "unknown projection error";
    const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, 240);
    this.warn(
      `warning: sub-issue projection degraded on issue #${record.issue.number}: ${reason}; run tasks-axi render to resync`,
    );
  }

  private async refreshParentLinks(records: GithubRecord[]): Promise<void> {
    const managedNumbers = new Set(records.map((r) => r.issue.number));
    for (const { record, want } of this.parentDrifted(records)) {
      if (
        record.issue.parentNumber !== null &&
        !managedNumbers.has(record.issue.parentNumber)
      ) {
        record.task.meta = { ...record.task.meta, parent_drift: true };
        continue;
      }
      try {
        if (want === null) {
          await this.client.removeSubIssue(
            record.issue.parentNumber as number,
            record.issue.id,
          );
        } else {
          await this.client.addSubIssue(
            want,
            record.issue.id,
            record.issue.parentNumber !== null,
          );
        }
      } catch (error) {
        this.markParentProjectionDegraded(record, error);
        continue;
      }
      record.issue.parentNumber = want;
      if (record.task.meta?.parent_drift) delete record.task.meta.parent_drift;
      if (record.task.meta?.parent_projection_degraded) {
        delete record.task.meta.parent_projection_degraded;
      }
    }
  }

  private markProjectionDegraded(record: GithubRecord, error: unknown): void {
    record.task.meta = {
      ...record.task.meta,
      label_drift: true,
      label_projection_degraded: true,
    };
    const rawReason =
      error instanceof Error ? error.message : "unknown projection error";
    const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, 240);
    this.warn(
      `warning: projection labels degraded on issue #${record.issue.number}: ${reason}; run tasks-axi render to resync`,
    );
  }

  /** Global projection refresh after every write. */
  private async refreshProjections(records: GithubRecord[]): Promise<void> {
    const managedNames = this.managedLabelNames();
    for (const { record, want } of this.driftedRecords(records)) {
      const have = record.issue.labels.filter((label) =>
        managedNames.includes(label),
      );
      const add = want.filter((label) => !have.includes(label));
      const remove = have.filter((label) => !want.includes(label));
      try {
        await this.client.updateLabels(record.issue.number, { add, remove });
      } catch (error) {
        this.markProjectionDegraded(record, error);
        continue;
      }
      record.issue.labels = [
        ...record.issue.labels.filter((label) => !remove.includes(label)),
        ...add,
      ];
      if (record.task.meta?.label_drift) delete record.task.meta.label_drift;
      if (record.task.meta?.label_projection_degraded) {
        delete record.task.meta.label_projection_degraded;
      }
    }
    await this.refreshParentLinks(records);
  }

  // -------------------------------------------------------------------------
  // Write path: strip-and-regenerate the block, field-scoped PATCHes
  // -------------------------------------------------------------------------

  /** Rebuild the managed block fields from the (already mutated) task. */
  private syncManaged(record: GithubRecord): void {
    const task = record.task;
    const managed: ManagedFields = {
      id: task.id,
      // Done normalizes the state tag away, so a later hand-reopen lands
      // queued, matching reopen's markdown semantics (design §5.2).
      inFlight: task.state === "in_flight",
      deps: task.deps,
    };
    if (task.kind !== undefined) managed.kind = task.kind;
    if (task.repo !== undefined) managed.repo = task.repo;
    if (task.priority !== undefined) managed.priority = task.priority;
    if (record.managed.created !== undefined) {
      managed.created = record.managed.created;
    }
    if (task.hold !== undefined) managed.hold = task.hold;
    record.managed = managed;
  }

  private renderBody(record: GithubRecord): string {
    return composeIssueBody(record.prose, renderManagedBlock(record.managed));
  }

  /** Diff the mutated record against the issue and PATCH only what changed. */
  private async persistRecord(record: GithubRecord): Promise<void> {
    this.syncManaged(record);
    const body = this.renderBody(record);
    const patch: IssuePatch = {};
    if (record.task.title !== record.issue.title) {
      patch.title = record.task.title;
    }
    if (body !== record.issue.body) patch.body = body;

    const wantClosed = record.task.state === "done";
    if (wantClosed) {
      // A duplicate close reason already reads as dropped; preserve it rather
      // than rewriting it to not_planned.
      const reasonOk =
        record.task.resolution === "dropped"
          ? record.issue.stateReason === "not_planned" ||
            record.issue.stateReason === "duplicate"
          : record.issue.stateReason === "completed" ||
            record.issue.stateReason === null;
      if (record.issue.state !== "closed" || !reasonOk) {
        patch.state = "closed";
        patch.state_reason =
          record.task.resolution === "dropped" ? "not_planned" : "completed";
      }
    } else if (record.issue.state === "closed") {
      patch.state = "open";
    }

    if (Object.keys(patch).length === 0) return;
    await this.client.updateIssue(record.issue.number, patch);

    if (patch.title !== undefined) record.issue.title = patch.title;
    if (patch.body !== undefined) record.issue.body = patch.body;
    if (patch.state === "closed") {
      record.issue.state = "closed";
      record.issue.stateReason = patch.state_reason ?? "completed";
      record.issue.closedAt ??= new Date().toISOString();
      record.task.meta = {
        ...record.task.meta,
        state_reason: record.issue.stateReason,
      };
    } else if (patch.state === "open") {
      record.issue.state = "open";
      record.issue.stateReason = "reopened";
      record.issue.closedAt = null;
      record.task.meta = { ...record.task.meta, state_reason: "reopened" };
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    if (input.kind === PUBLIC_FOLLOWUP_KIND || input.public_followup) {
      throw unsupportedPublicFollowup();
    }
    const records = await this.loadAll();
    const id = validateId(input.id);
    if (records.some((r) => r.task.id === id)) {
      throw new AxiError(`Task "${input.id}" already exists`, "CONFLICT");
    }
    const state: State = input.state ?? "queued";
    if (input.resolution !== undefined && state !== "done") {
      throw new AxiError(
        "resolution applies only to Done tasks",
        "VALIDATION_ERROR",
      );
    }
    const title = normalizeTitle(input.title);
    const kind = normalizeTagValue(input.kind, "kind");
    const repo = normalizeTagValue(input.repo, "repo");
    const deps = (input.deps ?? []).map((dep) => normalizeDep(id, dep));
    this.requireExistingDeps(records, deps);
    const hold = normalizeHold(input.hold);
    const priority = normalizePriority(input.priority);

    // Links live in the body prose (issue titles are UI elements, design §4.3).
    let prose = input.body ?? "";
    for (const link of input.links ?? []) {
      const { url } = normalizeTypedLink(link);
      if (!deriveLinks(`${title}\n${prose}`).some((l) => l.url === url)) {
        prose = addBodyLine(prose || undefined, url);
      }
    }

    const managed: ManagedFields = {
      id,
      inFlight: state === "in_flight",
      deps,
    };
    if (kind !== undefined) managed.kind = kind;
    if (repo !== undefined) managed.repo = repo;
    if (priority !== undefined) managed.priority = priority;
    if (hold !== undefined) managed.hold = hold;
    if (typeof input.created === "string") {
      // The `(since)` override is written only when it differs from the native
      // createdAt (the migration/import case, design §4.3).
      const created = normalizeDate(input.created, "created date");
      if (created !== this.now()) managed.created = created;
    }

    const issue = await this.client.createIssue(
      title,
      composeIssueBody(prose, renderManagedBlock(managed)),
    );
    if (state === "done") {
      const reason =
        input.resolution === "dropped" ? "not_planned" : "completed";
      await this.client.updateIssue(issue.number, {
        state: "closed",
        state_reason: reason,
      });
      issue.state = "closed";
      issue.stateReason = reason;
      issue.closedAt = issue.createdAt;
    }

    const record: GithubRecord = {
      issue,
      managed,
      prose,
      task: this.toTask(issue, managed, prose),
    };
    records.push(record);
    this.sortRecords(records);
    await this.refreshProjections(records);
    return record.task;
  }

  async get(id: string): Promise<Task | null> {
    const records = await this.loadAll();
    return records.find((r) => r.task.id === id)?.task ?? null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const records = await this.loadAll();
    let items = records.map((r) => r.task);
    if (query.state) items = items.filter((t) => t.state === query.state);
    if (query.repo) items = items.filter((t) => t.repo === query.repo);
    if (query.kind) items = items.filter((t) => t.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    const records = await this.loadAll();
    const record = this.findRecord(records, id);
    const task = record.task;
    if (patch.meta) {
      throw new AxiError(
        "github task meta is derived from the issue and cannot be patched",
        "VALIDATION_ERROR",
      );
    }

    const nextBody =
      patch.body !== undefined ? patch.body || undefined : task.body;
    const supersededBody =
      patch.archiveBody && patch.body !== undefined && task.body !== nextBody
        ? task.body
        : undefined;

    const changed: TaskUpdateChange[] = [];
    const markChanged = (field: TaskUpdateChange) => {
      if (!changed.includes(field)) changed.push(field);
    };
    if (patch.title !== undefined) {
      const title = normalizeTitle(patch.title);
      if (task.title !== title) {
        task.title = title;
        markChanged("title");
      }
    }
    if (patch.body !== undefined && task.body !== nextBody) {
      setProse(record, nextBody ?? "");
      markChanged("body");
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line !== "" && !bodyHasLine(record.prose || undefined, line)) {
        setProse(record, addBodyLine(record.prose || undefined, line));
        markChanged("body");
      }
    }
    if (patch.repo !== undefined) {
      const repo = normalizeTagValue(patch.repo, "repo");
      if (task.repo !== repo) {
        if (repo === undefined) {
          delete task.repo;
        } else {
          task.repo = repo;
        }
        markChanged("repo");
      }
    }
    if (patch.kind !== undefined) {
      const kind = normalizeTagValue(patch.kind, "kind");
      if (kind === PUBLIC_FOLLOWUP_KIND) throw unsupportedPublicFollowup();
      if (task.kind !== kind) {
        if (kind === undefined) {
          delete task.kind;
        } else {
          task.kind = kind;
        }
        markChanged("kind");
      }
    }
    if (patch.hold !== undefined) {
      const hold = normalizeHold(patch.hold ?? undefined);
      if (!sameHold(task.hold, hold)) {
        if (hold) {
          task.hold = hold;
        } else {
          delete task.hold;
        }
        markChanged("hold");
      }
    }
    if (patch.priority !== undefined) {
      const priority = normalizePriority(patch.priority);
      if (task.priority !== priority) {
        task.priority = priority;
        markChanged("priority");
      }
    }
    if (patch.resolution !== undefined) {
      if (task.state !== "done") {
        throw new AxiError(
          "resolution applies only to Done tasks",
          "VALIDATION_ERROR",
        );
      }
      const resolution =
        patch.resolution === "completed" ? undefined : patch.resolution;
      if (task.resolution !== resolution) {
        if (resolution) {
          task.resolution = resolution;
        } else {
          delete task.resolution;
        }
        markChanged("resolution");
      }
    }
    for (const link of patch.addLinks ?? []) {
      const { url } = normalizeTypedLink(link);
      if (!proseLinks(record).some((l) => l.url === url)) {
        setProse(record, addBodyLine(record.prose || undefined, url));
        markChanged("links");
      }
    }
    if (changed.length === 0) return { task, changed };

    task.links = proseLinks(record);
    task.updated = this.now();
    if (supersededBody !== undefined) {
      // GitHub's native home for history: the superseded body becomes a comment.
      await this.client.addComment(
        record.issue.number,
        `tasks-axi archived this superseded body on ${this.now()}:\n\n${supersededBody}`,
      );
      markChanged("archive");
    }
    await this.persistRecord(record);
    await this.refreshProjections(records);
    return { task, changed };
  }

  /**
   * `rm` de-manages (design §4.4): strip the managed block and close the issue
   * as not_planned, leaving an ordinary closed issue whose title and prose
   * survive as history. Non-destructive; no elevated permission needed.
   */
  async remove(id: string): Promise<Task> {
    const records = await this.loadAll();
    const record = this.findRecord(records, id);
    this.requireNoActiveDependents(records, id);
    const managedNumbers = new Set(records.map((r) => r.issue.number));
    const failRemoval = (): AxiError =>
      new AxiError(
        `Could not retract native sub-issue links for task "${id}"`,
        "UNKNOWN",
        [`Run \`tasks-axi rm ${id}\` again to retry`],
      );
    if (record.issue.parentNumber !== null) {
      const parentNumber = record.issue.parentNumber;
      if (managedNumbers.has(parentNumber)) {
        try {
          await this.client.removeSubIssue(parentNumber, record.issue.id);
        } catch {
          throw failRemoval();
        }
        record.issue.parentNumber = null;
      }
    }
    for (const child of records) {
      if (child === record) continue;
      if (child.issue.parentNumber !== record.issue.number) continue;
      try {
        await this.client.removeSubIssue(
          record.issue.number,
          child.issue.id,
        );
      } catch {
        throw failRemoval();
      }
      child.issue.parentNumber = null;
    }

    await this.client.updateIssue(record.issue.number, {
      body: record.prose,
      state: "closed",
      state_reason: "not_planned",
    });
    const remove = record.issue.labels.filter((label) =>
      this.managedLabelNames().includes(label),
    );
    if (remove.length > 0) {
      try {
        await this.client.updateLabels(record.issue.number, {
          add: [],
          remove,
        });
      } catch (error) {
        this.markProjectionDegraded(record, error);
      }
    }
    records.splice(records.indexOf(record), 1);
    await this.refreshProjections(records);
    return record.task;
  }

  // -------------------------------------------------------------------------
  // State + dependencies
  // -------------------------------------------------------------------------

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    const records = await this.loadAll();
    const record = this.findRecord(records, id);
    const task = record.task;
    const date = normalizeDate(opts.date ?? this.now(), "transition date");

    const transitionLinks: TaskLink[] = [];
    if (opts.pr !== undefined)
      transitionLinks.push({ kind: "pr", url: opts.pr });
    if (opts.report !== undefined) {
      transitionLinks.push({ kind: "report", url: opts.report });
    }
    for (const link of transitionLinks) {
      const { url } = normalizeTypedLink(link);
      if (!proseLinks(record).some((l) => l.url === url)) {
        setProse(record, addBodyLine(record.prose || undefined, url));
      }
    }
    if (opts.note) {
      setProse(record, addBodyLine(record.prose || undefined, opts.note));
    }
    task.links = proseLinks(record);

    task.state = to;
    if (to === "done") {
      task.closed = date;
      if (opts.dropped) {
        task.resolution = "dropped";
      } else {
        delete task.resolution;
      }
    } else {
      delete task.closed;
      delete task.resolution;
    }
    task.updated = this.now();

    await this.persistRecord(record);
    this.sortRecords(records);
    await this.refreshProjections(records);
    return task;
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupportedPublicFollowup();
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checked = normalizeDep(id, dep);
    const records = await this.loadAll();
    const record = this.findRecord(records, id);
    if (
      record.task.deps.some(
        (d) => d.type === checked.type && d.id === checked.id,
      )
    ) {
      return false;
    }
    this.requireExistingDeps(records, [checked]);
    record.task.deps.push(checked);
    await this.persistRecord(record);
    await this.refreshProjections(records);
    return true;
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checked: Dep = { ...dep, id: validateDependencyId(dep.id) };
    const records = await this.loadAll();
    const record = this.findRecord(records, id);
    const before = record.task.deps.length;
    record.task.deps = record.task.deps.filter(
      (d) => !(d.type === checked.type && d.id === checked.id),
    );
    if (record.task.deps.length === before) return false;
    await this.persistRecord(record);
    await this.refreshProjections(records);
    return true;
  }

  // -------------------------------------------------------------------------
  // Maintenance: `render` is the manual resync verb; there is no `prune`
  // (closed issues are already GitHub's archive, design §7).
  // -------------------------------------------------------------------------

  async render(): Promise<number> {
    const records = await this.loadAll();
    for (const record of records) {
      this.syncManaged(record);
      const body = this.renderBody(record);
      if (body !== record.issue.body) {
        await this.client.updateIssue(record.issue.number, { body });
        record.issue.body = body;
      }
    }
    await this.refreshProjections(records);
    return records.length;
  }
}
