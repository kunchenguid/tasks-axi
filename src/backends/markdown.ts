import {
  appendFileSync,
  mkdirSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  Hold,
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
import { HOLD_KINDS } from "../model.js";
import {
  PUBLIC_FOLLOWUP_KIND,
  assertPublicFollowupMutation,
  assertPublicFollowupTaskState,
  canonicalEqual,
  clonePublicFollowup,
  isPublicFollowupTask,
  isPublicFollowupTerminal,
  normalizePublicFollowup,
  type PublicFollowupMutation,
} from "../public-followup.js";
import type {
  Capabilities,
  PruneOptions,
  PruneResult,
  Store,
  TaskLookupOptions,
  TaskLookupResult,
} from "../store.js";
import { atomicWrite, readFileSafe, withLock, withLocks } from "./lock.js";
import {
  type BacklogDoc,
  type Entry,
  type Section,
  type TaskEntry,
  deriveLinks,
  extractTags,
  parseBacklog,
  parseDoneArchive,
  renderBacklog,
  renderTaskLines,
} from "./markdown-grammar.js";

export interface MarkdownStoreOptions {
  path: string;
  /** Done archive used by pruning and read-only lookup (default `<dir>/done-archive.md`). */
  archivePath?: string;
  /** Where superseded task bodies are archived (default `<dir>/note-archive.md`). */
  noteArchivePath?: string;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
}

const ORDER: State[] = ["in_flight", "queued", "done"];
const HEADERS: Record<State, string> = {
  in_flight: "## In flight",
  queued: "## Queued",
  done: "## Done",
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEP_REASON_EDGE_MARKER_RE =
  /(?:^|\s)(?:blocked-by|parent|discovered-from):\s/;

interface LoadedBacklogDoc {
  doc: BacklogDoc;
  source: string | undefined;
}

interface ArchiveRestorePoint {
  existed: boolean;
  size: number;
}

function today(): string {
  // Local date (firstmate's dates are local, e.g. "2026-06-22"), not UTC.
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function errno(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "UNKNOWN";
}

function normalizeTitle(title: string): string {
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

function normalizeTagValue(
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

function normalizeTypedLink(link: TaskLink): TaskLink {
  const url = normalizeLinkUrl(link.url);
  const derived = deriveLinks(url);
  if (
    !derived.some(
      (candidate) => candidate.kind === link.kind && candidate.url === url,
    )
  ) {
    const expected =
      link.kind === "pr"
        ? "an http(s) pull request URL ending in /pull/<number>"
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

function normalizePriority(priority: number | undefined): number | undefined {
  if (priority === undefined) return undefined;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new AxiError(
      "Task priority must be an integer 0-4",
      "VALIDATION_ERROR",
    );
  }
  return priority;
}

function normalizeHold(hold: Hold | undefined): Hold | undefined {
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

function normalizeDate(value: string, field: string): string {
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

function normalizeDep(ownerId: string, dep: Dep): Dep {
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

function appendTitleLink(title: string, link: TaskLink): string {
  const { url } = normalizeTypedLink(link);
  if (deriveLinks(title).some((link) => link.url === url)) return title;
  return normalizeTitle(`${title} ${url}`);
}

function bodyHasLine(body: string | undefined, line: string): boolean {
  return body?.split("\n").includes(line) ?? false;
}

function addBodyLine(body: string | undefined, line: string): string {
  return body ? `${body}\n${line}` : line;
}

function sameHold(left: Hold | undefined, right: Hold | undefined): boolean {
  return (
    left?.reason === right?.reason &&
    left?.kind === right?.kind &&
    left?.until === right?.until
  );
}

function sameMeta(
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

function taskToInput(task: Task): TaskInput {
  const input: TaskInput = {
    id: task.id,
    title: task.title,
    state: task.state,
    deps: task.deps.map((dep) => ({ ...dep })),
    links: task.links.map((link) => ({ ...link })),
  };
  if (task.kind) input.kind = task.kind;
  if (task.repo) input.repo = task.repo;
  if (task.body) input.body = task.body;
  if (task.hold) input.hold = { ...task.hold };
  if (task.priority !== undefined) input.priority = task.priority;
  input.created = task.created ?? null;
  if (task.closed) input.closed = task.closed;
  if (task.public_followup) {
    input.public_followup = clonePublicFollowup(task.public_followup);
  }
  if (task.meta) input.meta = { ...task.meta };
  return input;
}

export class MarkdownStore implements Store {
  private readonly path: string;
  private readonly archivePath: string;
  private readonly noteArchivePath: string;
  private readonly now: () => string;

  constructor(options: MarkdownStoreOptions) {
    this.path = options.path;
    this.archivePath =
      options.archivePath ?? `${dirname(options.path)}/done-archive.md`;
    this.noteArchivePath =
      options.noteArchivePath ?? `${dirname(options.path)}/note-archive.md`;
    if (resolve(this.archivePath) === resolve(this.path)) {
      throw new AxiError(
        "Archive path must not be the active backlog path",
        "VALIDATION_ERROR",
      );
    }
    if (resolve(this.noteArchivePath) === resolve(this.path)) {
      throw new AxiError(
        "Note archive path must not be the active backlog path",
        "VALIDATION_ERROR",
      );
    }
    this.now = options.now ?? today;
  }

  capabilities(): Capabilities {
    return {
      backend: "markdown",
      deps: true,
      prune: true,
      comments: false,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: true,
      serverMintsIds: false,
      publicFollowups: true,
    };
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  private loadSource(): string | undefined {
    return readFileSafe(this.path);
  }

  private load(): BacklogDoc {
    return parseBacklog(this.loadSource() ?? "");
  }

  private loadArchive(): BacklogDoc {
    return parseDoneArchive(readFileSafe(this.archivePath) ?? "");
  }

  private loadForUpdate(): LoadedBacklogDoc {
    const source = this.loadSource();
    return { doc: parseBacklog(source ?? ""), source };
  }

  private allTasks(doc: BacklogDoc): Task[] {
    const tasks: Task[] = [];
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        if (entry.kind === "task") tasks.push(entry.task);
      }
    }
    return tasks;
  }

  private findEntry(
    doc: BacklogDoc,
    id: string,
  ): { section: Section; index: number; entry: TaskEntry } | null {
    for (const section of doc.sections) {
      for (let i = 0; i < section.entries.length; i++) {
        const entry = section.entries[i];
        if (entry.kind === "task" && entry.task.id === id) {
          return { section, index: i, entry };
        }
      }
    }
    return null;
  }

  private requireExistingDeps(doc: BacklogDoc, deps: Dep[]): void {
    for (const dep of deps) {
      if (this.findEntry(doc, dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(`${label} "${dep.id}" not found`, "VALIDATION_ERROR", [
        "Create the dependency task first, or choose an existing task id",
      ]);
    }
  }

  private activeDependents(doc: BacklogDoc, id: string): string[] {
    return this.allTasks(doc)
      .filter(
        (task) =>
          task.state !== "done" &&
          task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((task) => task.id);
  }

  private requireNoActiveDependents(doc: BacklogDoc, id: string): void {
    const dependents = this.activeDependents(doc, id);
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
    const found = this.findEntry(this.load(), id);
    return found ? found.entry.task : null;
  }

  async lookup(
    id: string,
    options: TaskLookupOptions = {},
  ): Promise<TaskLookupResult | null> {
    const active = await this.get(id);
    if (active) return { task: active, source: "active" };
    if (!options.includeArchive) return null;

    const archived = this.findEntry(this.loadArchive(), id);
    return archived
      ? { task: archived.entry.task, source: "archive" }
      : null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    let items = this.allTasks(this.load());
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
  // Document mutation helpers (operate on a freshly-loaded doc under lock)
  // -------------------------------------------------------------------------

  private ensureSections(doc: BacklogDoc): void {
    if (doc.preamble.length === 0 && doc.sections.length === 0) {
      doc.preamble = ["# Backlog", ""];
      doc.finalNewline = true;
    }
    for (const state of ORDER) {
      if (!doc.sections.some((s) => s.state === state)) {
        doc.sections.push({
          headerLine: HEADERS[state],
          state,
          entries: [],
        });
      }
    }
  }

  private section(doc: BacklogDoc, state: State): Section {
    const section = doc.sections.find((s) => s.state === state);
    if (!section) throw new AxiError("missing backlog section", "UNKNOWN");
    return section;
  }

  private insert(section: Section, entry: TaskEntry, atTop: boolean): void {
    if (atTop) {
      section.entries.unshift(entry);
      return;
    }
    // Insert after the last content entry, before any trailing blank lines.
    let idx = section.entries.length;
    while (idx > 0) {
      const prev = section.entries[idx - 1];
      if (prev.kind === "raw" && prev.lines.every((l) => l.trim() === "")) {
        idx--;
      } else {
        break;
      }
    }
    section.entries.splice(idx, 0, entry);
  }

  private assertUnchanged(loaded: LoadedBacklogDoc): void {
    if (this.loadSource() !== loaded.source) {
      throw new AxiError(
        "Backlog changed on disk; retry the command",
        "CONFLICT",
        ["Review the latest backlog, then re-run the command"],
      );
    }
  }

  private persist(loaded: LoadedBacklogDoc): void {
    this.assertUnchanged(loaded);
    atomicWrite(this.path, renderBacklog(loaded.doc));
  }

  private removeCreatedTask(id: string): void {
    const loaded = this.loadForUpdate();
    const found = this.findEntry(loaded.doc, id);
    if (!found) return;
    found.section.entries.splice(found.index, 1);
    this.persist(loaded);
  }

  private partialMoveError(
    id: string,
    originalError: unknown,
    rollbackError: unknown,
  ): AxiError {
    const originalMessage =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);
    const rollbackMessage =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    return new AxiError(
      `Move of "${id}" partially completed; task now exists in both backlogs`,
      "CONFLICT",
      [
        "Remove the duplicate from the destination backlog manually before retrying",
        `Source removal failed: ${originalMessage}`,
        `Destination rollback failed: ${rollbackMessage}`,
      ],
    );
  }

  private taskFromInput(input: TaskInput): Task {
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
    if (kind === PUBLIC_FOLLOWUP_KIND) {
      if (task.hold) {
        throw new AxiError(
          "Public-followup obligations cannot use dispatch holds",
          "VALIDATION_ERROR",
        );
      }
      if (!input.public_followup) {
        throw new AxiError(
          "kind=public-followup requires typed public_followup data",
          "VALIDATION_ERROR",
          ["Use `tasks-axi public-followup add ...`"],
        );
      }
      const publicFollowup = normalizePublicFollowup(input.public_followup);
      assertPublicFollowupTaskState(state, publicFollowup, id);
      task.public_followup = publicFollowup;
    } else if (input.public_followup) {
      throw new AxiError(
        "Typed public_followup data requires kind=public-followup",
        "VALIDATION_ERROR",
      );
    }
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

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    return withLock(this.path, () => {
      if (input.kind === PUBLIC_FOLLOWUP_KIND) {
        const value = input.public_followup
          ? normalizePublicFollowup(input.public_followup)
          : undefined;
        if (
          !value ||
          value.revision !== 1 ||
          value.delivery.state !== "intent" ||
          value.work_relations.length !== 0 ||
          input.title.trim() !== value.request.public_safe_summary ||
          input.body !== undefined ||
          (input.links?.length ?? 0) > 0 ||
          (input.state !== undefined && input.state !== "queued")
        ) {
          throw new AxiError(
            "New public-followup must start as a revision 1 queued intent",
            "VALIDATION_ERROR",
            ["Use `tasks-axi public-followup add ...`"],
          );
        }
      }
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      this.ensureSections(doc);
      if (this.findEntry(doc, input.id)) {
        throw new AxiError(`Task "${input.id}" already exists`, "CONFLICT");
      }
      const task = this.taskFromInput(input);
      this.requireExistingDeps(doc, task.deps);
      const entry: TaskEntry = { kind: "task", task, raw: [], dirty: true };
      // New in_flight work goes to the top; queued work appends to the bottom.
      this.insert(
        this.section(doc, task.state),
        entry,
        task.state === "in_flight",
      );
      this.persist(loaded);
      return task;
    });
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      if (
        isPublicFollowupTask(task) &&
        (patch.title !== undefined ||
          patch.body !== undefined ||
          patch.archiveBody ||
          (patch.addBodyLines?.length ?? 0) > 0 ||
          (patch.addLinks?.length ?? 0) > 0 ||
          patch.hold !== undefined)
      ) {
        throw new AxiError(
          "Public-followup content and holds cannot change through generic update",
          "VALIDATION_ERROR",
          ["Create a successor obligation when the public promise changes"],
        );
      }
      const nextBody =
        patch.body !== undefined ? patch.body || undefined : task.body;
      const supersededBody =
        patch.archiveBody && patch.body !== undefined && task.body !== nextBody
          ? task.body
          : undefined;
      const archivedTask =
        supersededBody !== undefined
          ? {
              ...task,
              body: supersededBody,
              deps: task.deps.map((dep) => ({ ...dep })),
              links: task.links.map((link) => ({ ...link })),
            }
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
        task.body = nextBody;
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
        if (
          task.kind === PUBLIC_FOLLOWUP_KIND ||
          kind === PUBLIC_FOLLOWUP_KIND
        ) {
          throw new AxiError(
            "Public-followup kind cannot be changed through generic update",
            "VALIDATION_ERROR",
            ["Use the dedicated `tasks-axi public-followup` commands"],
          );
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
      if (changed.length === 0) return { task, changed };

      task.links = deriveLinks(task.title);
      task.updated = this.now();
      found.entry.dirty = true;
      let archiveRestorePoint: ArchiveRestorePoint | undefined;
      if (archivedTask) {
        this.assertUnchanged(loaded);
        archiveRestorePoint = this.captureArchiveRestorePoint(
          this.noteArchivePath,
        );
        this.appendNoteArchive(renderTaskLines(archivedTask));
        markChanged("archive");
      }
      try {
        this.persist(loaded);
      } catch (error) {
        if (archiveRestorePoint) {
          this.restoreArchive(archiveRestorePoint, this.noteArchivePath);
        }
        throw error;
      }
      return { task, changed };
    });
  }

  async remove(id: string): Promise<Task> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      if (
        isPublicFollowupTask(task) &&
        task.public_followup &&
        !isPublicFollowupTerminal(task.public_followup)
      ) {
        throw new AxiError(
          "Active public-followup obligations cannot be removed",
          "VALIDATION_ERROR",
          ["Record a posted receipt or Captain-approved waiver first"],
        );
      }
      this.requireNoActiveDependents(doc, id);
      found.section.entries.splice(found.index, 1);
      this.persist(loaded);
      return task;
    });
  }

  async moveTo(id: string, target: MarkdownStore): Promise<Task> {
    const [moved] = await this.moveManyTo([id], target);
    return moved;
  }

  /**
   * Move a connected set of tasks to another backlog in one transaction: either
   * every task lands in the destination and leaves the source, or none do (no
   * intermediate state that loses a link is ever written to disk). Each moved
   * task is re-rendered canonically — identical to the single-id path — so
   * multi-paragraph bodies and `blocked-by: <id> - <reason>` edges survive
   * byte-exact. An intra-set dependency edge is preserved because both of its
   * endpoints travel together; `requireNoSplitDeps` refuses any move that would
   * strand a link across the two files.
   */
  async moveManyTo(ids: string[], target: MarkdownStore): Promise<Task[]> {
    const uniqueIds = [...new Set(ids)];
    return withLocks([this.path, target.path], () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;

      // Resolve every source entry up front so a missing id fails before any
      // write and never leaves a half-applied move behind.
      const founds = uniqueIds.map((id) => {
        const found = this.findEntry(doc, id);
        if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
        return found;
      });

      const targetLoaded = target.loadForUpdate();
      const { doc: targetDoc } = targetLoaded;
      target.ensureSections(targetDoc);
      for (const id of uniqueIds) {
        if (target.findEntry(targetDoc, id)) {
          throw new AxiError(
            `Task "${id}" already exists in the destination backlog`,
            "CONFLICT",
          );
        }
      }

      this.requireNoSplitDeps(doc, targetDoc, uniqueIds);

      const moved: Task[] = [];
      for (const found of founds) {
        const task = target.taskFromInput(taskToInput(found.entry.task));
        target.insert(
          target.section(targetDoc, task.state),
          { kind: "task", task, raw: [], dirty: true },
          task.state === "in_flight",
        );
        moved.push(task);
      }

      // Remove the moved entries from the source by identity: splicing by index
      // would shift once two moved items share a section.
      const removeSet = new Set<Entry>(founds.map((f) => f.entry));
      for (const section of doc.sections) {
        section.entries = section.entries.filter((e) => !removeSet.has(e));
      }

      target.assertUnchanged(targetLoaded);
      this.assertUnchanged(loaded);
      target.persist(targetLoaded);
      try {
        this.persist(loaded);
      } catch (error) {
        try {
          for (const id of uniqueIds) target.removeCreatedTask(id);
        } catch (rollbackError) {
          throw this.partialMoveError(
            uniqueIds.join(", "),
            error,
            rollbackError,
          );
        }
        throw error;
      }
      return moved;
    });
  }

  /**
   * Refuse any move that would split a dependency edge across the two files. A
   * moved item may not (a) leave an active dependent behind that is blocked-by
   * it, nor (b) point at a blocker/parent that stays in the source and is
   * absent from the destination. An edge wholly inside the moved set is fine
   * because both endpoints travel together. Generalizes the single-id
   * `requireNoActiveDependents` + destination `requireExistingDeps` guards so a
   * connected set can move as one, while a stray endpoint is still named.
   */
  private requireNoSplitDeps(
    doc: BacklogDoc,
    targetDoc: BacklogDoc,
    ids: string[],
  ): void {
    const movedSet = new Set(ids);

    // (a) An active dependent left in the source would point across files at a
    //     now-absent blocker. This is the single-id "still blocking" guard,
    //     with in-set dependents excluded because they move too.
    for (const id of ids) {
      const stranded = this.allTasks(doc)
        .filter(
          (task) =>
            !movedSet.has(task.id) &&
            task.state !== "done" &&
            task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
        )
        .map((task) => task.id);
      if (stranded.length > 0) {
        throw new AxiError(
          `Task "${id}" is still blocking active tasks: ${stranded.join(", ")}`,
          "VALIDATION_ERROR",
          [
            `Move them together, or unblock them first, e.g. \`tasks-axi unblock ${stranded[0]} --by ${id}\``,
          ],
        );
      }
    }

    // (b) A moved item's blocker must travel with it or already exist in the
    //     destination; otherwise its `blocked-by` edge would dangle across
    //     files. `findEntry` only reads the doc it is handed, so it is safe to
    //     probe the target doc from the source store here.
    for (const id of ids) {
      const found = this.findEntry(doc, id);
      if (!found) continue;
      for (const dep of found.entry.task.deps) {
        if (movedSet.has(dep.id)) continue;
        if (this.findEntry(targetDoc, dep.id)) continue;
        const label = dep.type === "blocked-by" ? "blocker" : "dependency";
        throw new AxiError(
          `Cannot move "${id}": its ${label} "${dep.id}" would be stranded (not in the moved set and absent from the destination)`,
          "VALIDATION_ERROR",
          [
            `Add "${dep.id}" to the same \`mv\`, or move it to the destination first`,
          ],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // State + dependencies
  // -------------------------------------------------------------------------

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      this.ensureSections(doc);
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");

      const task = found.entry.task;
      if (isPublicFollowupTask(task)) {
        throw new AxiError(
          "Public-followup state cannot change through generic transitions",
          "VALIDATION_ERROR",
          [
            "Use `tasks-axi public-followup record-delivery` or `tasks-axi public-followup waive`",
          ],
        );
      }
      const date = normalizeDate(opts.date ?? this.now(), "transition date");

      // Record links / notes before stamping so closureVerb sees them.
      const transitionLinks: TaskLink[] = [];
      if (opts.pr !== undefined) {
        transitionLinks.push({ kind: "pr", url: opts.pr });
      }
      if (opts.report !== undefined) {
        transitionLinks.push({ kind: "report", url: opts.report });
      }
      for (const link of transitionLinks) {
        task.title = appendTitleLink(task.title, link);
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
        task.closed = undefined;
      } else {
        task.closed = undefined;
      }
      task.updated = this.now();

      // Move the entry into the target section.
      found.section.entries.splice(found.index, 1);
      const moved: TaskEntry = { kind: "task", task, raw: [], dirty: true };
      // Done and started work surface at the top; reopened work appends to queued.
      this.insert(this.section(doc, to), moved, to !== "queued");

      this.persist(loaded);
      return task;
    });
  }

  async updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      this.ensureSections(doc);
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      if (!isPublicFollowupTask(task) || !task.public_followup) {
        throw new AxiError(
          `Task "${id}" is not a public-followup obligation`,
          "VALIDATION_ERROR",
        );
      }
      const expected = normalizePublicFollowup(mutation.expectedPublicFollowup);
      if (
        task.public_followup.revision !== mutation.expectedRevision ||
        expected.revision !== mutation.expectedRevision ||
        !canonicalEqual(task.public_followup, expected)
      ) {
        throw new AxiError(
          `Public-followup "${id}" changed; retry the command`,
          "CONFLICT",
          ["Read the latest obligation revision, then retry"],
        );
      }
      if (task.state === "done") {
        throw new AxiError(
          `Public-followup "${id}" is already complete`,
          "CONFLICT",
        );
      }
      if (mutation.requireUnblocked) {
        const byId = new Map(this.allTasks(doc).map((item) => [item.id, item]));
        const blocked = task.deps.some((dep) => {
          if (dep.type !== "blocked-by") return false;
          const blocker = byId.get(dep.id);
          return blocker !== undefined && blocker.state !== "done";
        });
        if (blocked) {
          throw new AxiError(
            "Cannot begin delivery while the obligation has an active blocker",
            "VALIDATION_ERROR",
          );
        }
      }

      const next = normalizePublicFollowup(mutation.publicFollowup);
      assertPublicFollowupMutation(task.public_followup, next);
      if (mutation.complete && !isPublicFollowupTerminal(next)) {
        throw new AxiError(
          "Only a posted receipt or Captain-approved waiver may complete a public-followup",
          "VALIDATION_ERROR",
        );
      }
      if (!mutation.complete && isPublicFollowupTerminal(next)) {
        throw new AxiError(
          "Terminal public-followup data requires an atomic completion mutation",
          "VALIDATION_ERROR",
        );
      }

      task.public_followup = next;
      task.updated = this.now();
      if (mutation.complete) {
        task.state = "done";
        task.closed = normalizeDate(this.now(), "transition date");
        assertPublicFollowupTaskState(task.state, next, id);
        found.section.entries.splice(found.index, 1);
        this.insert(
          this.section(doc, "done"),
          { kind: "task", task, raw: [], dirty: true },
          true,
        );
      } else {
        assertPublicFollowupTaskState(task.state, next, id);
        found.entry.dirty = true;
      }
      this.persist(loaded);
      return task;
    });
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checkedDep = normalizeDep(id, dep);
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      if (
        task.public_followup &&
        !["intent", "pending-work", "ready"].includes(
          task.public_followup.delivery.state,
        )
      ) {
        throw new AxiError(
          "Cannot add blockers after public delivery has started",
          "VALIDATION_ERROR",
        );
      }
      if (
        task.deps.some(
          (d) => d.type === checkedDep.type && d.id === checkedDep.id,
        )
      ) {
        return false;
      }
      this.requireExistingDeps(doc, [checkedDep]);
      task.deps.push(checkedDep);
      found.entry.dirty = true;
      this.persist(loaded);
      return true;
    });
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checkedDep: Dep = { ...dep, id: validateDependencyId(dep.id) };
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      const before = task.deps.length;
      task.deps = task.deps.filter(
        (d) => !(d.type === checkedDep.type && d.id === checkedDep.id),
      );
      if (task.deps.length === before) return false;
      found.entry.dirty = true;
      this.persist(loaded);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async prune(options: PruneOptions): Promise<PruneResult> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      const section = doc.sections.find((s) => s.state === options.state);
      if (!section) return { archived: 0, ids: [] };

      const taskIndices: number[] = [];
      section.entries.forEach((entry, index) => {
        if (entry.kind !== "task") return;
        if (
          isPublicFollowupTask(entry.task) &&
          entry.task.public_followup &&
          !isPublicFollowupTerminal(entry.task.public_followup)
        ) {
          return;
        }
        taskIndices.push(index);
      });

      const keep = Math.max(0, options.keep);
      const surplus = taskIndices.slice(keep);
      if (surplus.length === 0) return { archived: 0, ids: [] };

      const surplusEntries = surplus.map(
        (index) => section.entries[index] as TaskEntry,
      );
      const archivedIds = surplusEntries.map((entry) => entry.task.id);
      const archivedLines = surplusEntries.flatMap((entry) =>
        entry.raw.length > 0 ? entry.raw : renderTaskLines(entry.task),
      );

      // Remove from the bottom up so earlier indices stay valid.
      for (const index of [...surplus].reverse()) {
        section.entries.splice(index, 1);
      }

      let archiveRestorePoint: ArchiveRestorePoint | undefined;
      if (options.archive) {
        this.assertUnchanged(loaded);
        archiveRestorePoint = this.captureArchiveRestorePoint();
        this.appendArchive(archivedLines);
      }
      try {
        this.persist(loaded);
      } catch (error) {
        if (archiveRestorePoint) this.restoreArchive(archiveRestorePoint);
        throw error;
      }
      return { archived: archivedIds.length, ids: archivedIds };
    });
  }

  private captureArchiveRestorePoint(
    path: string = this.archivePath,
  ): ArchiveRestorePoint {
    try {
      return { existed: true, size: statSync(path).size };
    } catch (error) {
      if (errno(error) === "ENOENT") return { existed: false, size: 0 };
      throw error;
    }
  }

  private restoreArchive(
    point: ArchiveRestorePoint,
    path: string = this.archivePath,
  ): void {
    if (!point.existed) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      return;
    }

    try {
      truncateSync(path, point.size);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }

  private appendArchive(lines: string[]): void {
    this.appendArchiveBlock(this.archivePath, lines);
  }

  private appendNoteArchive(lines: string[]): void {
    this.appendArchiveBlock(this.noteArchivePath, lines);
  }

  private appendArchiveBlock(path: string, lines: string[]): void {
    mkdirSync(dirname(path), { recursive: true });
    const stamp = this.now();
    const block = `\n## Archived ${stamp}\n${lines.join("\n")}\n`;
    appendFileSync(path, block, "utf8");
  }

  async render(): Promise<number> {
    return withLock(this.path, () => {
      const loaded = this.loadForUpdate();
      const { doc } = loaded;
      this.ensureSections(doc);
      let count = 0;
      for (const section of doc.sections) {
        for (const entry of section.entries) {
          if (entry.kind === "task") {
            entry.dirty = true;
            count++;
          }
        }
      }
      this.persist(loaded);
      return count;
    });
  }
}
