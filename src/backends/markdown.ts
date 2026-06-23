import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AxiError } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TransitionOpts,
} from "../model.js";
import type {
  Capabilities,
  PruneOptions,
  PruneResult,
  Store,
} from "../store.js";
import { atomicWrite, readFileSafe, withLock } from "./lock.js";
import {
  type BacklogDoc,
  type Section,
  type TaskEntry,
  deriveLinks,
  parseBacklog,
  renderBacklog,
  renderTaskLines,
} from "./markdown-grammar.js";

export interface MarkdownStoreOptions {
  path: string;
  /** Where pruned Done items are archived (default `<dir>/done-archive.md`). */
  archivePath?: string;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
}

const ORDER: State[] = ["in_flight", "queued", "done"];
const HEADERS: Record<State, string> = {
  in_flight: "## In flight",
  queued: "## Queued",
  done: "## Done",
};

function today(): string {
  // Local date (firstmate's dates are local, e.g. "2026-06-22"), not UTC.
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function normalizeTitle(title: string): string {
  if (/[\r\n]/.test(title)) {
    throw new AxiError("Task title must be a single line", "VALIDATION_ERROR");
  }
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new AxiError("Task title must not be empty", "VALIDATION_ERROR");
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

function appendTitleText(title: string, text: string): string {
  const url = normalizeLinkUrl(text);
  if (deriveLinks(title).some((link) => link.url === url)) return title;
  return normalizeTitle(`${title} ${url}`);
}

export class MarkdownStore implements Store {
  private readonly path: string;
  private readonly archivePath: string;
  private readonly now: () => string;

  constructor(options: MarkdownStoreOptions) {
    this.path = options.path;
    this.archivePath =
      options.archivePath ?? `${dirname(options.path)}/done-archive.md`;
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
    };
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  private load(): BacklogDoc {
    return parseBacklog(readFileSafe(this.path) ?? "");
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

  async get(id: string): Promise<Task | null> {
    const found = this.findEntry(this.load(), id);
    return found ? found.entry.task : null;
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

  private persist(doc: BacklogDoc): void {
    atomicWrite(this.path, renderBacklog(doc));
  }

  private taskFromInput(input: TaskInput): Task {
    const state: State = input.state ?? "queued";
    let title = normalizeTitle(input.title);
    const kind = normalizeTagValue(input.kind, "kind");
    const repo = normalizeTagValue(input.repo, "repo");
    // Links live in the prose; fold any provided links into the title text.
    for (const link of input.links ?? []) {
      title = appendTitleText(title, link.url);
    }
    const task: Task = {
      id: validateId(input.id),
      title,
      state,
      links: deriveLinks(title),
      deps: input.deps
        ? input.deps.map((dep) => ({
            ...dep,
            id: validateDependencyId(dep.id),
          }))
        : [],
    };
    if (kind) task.kind = kind;
    if (repo) task.repo = repo;
    if (input.body) task.body = input.body;
    const priority = normalizePriority(input.priority);
    if (priority !== undefined) task.priority = priority;
    if (input.meta) task.meta = input.meta;
    if (input.created !== undefined) {
      if (input.created) task.created = input.created;
    } else if (state !== "done") task.created = this.now();
    if (input.closed) task.closed = input.closed;
    return task;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    return withLock(this.path, () => {
      const doc = this.load();
      this.ensureSections(doc);
      if (this.findEntry(doc, input.id)) {
        throw new AxiError(
          `Task "${input.id}" already exists`,
          "CONFLICT",
        );
      }
      const task = this.taskFromInput(input);
      const entry: TaskEntry = { kind: "task", task, raw: [], dirty: true };
      // New in_flight work goes to the top; queued work appends to the bottom.
      this.insert(this.section(doc, task.state), entry, task.state === "in_flight");
      this.persist(doc);
      return task;
    });
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    return withLock(this.path, () => {
      const doc = this.load();
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;

      if (patch.title !== undefined) task.title = normalizeTitle(patch.title);
      if (patch.body !== undefined) task.body = patch.body || undefined;
      if (patch.appendBody !== undefined && patch.appendBody !== "") {
        task.body = task.body
          ? `${task.body}\n${patch.appendBody}`
          : patch.appendBody;
      }
      if (patch.repo !== undefined) {
        task.repo = normalizeTagValue(patch.repo, "repo");
      }
      if (patch.kind !== undefined) {
        task.kind = normalizeTagValue(patch.kind, "kind");
      }
      const priority = normalizePriority(patch.priority);
      if (priority !== undefined) task.priority = priority;
      if (patch.meta) task.meta = { ...task.meta, ...patch.meta };
      for (const link of patch.addLinks ?? []) {
        task.title = appendTitleText(task.title, link.url);
      }
      task.links = deriveLinks(task.title);
      task.updated = this.now();

      found.entry.dirty = true;
      this.persist(doc);
      return task;
    });
  }

  async remove(id: string): Promise<Task> {
    return withLock(this.path, () => {
      const doc = this.load();
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      found.section.entries.splice(found.index, 1);
      this.persist(doc);
      return task;
    });
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
      const doc = this.load();
      this.ensureSections(doc);
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");

      const task = found.entry.task;
      const date = opts.date ?? this.now();

      // Record links / notes before stamping so closureVerb sees them.
      for (const url of [opts.pr, opts.report]) {
        if (url !== undefined) task.title = appendTitleText(task.title, url);
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

      this.persist(doc);
      return task;
    });
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checkedDep: Dep = { ...dep, id: validateDependencyId(dep.id) };
    return withLock(this.path, () => {
      const doc = this.load();
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      if (
        task.deps.some(
          (d) => d.type === checkedDep.type && d.id === checkedDep.id,
        )
      ) {
        return false;
      }
      task.deps.push(checkedDep);
      found.entry.dirty = true;
      this.persist(doc);
      return true;
    });
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checkedDep: Dep = { ...dep, id: validateDependencyId(dep.id) };
    return withLock(this.path, () => {
      const doc = this.load();
      const found = this.findEntry(doc, id);
      if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      const task = found.entry.task;
      const before = task.deps.length;
      task.deps = task.deps.filter(
        (d) => !(d.type === checkedDep.type && d.id === checkedDep.id),
      );
      if (task.deps.length === before) return false;
      found.entry.dirty = true;
      this.persist(doc);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async prune(options: PruneOptions): Promise<PruneResult> {
    return withLock(this.path, () => {
      const doc = this.load();
      const section = doc.sections.find((s) => s.state === options.state);
      if (!section) return { archived: 0, ids: [] };

      const taskIndices: number[] = [];
      section.entries.forEach((entry, index) => {
        if (entry.kind === "task") taskIndices.push(index);
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

      if (options.archive) {
        this.appendArchive(archivedLines);
      }
      this.persist(doc);
      return { archived: archivedIds.length, ids: archivedIds };
    });
  }

  private appendArchive(lines: string[]): void {
    mkdirSync(dirname(this.archivePath), { recursive: true });
    const stamp = this.now();
    const block = `\n## Archived ${stamp}\n${lines.join("\n")}\n`;
    appendFileSync(this.archivePath, block, "utf8");
  }

  async render(): Promise<number> {
    return withLock(this.path, () => {
      const doc = this.load();
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
      this.persist(doc);
      return count;
    });
  }
}
