import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore } from "../src/backends/markdown.js";
import type { TasksContext } from "../src/context.js";
import type { Capabilities, Store } from "../src/store.js";

export const FIXTURE = readFileSync(
  new URL("./fixtures/backlog.md", import.meta.url),
  "utf8",
);

/**
 * A backlog whose lines mirror firstmate's real `data/backlog.md` shape: a
 * `- [ ]` checkbox in-flight item, a `- [ ]` queued item carrying a
 * `blocked-by: <id> - <reason>` edge, and a `- [x]` done item.
 */
export const FIRSTMATE_FIXTURE = readFileSync(
  new URL("./fixtures/firstmate-backlog.md", import.meta.url),
  "utf8",
);

export const MULTI_REASON_FIXTURE = [
  "# Backlog",
  "",
  "## In flight",
  "- [ ] blocker-b - second blocker",
  "",
  "## Queued",
  "- [ ] target-q1 - work (repo: app) blocked-by: blocker-a - first blocker done blocked-by: blocker-b - waits on second blocker",
  "",
  "## Done",
  "- [x] blocker-a - first blocker done",
  "",
].join("\n");

export interface TempBacklog {
  dir: string;
  path: string;
  store: MarkdownStore;
  ctx: TasksContext;
  read(): string;
  archive(): string;
  noteArchive(): string;
  cleanup(): void;
}

/** Create a temp backlog file + a real markdown-backed context with a fixed clock. */
export function makeBacklog(
  content = FIXTURE,
  now = "2026-07-01",
): TempBacklog {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-"));
  const path = join(dir, "backlog.md");
  writeFileSync(path, content, "utf8");
  const store = new MarkdownStore({ path, now: () => now });
  const ctx: TasksContext = {
    store,
    config: { backend: "markdown", path, doneKeep: 10 },
  };
  return {
    dir,
    path,
    store,
    ctx,
    read: () => readFileSync(path, "utf8"),
    archive: () => {
      try {
        return readFileSync(join(dir, "done-archive.md"), "utf8");
      } catch {
        return "";
      }
    },
    noteArchive: () => {
      try {
        return readFileSync(join(dir, "note-archive.md"), "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface FakeBackendBacklog extends Omit<TempBacklog, "store"> {
  store: Store;
}

/**
 * A non-markdown backend for seam tests: a real MarkdownStore wrapped behind
 * the plain Store interface (so it fails `instanceof MarkdownStore`),
 * reporting backend "fake" with the given capability overrides.
 */
export function makeFakeBackendBacklog(
  overrides: Partial<Capabilities> = {},
  content = FIXTURE,
): FakeBackendBacklog {
  const b = makeBacklog(content);
  const inner = b.store;
  const store: Store = {
    capabilities: () => ({
      ...inner.capabilities(),
      backend: "fake",
      ...overrides,
    }),
    create: (input) => inner.create(input),
    get: (id) => inner.get(id),
    update: (id, patch) => inner.update(id, patch),
    remove: (id) => inner.remove(id),
    list: (query) => inner.list(query),
    transition: (id, to, opts) => inner.transition(id, to, opts),
    addDep: (id, dep) => inner.addDep(id, dep),
    removeDep: (id, dep) => inner.removeDep(id, dep),
    updatePublicFollowup: (id, mutation) =>
      inner.updatePublicFollowup(id, mutation),
  };
  return { ...b, store, ctx: { store, config: b.ctx.config } };
}
