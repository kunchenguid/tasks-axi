/**
 * Beads Store adapter.
 *
 * IDs are preserved 1:1: every create passes the caller's slug as `bd
 * create --id`. Beads itself rejects explicit IDs outside its configured
 * prefix, so this adapter validates that constraint before invoking bd; no
 * slug->id index is needed. Backend-only fields are kept
 * in a versioned base64url header in the Beads description. Holds map to the
 * `tasks-axi-held` label, with `hold.until` mirrored to native `--defer`;
 * `--defer ""` is the bd-supported clear operation. Dependency reasons have
 * no native bd field, so they are keyed by edge in the same reserved header.
 */

import { execFile as execFileCallback } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { deriveLinks } from "../links.js";
import { AxiError, unsupported } from "../errors.js";
import type {
  Dep,
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
import type { Capabilities, Store } from "../store.js";

const execFile = promisify(execFileCallback);
const META_PREFIX = "<!-- tasks-axi:beads/v1:";
const META_SUFFIX = " -->";
const HELD_LABEL = "tasks-axi-held";

export type BeadsRunner = (
  binary: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export interface BeadsStoreOptions {
  /** Path to the `.beads` directory; its parent is passed as `bd` cwd. */
  path: string;
  binary?: string;
  prefix?: string;
  /** Test seam; production always shells out to the configured binary. */
  run?: BeadsRunner;
}

interface BeadsMeta {
  kind?: string;
  repo?: string;
  hold?: Hold;
  meta?: Record<string, unknown>;
  depReasons?: Record<string, string>;
}

type Bead = Record<string, unknown>;

function record(value: unknown): Bead {
  return value && typeof value === "object" ? (value as Bead) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function date(value: unknown): string | undefined {
  return text(value)?.slice(0, 10);
}

function jsonItems(value: unknown): Bead[] {
  if (Array.isArray(value)) return value.map(record);
  const object = record(value);
  const items = object.issues ?? object.items ?? object.dependencies;
  return Array.isArray(items) ? items.map(record) : [];
}

function decodeDescription(value: unknown): {
  body?: string;
  meta: BeadsMeta;
} {
  const description = text(value) ?? "";
  const first = description.split("\n", 1)[0];
  if (!first.startsWith(META_PREFIX) || !first.endsWith(META_SUFFIX)) {
    return { ...(description ? { body: description } : {}), meta: {} };
  }
  try {
    const encoded = first.slice(META_PREFIX.length, -META_SUFFIX.length);
    const meta = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const body = description.slice(first.length).replace(/^\n/, "");
    return {
      ...(body ? { body } : {}),
      meta: record(meta) as BeadsMeta,
    };
  } catch {
    return { ...(description ? { body: description } : {}), meta: {} };
  }
}

function encodeDescription(body: string | undefined, meta: BeadsMeta): string {
  const hasMeta = Object.values(meta).some((value) => value !== undefined);
  if (!hasMeta) return body ?? "";
  const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
  return `${META_PREFIX}${encoded}${META_SUFFIX}${body ? `\n${body}` : ""}`;
}

function appendLinks(title: string, links: TaskInput["links"]): string {
  let result = title.trim();
  for (const link of links ?? []) {
    if (!result.includes(link.url)) result += ` ${link.url}`;
  }
  return result;
}

function stateOf(status: unknown): State {
  if (status === "in_progress") return "in_flight";
  if (status === "closed") return "done";
  return "queued";
}

function depType(value: unknown): Dep["type"] | undefined {
  if (value === "blocks") return "blocked-by";
  if (value === "parent-child") return "parent";
  if (value === "discovered-from") return "discovered-from";
  return undefined;
}

function depOwner(item: Bead): string | undefined {
  return text(item.issue_id ?? item.from_id ?? item.dependent_id);
}

function depTarget(item: Bead): string | undefined {
  return text(item.depends_on_id ?? item.to_id ?? item.blocker_id);
}

function depKey(dep: Dep): string {
  return `${dep.type}:${dep.id}`;
}

function taskFromBead(bead: Bead, deps: Dep[]): Task {
  const decoded = decodeDescription(bead.description);
  const metadata = decoded.meta;
  const issueType = text(bead.issue_type);
  const kind = metadata.kind ?? (issueType && issueType !== "task" ? issueType : undefined);
  const labels = Array.isArray(bead.labels) ? bead.labels.map(String) : [];
  const hold = metadata.hold ?? (labels.includes(HELD_LABEL) ? { reason: "held in beads" } : undefined);
  const title = text(bead.title) ?? String(bead.id ?? "");
  const task: Task = {
    id: text(bead.id) ?? "",
    title,
    state: stateOf(bead.status),
    links: deriveLinks(title),
    deps: deps.map((dep) => {
      const reason = text(metadata.depReasons?.[depKey(dep)]);
      return reason ? { ...dep, reason } : dep;
    }),
  };
  if (kind) task.kind = kind;
  if (metadata.repo) task.repo = metadata.repo;
  const notes = text(bead.notes);
  const body = decoded.body ?? notes;
  if (body) task.body = body;
  if (hold) task.hold = hold;
  if (typeof bead.priority === "number") task.priority = bead.priority;
  if (date(bead.created_at)) task.created = date(bead.created_at);
  if (date(bead.updated_at)) task.updated = date(bead.updated_at);
  if (date(bead.closed_at)) task.closed = date(bead.closed_at);
  if (metadata.meta) task.meta = metadata.meta;
  return task;
}

function dependencyArgs(dep: Dep): { type: string } {
  if (dep.type === "blocked-by") return { type: "blocks" };
  if (dep.type === "parent") return { type: "parent-child" };
  return { type: "discovered-from" };
}

function sameHold(left: Hold | undefined, right: Hold | undefined): boolean {
  return (
    left?.reason === right?.reason &&
    left?.kind === right?.kind &&
    left?.until === right?.until
  );
}

export class BeadsStore implements Store {
  private readonly binary: string;
  private readonly cwd: string;
  private readonly prefix: string;
  private readonly run: BeadsRunner;

  constructor(options: BeadsStoreOptions) {
    this.binary = options.binary ?? "bd";
    const beadsPath = resolve(options.path);
    this.cwd = basename(beadsPath) === ".beads" ? dirname(beadsPath) : beadsPath;
    this.prefix = options.prefix ?? "bd";
    this.run = options.run ?? (async (binary, args, cwd) => execFile(binary, args, { cwd }));
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: true,
      realtimeSync: false,
      customStates: true,
      serverMintsIds: true,
      publicFollowups: false,
    };
  }

  private async call(
    verb: string,
    args: string[],
    notFoundOk = false,
  ): Promise<unknown> {
    try {
      const result = await this.run(this.binary, args, this.cwd);
      try {
        return JSON.parse(result.stdout || "null");
      } catch {
        throw new AxiError(`beads ${verb} returned invalid JSON`, "UNKNOWN");
      }
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (
        notFoundOk &&
        error &&
        typeof error === "object" &&
        /not found|no issues? found|does not exist/i.test(
          `${String((error as { stderr?: string }).stderr ?? "")} ${String((error as { stdout?: string }).stdout ?? "")}`,
        )
      ) {
        return null;
      }
      throw new AxiError(`beads ${verb} failed`, "UNKNOWN", [
        `Check the beads CLI and workspace, then retry`,
      ]);
    }
  }

  private async depsFor(ids: string[]): Promise<Map<string, Dep[]>> {
    const result = new Map<string, Dep[]>(ids.map((id) => [id, []]));
    await Promise.all(ids.map(async (id) => {
      const items = jsonItems(
        await this.call("dep list", ["dep", "list", id, "--json"]),
      );
      for (const item of items) {
        const owner = depOwner(item) ?? id;
        const target = depTarget(item) ?? text(item.id);
        const type = depType(item.type ?? item.dependency_type);
        if (owner !== id || !target || !type) continue;
        result.get(id)?.push({ type, id: target });
      }
    }));
    return result;
  }

  private async bead(id: string): Promise<{ bead: Bead; task: Task } | null> {
    const raw = await this.call("show", ["show", id, "--json"], true);
    if (raw === null) return null;
    const items = jsonItems(raw);
    const bead = items[0];
    if (!bead || !text(bead.id)) return null;
    const deps = await this.depsFor([id]);
    return { bead, task: taskFromBead(bead, deps.get(id) ?? []) };
  }

  private async setDepReason(id: string, dep: Dep, reason: string | undefined): Promise<void> {
    const found = await this.bead(id);
    if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const decoded = decodeDescription(found.bead.description);
    const depReasons = { ...decoded.meta.depReasons };
    const key = depKey(dep);
    if (reason) depReasons[key] = reason;
    else delete depReasons[key];
    const metadata = {
      ...decoded.meta,
      ...(Object.keys(depReasons).length > 0 ? { depReasons } : {}),
    };
    if (Object.keys(depReasons).length === 0) delete metadata.depReasons;
    await this.call("update", [
      "update",
      id,
      "--description",
      encodeDescription(decoded.body, metadata),
      "--json",
    ]);
  }

  async get(id: string): Promise<Task | null> {
    const found = await this.bead(id);
    return found?.task ?? null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const beads = jsonItems(
      await this.call("list", ["list", "--all", "--no-pager", "-n", "0", "--json"]),
    );
    const deps = await this.depsFor(
      beads.map((bead) => text(bead.id)).filter((id): id is string => id !== undefined),
    );
    let items = beads.map((bead) => {
      const id = text(bead.id) ?? "";
      return taskFromBead(bead, deps.get(id) ?? []);
    });
    if (query.state) items = items.filter((task) => task.state === query.state);
    if (query.repo) items = items.filter((task) => task.repo === query.repo);
    if (query.kind) items = items.filter((task) => task.kind === query.kind);
    const total = items.length;
    return {
      items:
        query.limit === undefined || query.limit < 0
          ? items
          : items.slice(0, query.limit),
      total,
    };
  }

  async create(input: TaskInput): Promise<Task> {
    if (!input.id.startsWith(`${this.prefix}-`)) {
      throw new AxiError(
        `Task id "${input.id}" must use the configured beads prefix "${this.prefix}-"`,
        "VALIDATION_ERROR",
      );
    }
    const title = appendLinks(input.title, input.links);
    const meta: BeadsMeta = {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.hold ? { hold: input.hold } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.deps?.some((dep) => dep.reason)
        ? {
            depReasons: Object.fromEntries(
              input.deps.filter((dep) => dep.reason).map((dep) => [depKey(dep), dep.reason as string]),
            ),
          }
        : {}),
    };
    const args = ["create", title, "--id", input.id, "--type", "task"];
    if (input.body || Object.keys(meta).length > 0) {
      args.push("--description", encodeDescription(input.body, meta));
    }
    if (input.priority !== undefined) args.push("--priority", String(input.priority));
    if (input.hold) {
      args.push("--labels", HELD_LABEL);
      if (input.hold.until) args.push("--defer", input.hold.until);
    }
    args.push("--json");
    await this.call("create", args);
    if (input.state === "in_flight") await this.call("update", ["update", input.id, "--status", "in_progress", "--json"]);
    if (input.state === "done") await this.call("close", ["close", input.id, "--json"]);
    for (const dep of input.deps ?? []) await this.addDep(input.id, dep);
    const found = await this.bead(input.id);
    if (!found) throw new AxiError(`beads create did not return "${input.id}"`, "UNKNOWN");
    const expectedState = input.state ?? "queued";
    if (found.task.state !== expectedState) {
      throw new AxiError(`beads create did not persist state "${expectedState}"`, "UNKNOWN");
    }
    if (input.hold) {
      const labels = Array.isArray(found.bead.labels) ? found.bead.labels.map(String) : [];
      if (!labels.includes(HELD_LABEL) || (input.hold.until && date(found.bead.defer_until) !== input.hold.until)) {
        throw new AxiError(`beads create did not persist hold for "${input.id}"`, "UNKNOWN");
      }
    }
    return found.task;
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    const found = await this.bead(id);
    const current = found?.task;
    if (!current || !found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const next: Task = {
      ...current,
      links: current.links.map((link) => ({ ...link })),
      deps: current.deps.map((dep) => ({ ...dep })),
      ...(current.meta ? { meta: { ...current.meta } } : {}),
    };
    const changed: TaskUpdateChange[] = [];
    const mark = (field: TaskUpdateChange) => {
      if (!changed.includes(field)) changed.push(field);
    };
    if (patch.title !== undefined && patch.title !== current.title) {
      next.title = patch.title;
      mark("title");
    }
    if (patch.body !== undefined && patch.body !== current.body) {
      next.body = patch.body || undefined;
      mark("body");
      if (patch.archiveBody) mark("archive");
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line && !(next.body?.split("\n").includes(line) ?? false)) {
        next.body = next.body ? `${next.body}\n${line}` : line;
        mark("body");
      }
    }
    if (patch.repo !== undefined && patch.repo !== current.repo) {
      next.repo = patch.repo || undefined;
      mark("repo");
    }
    if (patch.kind !== undefined && patch.kind !== current.kind) {
      next.kind = patch.kind || undefined;
      mark("kind");
    }
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      next.priority = patch.priority;
      mark("priority");
    }
    if (patch.hold !== undefined) {
      const requestedHold = patch.hold ?? undefined;
      const labels = Array.isArray(found.bead.labels) ? found.bead.labels.map(String) : [];
      if (
        !sameHold(requestedHold, current.hold) ||
        labels.includes(HELD_LABEL) !== Boolean(requestedHold) ||
        date(found.bead.defer_until) !== requestedHold?.until
      ) {
        next.hold = requestedHold;
        mark("hold");
      }
    }
    if (patch.meta) {
      next.meta = { ...current.meta, ...patch.meta };
      if (JSON.stringify(next.meta) !== JSON.stringify(current.meta)) mark("meta");
    }
    for (const link of patch.addLinks ?? []) {
      if (!next.title.includes(link.url)) {
        next.title += ` ${link.url}`;
        mark("links");
      }
    }
    if (changed.length === 0) return { task: current, changed };

    const metadata: BeadsMeta = {
      ...(next.kind ? { kind: next.kind } : {}),
      ...(next.repo ? { repo: next.repo } : {}),
      ...(next.hold ? { hold: next.hold } : {}),
      ...(next.meta ? { meta: next.meta } : {}),
      ...(decodeDescription(found.bead.description).meta.depReasons
        ? { depReasons: decodeDescription(found.bead.description).meta.depReasons }
        : {}),
    };
    const args = ["update", id];
    if (changed.includes("title") || changed.includes("links")) args.push("--title", next.title);
    if (changed.some((field) => ["body", "repo", "kind", "hold", "meta"].includes(field))) {
      args.push("--description", encodeDescription(next.body, metadata));
    }
    if (changed.includes("priority")) args.push("--priority", String(next.priority));
    if (changed.includes("hold")) {
      args.push(next.hold ? "--add-label" : "--remove-label", HELD_LABEL);
      if (next.hold?.until) args.push("--defer", next.hold.until);
      else if (date(found.bead.defer_until)) args.push("--defer", "");
    }
    args.push("--json");
    await this.call("update", args);
    if (patch.archiveBody && patch.body !== undefined && current.body) {
      await this.call("comments add", ["comments", "add", id, current.body, "--json"]);
    }
    const updated = await this.bead(id);
    if (!updated) throw new AxiError(`beads update removed "${id}"`, "UNKNOWN");
    if (changed.includes("hold")) {
      const labels = Array.isArray(updated.bead.labels) ? updated.bead.labels.map(String) : [];
      if (
        !sameHold(updated.task.hold, next.hold) ||
        labels.includes(HELD_LABEL) !== Boolean(next.hold) ||
        date(updated.bead.defer_until) !== next.hold?.until
      ) {
        throw new AxiError(`beads update did not persist hold for "${id}"`, "UNKNOWN");
      }
    }
    return { task: updated.task, changed };
  }

  async remove(id: string): Promise<Task> {
    const current = await this.get(id);
    if (!current) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const dependents = jsonItems(await this.call("dep list", ["dep", "list", id, "--direction", "up", "--json"]));
    for (const item of dependents) {
      const dependent = await this.get(depOwner(item) ?? "");
      if (dependent && dependent.state !== "done") {
        throw new AxiError(`Task "${id}" is still blocking active tasks`, "VALIDATION_ERROR");
      }
    }
    await this.call("delete", ["delete", id, "--force", "--json"]);
    return current;
  }

  async transition(id: string, to: State, opts: TransitionOpts = {}): Promise<Task> {
    const current = await this.get(id);
    if (!current) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    if (to === "done" && (opts.pr || opts.report)) {
      const links = [
        ...(opts.pr ? [{ kind: "pr" as const, url: opts.pr }] : []),
        ...(opts.report ? [{ kind: "report" as const, url: opts.report }] : []),
      ];
      await this.update(id, { addLinks: links });
    }
    if (opts.note) await this.update(id, { addBodyLines: [opts.note] });
    if (to === "done") {
      await this.call("close", ["close", id, ...(opts.pr ? ["--reason", opts.pr] : []), "--json"]);
    } else {
      await this.call("update", ["update", id, "--status", to === "in_flight" ? "in_progress" : "open", "--json"]);
    }
    const task = await this.get(id);
    if (!task) throw new AxiError(`beads transition removed "${id}"`, "UNKNOWN");
    if (task.state !== to) {
      throw new AxiError(`beads transition did not persist state "${to}"`, "UNKNOWN");
    }
    return task;
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const current = await this.get(id);
    if (!current) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    if (id === dep.id) {
      throw new AxiError(`Task "${id}" cannot depend on itself`, "VALIDATION_ERROR");
    }
    if (!(await this.get(dep.id))) {
      throw new AxiError(`Task "${dep.id}" not found`, "NOT_FOUND");
    }
    const existing = current.deps.find((item) => item.type === dep.type && item.id === dep.id);
    if (existing) {
      if (existing.reason !== dep.reason) await this.setDepReason(id, dep, dep.reason);
      const repaired = await this.get(id);
      if (!repaired?.deps.some((item) => item.type === dep.type && item.id === dep.id && item.reason === dep.reason)) {
        throw new AxiError(`beads dep add did not persist edge to "${dep.id}"`, "UNKNOWN");
      }
      return false;
    }
    await this.call("dep add", ["dep", "add", id, dep.id, "--type", dependencyArgs(dep).type, "--json"]);
    await this.setDepReason(id, dep, dep.reason);
    const updated = await this.get(id);
    if (!updated?.deps.some((item) => item.type === dep.type && item.id === dep.id && item.reason === dep.reason)) {
      throw new AxiError(`beads dep add did not persist edge to "${dep.id}"`, "UNKNOWN");
    }
    return true;
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const current = await this.get(id);
    if (!current) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    if (!current.deps.some((item) => item.type === dep.type && item.id === dep.id)) return false;
    await this.call("dep remove", ["dep", "remove", id, dep.id, "--json"]);
    await this.setDepReason(id, dep, undefined);
    const updated = await this.get(id);
    if (!updated || updated.deps.some((item) => item.type === dep.type && item.id === dep.id)) {
      throw new AxiError(`beads dep remove did not remove edge to "${dep.id}"`, "UNKNOWN");
    }
    return true;
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public followups", "beads");
  }
}
