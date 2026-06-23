import {
  closeSync,
  existsSync,
  linkSync,
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
 * Advisory lockfile for reducing lost updates in the low-contention
 * single-supervisor model. Corruption-safety is guaranteed independently by
 * atomic temp-file + rename writes: readers see either the whole old file or
 * the whole new file, never a torn write.
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
  return `${process.pid}:${randomNonce()}:${Date.now()}:${lockTokenCounter}\n`;
}

function errno(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "UNKNOWN";
}

function randomNonce(): string {
  return `${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

function uniqueLockSidecar(lockPath: string, purpose: string): string {
  return `${lockPath}.${purpose}-${process.pid}-${Date.now()}-${randomNonce()}`;
}

function unlinkSafe(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function restoreMovedLock(lockPath: string, movedPath: string): void {
  try {
    linkSync(movedPath, lockPath);
  } catch (error) {
    if (errno(error) !== "EEXIST" && errno(error) !== "ENOENT") throw error;
  } finally {
    unlinkSafe(movedPath);
  }
}

function readStableLock(lockPath: string):
  | {
      token: string;
      mtimeMs: number;
    }
  | undefined {
  const token = readFileSync(lockPath, "utf8");
  const stat = statSync(lockPath);
  const tokenAfterStat = readFileSync(lockPath, "utf8");
  if (tokenAfterStat !== token) return undefined;
  return { token, mtimeMs: stat.mtimeMs };
}

function moveLockAside(lockPath: string, purpose: string): string | undefined {
  const sidecarPath = uniqueLockSidecar(lockPath, purpose);
  try {
    renameSync(lockPath, sidecarPath);
    return sidecarPath;
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

function removeMovedLockIfTokenMatches(
  lockPath: string,
  movedPath: string,
  expectedToken: string,
): boolean {
  const movedToken = readFileSync(movedPath, "utf8");
  if (movedToken !== expectedToken) {
    restoreMovedLock(lockPath, movedPath);
    return false;
  }
  unlinkSafe(movedPath);
  return true;
}

function stealStaleLock(lockPath: string, staleToken: string): boolean {
  const movedPath = moveLockAside(lockPath, "stale");
  if (!movedPath) return false;
  return removeMovedLockIfTokenMatches(lockPath, movedPath, staleToken);
}

function releaseLock(lockPath: string, token: string): void {
  let observed: string;
  try {
    observed = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (observed !== token) return;

  const movedPath = moveLockAside(lockPath, "release");
  if (!movedPath) return;
  removeMovedLockIfTokenMatches(lockPath, movedPath, token);
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
        release: () => releaseLock(lockPath, token),
      };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;

      // Steal a stale lock (a crashed process that never released it).
      try {
        const observed = readStableLock(lockPath);
        if (
          observed &&
          Date.now() - observed.mtimeMs > LOCK_STALE_MS &&
          stealStaleLock(lockPath, observed.token)
        ) {
          continue;
        }
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        // Lock vanished between EEXIST and stat - retry immediately.
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
