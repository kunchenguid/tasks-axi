import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AxiError, unsupported } from "../errors.js";
import { validateId } from "../id.js";
import type {
  Dep,
  DepType,
  Hold,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import { PUBLIC_FOLLOWUP_KIND } from "../public-followup.js";
import type {
  Capabilities,
  PruneOptions,
  PruneResult,
  Store,
} from "../store.js";
import { atomicWrite, withLock } from "./lock.js";
import {
  type BacklogDoc,
  type Entry,
  type Section,
  deriveLinks,
  renderBacklog,
  renderTaskLines,
} from "./markdown-grammar.js";
import {
  addBodyLine,
  appendTitleLink,
  bodyHasLine,
  normalizeDate,
  normalizeDep,
  normalizeHold,
  normalizePriority,
  normalizeTagValue,
  normalizeTitle,
  sameHold,
  sameMeta,
} from "./normalize.js";

/**
 * A Store backed by the beads issue tracker (https://github.com/gastownhall/beads).
 *
 * The beads database (`.beads/` under `dir`, driven through the `bd` CLI with
 * `--json`) is the source of truth. After every mutation the backend re-renders
 * `mirrorPath` as a read-only canonical-markdown mirror of the active backlog,
 * so tools that read the markdown grammar directly (firstmate's fleet snapshot,
 * voice records, inbox view) keep working unchanged on top of beads.
 *
 * Field mapping:
 * - state <-> bd status: queued=open, in_flight=in_progress, done=closed;
 *   bd-native `blocked`/`deferred`/other statuses read back as queued
 *   (tasks-axi derives blocked/held above the seam).
 * - deps <-> bd dependencies: blocked-by=blocks, parent=parent-child,
 *   discovered-from=discovered-from; unknown bd edge types are ignored.
 * - kind/repo/priority/hold/created/closed/dep reasons/meta live in one
 *   `tasks_axi` object inside bd issue metadata; those fields are authoritative
 *   over bd's own priority/timestamps so the mirror round-trips exactly.
 * - links live in the title prose exactly like the markdown backend, so
 *   `deriveLinks(title)` works identically on both backends.
 * - a hold with `until` also sets bd's `--defer` date for bd-native views.
 *
 * Pruned Done tasks are archived to `archivePath` and flagged
 * `tasks_axi.archived` in bd (hidden from tasks-axi, retained by beads).
 * Public-followups are unsupported: their compare-and-swap contract has no bd
 * primitive yet, and firstmate only needs them when Relay is enabled.
 */

export interface BeadsStoreOptions {
  /** Directory holding the beads workspace (`.beads/`); bd runs from here. */
  dir: string;
  /** Canonical-markdown mirror path, rewritten after every mutation. */
  mirrorPath: string;
  /** bd binary to execute (default "bd"). */
  bin?: string;
  /** Where pruned Done items are archived (default `<mirror dir>/done-archive.md`). */
  archivePath?: string;
  /** Where superseded task bodies are archived (default `<mirror dir>/note-archive.md`). */
  noteArchivePath?: string;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
  /** Per-bd-invocation timeout in milliseconds (default 60s). */
  timeoutMs?: number;
}

interface BdDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

interface BdIssue {
  id: string;
  title: string;
  status: string;
  priority?: number;
  issue_type?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  dependencies?: BdDependency[];
  created_at?: string;
  updated_at?: string;
}

/** The tasks-axi payload stored under `metadata.tasks_axi` on every bd issue. */
interface TasksAxiMeta {
  v: 1;
  kind?: string;
  repo?: string;
  priority?: number;
  hold?: Hold;
  created?: string;
  closed?: string;
  /** Dependency reasons keyed by `<type>:<blocker id>`. */
  dep_reasons?: Record<string, string>;
  meta?: Record<string, unknown>;
  /** Pruned out of the active backlog; retained in beads, hidden from tasks-axi. */
  archived?: boolean;
}

interface BeadsCache {
  tasks: Task[];
  byId: Map<string, Task>;
  /** Every bd issue including archived ones, for id-collision checks. */
  rawIds: Set<string>;
}

const ORDER: State[] = ["in_flight", "queued", "done"];
const HEADERS: Record<State, string> = {
  in_flight: "## In flight",
  queued: "## Queued",
  done: "## Done",
};

const BD_STATUS: Record<State, string> = {
  queued: "open",
  in_flight: "in_progress",
  done: "closed",
};

const DEP_TYPE_TO_BD: Record<DepType, string> = {
  "blocked-by": "blocks",
  parent: "parent-child",
  "discovered-from": "discovered-from",
};

const DEP_TYPE_FROM_BD: Record<string, DepType> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};

