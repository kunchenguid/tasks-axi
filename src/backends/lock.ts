import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError } from "../errors.js";

/**
 * Advisory lockfile + atomic write for the read-modify-write window (decision
 * D1, report §8a concurrency). A hand-edit and a CLI-edit can race, so every
 * mutation: takes an advisory lock, re-reads fresh from disk, mutates, writes
 * atomically (temp file + rename), and releases the lock. Reads do not lock —
 * the atomic rename guarantees a reader sees either the whole old or the whole
 * new file, never a torn write.
 */

const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 25;
let lockTokenCounter = 0;

export interface LockHandle {
  release(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockToken(): string {
  lockTokenCounter += 1;
  return `${process.pid}:${Date.now()}:${performance.now()}:${lockTokenCounter}\n`;
}

function errno(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "UNKNOWN";
}

function unlinkIfTokenMatches(lockPath: string, token: string): boolean {
  try {
    if (readFileSync(lockPath, "utf8") !== token) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Read a file's UTF-8 contents, or undefined when it does not exist. */
export function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Write `content` atomically: temp file in the same dir, then rename over. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.floor(
    performance.now() * 1000,
  )}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

async function acquireLock(targetPath: string): Promise<LockHandle> {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      const token = lockToken();
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => void unlinkIfTokenMatches(lockPath, token),
      };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;

      // Steal a stale lock (a crashed process that never released it).
      try {
        const observed = readFileSync(lockPath, "utf8");
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          if (unlinkIfTokenMatches(lockPath, observed)) continue;
        }
      } catch {
        // lock vanished between EEXIST and stat — retry immediately
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  throw new AxiError(
    "backlog is locked by another tasks-axi process",
    "LOCKED",
    ["Wait a moment and retry; a stale lock is reclaimed automatically"],
  );
}

/** Run `fn` while holding the advisory lock for `path`, releasing it after. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const handle = await acquireLock(path);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

export async function withLocks<T>(
  paths: string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const byResolved = new Map<string, string>();
  for (const path of paths) byResolved.set(resolve(path), path);
  const ordered = [...byResolved.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, path]) => path);
  const handles: LockHandle[] = [];
  try {
    for (const path of ordered) handles.push(await acquireLock(path));
    return await fn();
  } finally {
    for (const handle of handles.reverse()) handle.release();
  }
}

/** True when a lockfile currently exists for `path`. */
export function isLocked(path: string): boolean {
  return existsSync(`${path}.lock`);
}
