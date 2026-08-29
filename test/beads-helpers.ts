import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeadsStore } from "../src/backends/beads.js";
import type { TasksContext } from "../src/context.js";

/** True when a working `bd` CLI is on PATH; the beads suite skips without it. */
export const BD_AVAILABLE = (() => {
  try {
    execFileSync("bd", ["version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

export interface TempBeadsBacklog {
  dir: string;
  mirrorPath: string;
  store: BeadsStore;
  ctx: TasksContext;
  mirror(): string;
  archive(): string;
  noteArchive(): string;
  cleanup(): void;
}

/**
 * Create a temp beads workspace (`bd init`) + a real beads-backed context with
 * a fixed clock. Slow (Dolt database creation), so suites share one workspace
 * and keep task ids unique per test.
 */
export function makeBeadsBacklog(now = "2026-07-01"): TempBeadsBacklog {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-"));
  execFileSync("bd", ["init"], {
    cwd: dir,
    env: { ...process.env, BEADS_DIR: join(dir, ".beads") },
    stdio: "ignore",
    timeout: 120_000,
  });
  const mirrorPath = join(dir, "backlog.md");
  const store = new BeadsStore({ dir, mirrorPath, now: () => now });
  const ctx: TasksContext = {
    store,
    config: { backend: "beads", path: mirrorPath, doneKeep: 10 },
  };
  const readSafe = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    dir,
    mirrorPath,
    store,
    ctx,
    mirror: () => readSafe(mirrorPath),
    archive: () => readSafe(join(dir, "done-archive.md")),
    noteArchive: () => readSafe(join(dir, "note-archive.md")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