function stateFromStatus(status: string): State {
  if (status === "closed") return "done";
  if (status === "in_progress") return "in_flight";
  // open, blocked, deferred, and any custom bd status read back as queued;
  // blocked/held are derived above the seam from deps and holds.
  return "queued";
}

function depReasonKey(dep: Dep): string {
  return `${dep.type}:${dep.id}`;
}

function today(): string {
  // Local date (firstmate's dates are local), not UTC.
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function cloneTask(task: Task): Task {
  const copy: Task = {
    ...task,
    links: task.links.map((link) => ({ ...link })),
    deps: task.deps.map((dep) => ({ ...dep })),
  };
  if (task.hold) copy.hold = { ...task.hold };
  if (task.meta) copy.meta = { ...task.meta };
  return copy;
}

export class BeadsStore implements Store {
  private readonly dir: string;
  private readonly mirrorPath: string;
  private readonly bin: string;
  private readonly archivePath: string;
  private readonly noteArchivePath: string;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private cache?: BeadsCache;

  constructor(options: BeadsStoreOptions) {
    this.dir = options.dir;
    this.mirrorPath = options.mirrorPath;
    this.bin = options.bin ?? "bd";
    this.archivePath =
      options.archivePath ?? `${dirname(options.mirrorPath)}/done-archive.md`;
    this.noteArchivePath =
      options.noteArchivePath ??
      `${dirname(options.mirrorPath)}/note-archive.md`;
    if (resolve(this.archivePath) === resolve(this.mirrorPath)) {
      throw new AxiError(
        "Archive path must not be the mirror path",
        "VALIDATION_ERROR",
      );
    }
    if (resolve(this.noteArchivePath) === resolve(this.mirrorPath)) {
      throw new AxiError(
        "Note archive path must not be the mirror path",
        "VALIDATION_ERROR",
      );
    }
    this.now = options.now ?? today;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: true,
      comments: false,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: false,
      serverMintsIds: false,
      publicFollowups: false,
    };
  }

  // -------------------------------------------------------------------------
  // bd subprocess plumbing
  // -------------------------------------------------------------------------

  private runBd(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.bin, args, {
        cwd: this.dir,
        env: { ...process.env, BEADS_DIR: join(this.dir, ".beads") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() =>
          rejectPromise(
            new AxiError(
              `beads backend: \`bd ${args[0]}\` timed out after ${this.timeoutMs}ms`,
              "UNKNOWN",
              ["Check that the beads database is healthy with `bd doctor`"],
            ),
          ),
        );
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        settle(() =>
          rejectPromise(
            error.code === "ENOENT"
              ? new AxiError(
                  `beads backend: \`${this.bin}\` CLI not found`,
                  "VALIDATION_ERROR",
                  [
                    "Install beads: `npm install -g @beads/bd` (or `brew install beads`)",
                  ],
                )
              : this.bdError(args[0], error.message),
          ),
        );
      });
      child.on("close", (code) => {
        settle(() => {
          if (code === 0) {
            resolvePromise(stdout);
          } else {
            rejectPromise(this.bdError(args[0], stderr.trim() || stdout.trim()));
          }
        });
      });
      child.stdin.on("error", () => {
        // A fast-failing bd exit closes stdin first; the close handler reports.
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  private bdError(verb: string | undefined, detail: string): AxiError {
    const firstLine = detail.split("\n")[0] || "unknown error";
    if (/no beads database found/i.test(detail)) {
      return new AxiError(
        `beads backend: no beads database found in ${this.dir}`,
        "VALIDATION_ERROR",
        [`Run \`bd init\` in ${this.dir}, or point [beads] dir at the workspace`],
      );
    }
    if (/lock|locked|busy|another process/i.test(detail)) {
      return new AxiError(
        `beads backend: the beads database is busy — ${firstLine}`,
        "LOCKED",
        ["Retry the command once the concurrent bd operation finishes"],
      );
    }
    return new AxiError(
      `beads backend: \`bd ${verb ?? ""}\` failed — ${firstLine}`,
      "UNKNOWN",
    );
  }

  // -------------------------------------------------------------------------
  // Read side: one cached `bd list --json --all` serves every read
  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.cache = undefined;
  }

  private async loadAll(): Promise<BeadsCache> {
    if (this.cache) return this.cache;
    const raw = await this.runBd(["list", "--json", "--all", "-n", "0"]);
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? [] : JSON.parse(raw);
    } catch {
      throw new AxiError(
        "beads backend: `bd list --json` returned unparseable output",
        "UNKNOWN",
      );
    }
    if (!Array.isArray(parsed)) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : "unexpected non-array output";
      throw new AxiError(`beads backend: bd list failed — ${message}`, "UNKNOWN");
    }
    const issues = parsed as BdIssue[];
    const tasks: Task[] = [];
    const rawIds = new Set<string>();
    for (const issue of issues) {
      if (!issue || typeof issue.id !== "string") continue;
      rawIds.add(issue.id);
      const ta = this.tasksAxiMeta(issue);
      if (ta.archived) continue;
      tasks.push(this.taskFromIssue(issue, ta));
    }
    tasks.sort((a, b) => this.taskOrder(a, b, issues));
    this.cache = { tasks, byId: new Map(tasks.map((t) => [t.id, t])), rawIds };
    return this.cache;
  }

  private taskOrder(a: Task, b: Task, issues: BdIssue[]): number {
    const stateRank = (t: Task) => ORDER.indexOf(t.state);
    if (stateRank(a) !== stateRank(b)) return stateRank(a) - stateRank(b);
    if (a.state === "done") {
      // Newest done first, matching the markdown backend's top insertion, so
      // `prune --keep N` retains the most recent completions.
      const closedCmp = (b.closed ?? "").localeCompare(a.closed ?? "");
      if (closedCmp !== 0) return closedCmp;
    }
    const createdAt = (t: Task) =>
      issues.find((i) => i.id === t.id)?.created_at ?? "";
    const createdCmp = createdAt(a).localeCompare(createdAt(b));
    if (createdCmp !== 0) return createdCmp;
    return a.id.localeCompare(b.id);
  }

  private tasksAxiMeta(issue: BdIssue): TasksAxiMeta {
    const value = issue.metadata?.tasks_axi;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { v: 1 };
    }
    return value as TasksAxiMeta;
  }

  private taskFromIssue(issue: BdIssue, ta: TasksAxiMeta): Task {
    const title = typeof issue.title === "string" ? issue.title : "";
    const task: Task = {
      id: issue.id,
      title,
      state: stateFromStatus(issue.status),
      links: deriveLinks(title),
      deps: [],
    };
    for (const edge of issue.dependencies ?? []) {
      const type = DEP_TYPE_FROM_BD[edge.type];
      if (!type) continue;
      const dep: Dep = { type, id: edge.depends_on_id };
      const reason = ta.dep_reasons?.[depReasonKey(dep)];
      if (reason) dep.reason = reason;
      task.deps.push(dep);
    }
    if (typeof ta.kind === "string") task.kind = ta.kind;
    if (typeof ta.repo === "string") task.repo = ta.repo;
    if (typeof ta.priority === "number") task.priority = ta.priority;
    if (ta.hold && typeof ta.hold.reason === "string") {
      task.hold = { ...ta.hold };
    }
    if (typeof ta.created === "string") task.created = ta.created;
    if (typeof ta.closed === "string") task.closed = ta.closed;
    if (ta.meta && typeof ta.meta === "object") task.meta = { ...ta.meta };
    const body = (issue.description ?? "").replace(/\n+$/, "");
    if (body !== "") task.body = body;
    return task;
  }

  /** Build the authoritative `tasks_axi` metadata payload for a task. */
  private metaPayload(task: Task): TasksAxiMeta {
    const ta: TasksAxiMeta = { v: 1 };
    if (task.kind) ta.kind = task.kind;
    if (task.repo) ta.repo = task.repo;
    if (task.priority !== undefined) ta.priority = task.priority;
    if (task.hold) ta.hold = { ...task.hold };
    if (task.created) ta.created = task.created;
    if (task.closed) ta.closed = task.closed;
    const reasons: Record<string, string> = {};
    for (const dep of task.deps) {
      if (dep.reason) reasons[depReasonKey(dep)] = dep.reason;
    }
    if (Object.keys(reasons).length > 0) ta.dep_reasons = reasons;
    if (task.meta && Object.keys(task.meta).length > 0) ta.meta = { ...task.meta };
    return ta;
  }

  private metadataArg(task: Task, extra?: Partial<TasksAxiMeta>): string {
    return JSON.stringify({ tasks_axi: { ...this.metaPayload(task), ...extra } });
  }

  private async requireTask(id: string): Promise<Task> {
    const { byId } = await this.loadAll();
    const task = byId.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return task;
  }

  private requireExistingDeps(cache: BeadsCache, deps: Dep[]): void {
    for (const dep of deps) {
      if (cache.byId.has(dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(`${label} "${dep.id}" not found`, "VALIDATION_ERROR", [
        "Create the dependency task first, or choose an existing task id",
      ]);
    }
  }

  private requireNoActiveDependents(cache: BeadsCache, id: string): void {
    const dependents = cache.tasks
      .filter(
        (task) =>
          task.state !== "done" &&
          task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((task) => task.id);
    if (dependents.length === 0) return;
    throw new AxiError(
      `Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
      ],
    );
  }

  async get(id: string): Promise<Task | null> {
    const { byId } = await this.loadAll();
    return byId.get(id) ?? null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const { tasks } = await this.loadAll();
    let items = tasks;
    if (query.state) items = items.filter((t) => t.state === query.state);
    if (query.repo) items = items.filter((t) => t.repo === query.repo);
    if (query.kind) items = items.filter((t) => t.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  // -------------------------------------------------------------------------
  // The markdown mirror
  // -------------------------------------------------------------------------

  private async writeMirror(): Promise<BeadsCache> {
    this.invalidate();
    const cache = await this.loadAll();
    const doc: BacklogDoc = {
      finalNewline: true,
      preamble: [
        "# Backlog",
        "",
        "<!-- Read-only mirror generated by tasks-axi from the beads database" +
          " (.beads). Do not hand-edit; mutate through tasks-axi or bd, then" +
          " `tasks-axi render` to refresh. -->",
        "",
      ],
      sections: ORDER.map((state, index) => {
        const entries: Entry[] = cache.tasks
          .filter((task) => task.state === state)
          .map((task) => ({
            kind: "task" as const,
            task,
            raw: [],
            dirty: true,
          }));
        if (index < ORDER.length - 1) {
          entries.push({ kind: "raw", lines: [""] });
        }
        const section: Section = { headerLine: HEADERS[state], state, entries };
        return section;
      }),
    };
    const content = renderBacklog(doc);
    mkdirSync(dirname(this.mirrorPath), { recursive: true });
    await withLock(this.mirrorPath, () => {
      atomicWrite(this.mirrorPath, content);
    });
    return cache;
  }

  private appendArchiveBlock(path: string, lines: string[]): void {
    mkdirSync(dirname(path), { recursive: true });
    const block = `\n## Archived ${this.now()}\n${lines.join("\n")}\n`;
    appendFileSync(path, block, "utf8");
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  private taskFromInput(input: TaskInput): Task {
    if (input.kind === PUBLIC_FOLLOWUP_KIND || input.public_followup) {
      throw unsupported("public-followups", "beads");
    }
    const id = validateId(input.id);
    const state: State = input.state ?? "queued";
    let title = normalizeTitle(input.title);
    const kind = normalizeTagValue(input.kind, "kind");
    const repo = normalizeTagValue(input.repo, "repo");
    // Links live in the prose; fold any provided links into the title text.
    for (const link of input.links ?? []) {
      title = appendTitleLink(title, link);
    }
    const task: Task = {
      id,
      title,
      state,
      links: deriveLinks(title),
      deps: input.deps ? input.deps.map((dep) => normalizeDep(id, dep)) : [],
    };
    if (kind) task.kind = kind;
    if (repo) task.repo = repo;
    if (input.body) task.body = input.body;
    const hold = normalizeHold(input.hold);
    if (hold) task.hold = hold;
    const priority = normalizePriority(input.priority);
    if (priority !== undefined) task.priority = priority;
    if (input.meta) task.meta = input.meta;
    if (input.created !== undefined) {
      if (input.created !== null) {
        task.created = normalizeDate(input.created, "created date");
      }
    } else if (state !== "done") {
      task.created = normalizeDate(this.now(), "created date");
    }
    if (input.closed !== undefined) {
      task.closed = normalizeDate(input.closed, "closed date");
    }
    return task;
  }

  async create(input: TaskInput): Promise<Task> {
    const task = this.taskFromInput(input);
    const cache = await this.loadAll();
    if (cache.rawIds.has(task.id)) {
      throw new AxiError(`Task "${task.id}" already exists`, "CONFLICT");
    }
    this.requireExistingDeps(cache, task.deps);

    const args = [
      "create",
      "--title",
      task.title,
      "--id",
      task.id,
      "--force",
      "-t",
      "task",
      "--silent",
      "--metadata",
      this.metadataArg(task),
    ];
    if (task.priority !== undefined) args.push("-p", String(task.priority));
    if (task.hold?.until) args.push("--defer", task.hold.until);
    if (task.body !== undefined) args.push("--body-file", "-");
    await this.runBd(args, task.body);

    if (task.state !== "queued") {
      await this.runBd(["update", task.id, "-s", BD_STATUS[task.state]]);
    }
    for (const dep of task.deps) {
      await this.addBdDep(task.id, dep);
    }
    const fresh = await this.writeMirror();
    return fresh.byId.get(task.id) ?? task;
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    const current = await this.requireTask(id);
    const task = cloneTask(current);

    const nextBody =
      patch.body !== undefined ? patch.body || undefined : task.body;
    const supersededBody =
      patch.archiveBody && patch.body !== undefined && task.body !== nextBody
        ? task.body
        : undefined;
    const archivedTask = supersededBody !== undefined
      ? { ...cloneTask(task), body: supersededBody }
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
      if (nextBody === undefined) {
        delete task.body;
      } else {
        task.body = nextBody;
      }
      markChanged("body");
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line !== "" && !bodyHasLine(task.body, line)) {
        task.body = addBodyLine(task.body, line);
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
      if (kind === PUBLIC_FOLLOWUP_KIND) {
        throw unsupported("public-followups", "beads");
      }
      if (task.kind !== kind) {
        if (kind === undefined) {
          delete task.kind;
        } else {
          task.kind = kind;
        }
        markChanged("kind");
      }
    }
    let holdChanged = false;
    if (patch.hold !== undefined) {
      const hold = normalizeHold(patch.hold ?? undefined);
      if (!sameHold(task.hold, hold)) {
        if (hold) {
          task.hold = hold;
        } else {
          delete task.hold;
        }
        holdChanged = true;
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
    if (patch.meta) {
      const meta = { ...task.meta, ...patch.meta };
      if (!sameMeta(task.meta, meta)) {
        task.meta = meta;
        markChanged("meta");
      }
    }
    for (const link of patch.addLinks ?? []) {
      const title = appendTitleLink(task.title, link);
      if (task.title !== title) {
        task.title = title;
        markChanged("links");
      }
    }
    if (changed.length === 0) return { task: current, changed };

    task.links = deriveLinks(task.title);
    task.updated = this.now();

    const args = ["update", id, "--metadata", this.metadataArg(task)];
    if (task.title !== current.title) args.push("--title", task.title);
    if (changed.includes("body")) {
      args.push("--body-file", "-");
      if (task.body === undefined) args.push("--allow-empty-description");
    }
    if (task.priority !== undefined && task.priority !== current.priority) {
      args.push("-p", String(task.priority));
    }
    if (holdChanged) args.push("--defer", task.hold?.until ?? "");
    await this.runBd(args, changed.includes("body") ? (task.body ?? "") : undefined);

    if (archivedTask) {
      this.appendArchiveBlock(
        this.noteArchivePath,
        renderTaskLines(archivedTask),
      );
      markChanged("archive");
    }
    await this.writeMirror();
    return { task, changed };
  }

  async remove(id: string): Promise<Task> {
    const cache = await this.loadAll();
    const task = cache.byId.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    this.requireNoActiveDependents(cache, id);
    await this.runBd(["delete", id, "-f"]);
    await this.writeMirror();
    return task;
  }

  // -------------------------------------------------------------------------
  // State + dependencies
  // -------------------------------------------------------------------------

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    const current = await this.requireTask(id);
    const task = cloneTask(current);
    const date = normalizeDate(opts.date ?? this.now(), "transition date");

    if (opts.pr !== undefined) {
      task.title = appendTitleLink(task.title, { kind: "pr", url: opts.pr });
    }
    if (opts.report !== undefined) {
      task.title = appendTitleLink(task.title, {
        kind: "report",
        url: opts.report,
      });
    }
    if (opts.note) {
      task.body = task.body ? `${task.body}\n${opts.note}` : opts.note;
    }
    task.links = deriveLinks(task.title);

    task.state = to;
    if (to === "done") {
      task.closed = date;
    } else if (to === "in_flight") {
      if (!task.created) task.created = date;
      delete task.closed;
    } else {
      delete task.closed;
    }
    task.updated = this.now();

    const args = [
      "update",
      id,
      "-s",
      BD_STATUS[to],
      "--metadata",
      this.metadataArg(task),
    ];
    if (task.title !== current.title) args.push("--title", task.title);
    const bodyChanged = task.body !== current.body;
    if (bodyChanged) args.push("--body-file", "-");
    await this.runBd(args, bodyChanged ? (task.body ?? "") : undefined);

    await this.writeMirror();
    return task;
  }

  private async addBdDep(id: string, dep: Dep): Promise<void> {
    const line = JSON.stringify({
      issue_id: id,
      depends_on_id: dep.id,
      type: DEP_TYPE_TO_BD[dep.type],
    });
    await this.runBd(["dep", "add", "--file", "-"], `${line}\n`);
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checkedDep = normalizeDep(id, dep);
    const cache = await this.loadAll();
    const task = cache.byId.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    if (
      task.deps.some(
        (d) => d.type === checkedDep.type && d.id === checkedDep.id,
      )
    ) {
      return false;
    }
    this.requireExistingDeps(cache, [checkedDep]);
    await this.addBdDep(id, checkedDep);
    if (checkedDep.reason) {
      const next = cloneTask(task);
      next.deps.push(checkedDep);
      await this.runBd(["update", id, "--metadata", this.metadataArg(next)]);
    }
    await this.writeMirror();
    return true;
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const cache = await this.loadAll();
    const task = cache.byId.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const remaining = task.deps.filter(
      (d) => !(d.type === dep.type && d.id === dep.id),
    );
    if (remaining.length === task.deps.length) return false;
    await this.runBd(["dep", "remove", id, dep.id]);
    const removed = task.deps.find(
      (d) => d.type === dep.type && d.id === dep.id,
    );
    if (removed?.reason) {
      const next = cloneTask(task);
      next.deps = remaining;
      await this.runBd(["update", id, "--metadata", this.metadataArg(next)]);
    }
    await this.writeMirror();
    return true;
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public-followups", "beads");
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async prune(options: PruneOptions): Promise<PruneResult> {
    const cache = await this.loadAll();
    const candidates = cache.tasks.filter(
      (task) => task.state === options.state,
    );
    const keep = Math.max(0, options.keep);
    const surplus = candidates.slice(keep);
    if (surplus.length === 0) return { archived: 0, ids: [] };

    if (options.archive) {
      this.appendArchiveBlock(
        this.archivePath,
        surplus.flatMap((task) => renderTaskLines(task)),
      );
    }
    for (const task of surplus) {
      await this.runBd([
        "update",
        task.id,
        "--metadata",
        this.metadataArg(task, { archived: true }),
      ]);
    }
    await this.writeMirror();
    return { archived: surplus.length, ids: surplus.map((task) => task.id) };
  }

  async render(): Promise<number> {
    const cache = await this.writeMirror();
    return cache.tasks.length;
  }
}
