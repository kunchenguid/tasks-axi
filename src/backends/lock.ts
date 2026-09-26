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
 * Advisory lockfile for reducing lost updates in the low-contention
 * single-supervisor model. Corruption-safety is guaranteed independently by
 * atomic temp-file + rename writes: readers see either the whole old file or
 * the whole new file, never a torn write.
 *
 * A lock left behind by a killed process is reclaimed automatically once its
 * recorded pid is gone and the file is past the stale window; reclaimers
 * serialize on a second lockfile (`<path>.lock.reclaim`) and re-read the token
 * after the holder check, so the file removed is always the one proved
 * abandoned. Every other contended lock still fails closed with `LOCKED`.
 */

const LOCK_STALE_MS = 30_000;
/** Suffix of the mutex that serializes reclaimers of one lockfile. */
const RECLAIM_SUFFIX = ".reclaim";
const LOCK_TIMEOUT_MS = 2_500;
const LOCK_RETRY_MS = 25;
let lockTokenCounter = 0;

export interface LockHandle {
  release(): void;
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
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

/**
 * The pid of a token this tool wrote, or undefined for anything else. Only the
 * exact shape `lockToken` renders counts — pid, nonce, millis, counter — so a
 * hand-written or truncated file (`crashed-holder`, `4711`, `4711:nonce`) is
 * never mistaken for a token whose holder can be checked, and a pid outside the
 * safe integer range is refused instead of being rounded into another process.
 */
function lockHolderPid(token: string): number | undefined {
  const fields = /^([1-9][0-9]*):([^:\n]*):([0-9]+):([0-9]+)\n?$/.exec(token);
  if (!fields) return undefined;
  const pid = Number(fields[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return pid;
}

/**
 * Liveness of a recorded holder, biased to "alive". Only ESRCH ("no such
 * process") proves the holder is gone: EPERM means the pid exists but belongs to
 * another user, and any other errno is an answer this code cannot interpret, so
 * both keep the lock. Guessing "dead" from an unknown error would remove a live
 * holder's lock.
 */
function holderIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

/**
 * Reclaim a lock abandoned by a dead holder, serialized against every other
 * reclaimer by a second O_EXCL lockfile (`<path>.lock.reclaim`). Returns true
 * when the caller should retry acquiring.
 *
 * Two things make the removal safe, and both are needed:
 *
 * 1. the mutex excludes competing *reclaimers*, so no second recovery can
 *    unlink this file between the checks below and the unlink;
 * 2. the token is read again after the holder check, because the mutex says
 *    nothing about a *normal* writer. The holder check is not instantaneous —
 *    being synchronous only rules out another task of this process, not the OS
 *    descheduling this one — and a holder that was still alive when its token
 *    was first read can release in that window, letting any writer take the
 *    lock with a plain `openSync(..., "wx")`. A changed token aborts recovery.
 *
 * With both, the window between the second token read and the unlink is empty:
 * the file holds the token of a pid that answered ESRCH before that read, so its
 * holder is already gone and can neither release nor be impersonated (only it
 * ever had that token). Acquiring requires the file to be absent first, and the
 * only remaining remover — another reclaimer — is excluded by the mutex. So the
 * file unlinked below is necessarily the one this call proved abandoned.
 *
 * Failing to take the mutex (another reclaimer inside, or one killed inside it)
 * never reclaims: the caller waits out its timeout and fails closed with
 * `LOCKED`, which is exactly the behaviour that predates this self-heal, and
 * `lockedError` then names the leftover file so an operator can clear it.
 *
 * A token this tool did not write is never removed, nor is a lock whose holder
 * is running, nor one younger than `staleMs`. The pid is only meaningful on the
 * host that wrote it, which is the same assumption the manual remedy the
 * `LOCKED` error prints already makes.
 */
function reclaimAbandonedLock(lockPath: string, staleMs: number): boolean {
  const reclaimPath = `${lockPath}${RECLAIM_SUFFIX}`;
  const token = lockToken();
  let fd: number;
  try {
    fd = openSync(reclaimPath, "wx");
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    return false;
  }
  // The mutex is ours alone until its token is complete: nobody else removes a
  // file whose content is not their own token. So a failed or short setup can
  // delete it outright instead of leaving an `EEXIST` wall for every later
  // recovery of this backlog.
  try {
    try {
      writeWhole(fd, token);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    try {
      unlinkSync(reclaimPath);
    } catch (cleanup) {
      if (errno(cleanup) !== "ENOENT") throw cleanup;
    }
    throw error;
  }
  try {
    return removeAbandonedLock(lockPath, staleMs);
  } finally {
    releaseLock(reclaimPath, token);
  }
}

/**
 * The reclaim decision itself. Runs only with `<path>.lock.reclaim` held, and
 * stays fully synchronous so no other reclaimer of this process can interleave
 * either. Synchronous is not atomic, though: the OS can deschedule this process
 * between two syscalls, which is why the token is confirmed a second time
 * instead of being trusted across the holder check.
 */
function removeAbandonedLock(lockPath: string, staleMs: number): boolean {
  const observed = readFileSafe(lockPath);
  if (observed === undefined) return true;
  const pid = lockHolderPid(observed);
  // Our own pid means a lock this live process still owns somewhere: never ours
  // to reclaim, whatever `holderIsGone` would say about it.
  if (pid === undefined || pid === process.pid) return false;
  if (!holderIsGone(pid)) return false;

  // Fail closed on anything that moved while the holder was being checked: the
  // holder may have been alive at the first read, released, and a normal writer
  // may hold this file now. Only a token identical to the one whose pid was
  // proved gone earns the removal below; a lock that vanished meanwhile is free
  // to take and needs no removal.
  const confirmed = readFileSafe(lockPath);
  if (confirmed === undefined) return true;
  if (confirmed !== observed) return false;

  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return false;
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  return true;
}

/** `writeSync` may write fewer bytes than asked; loop until the token is whole. */
function writeWhole(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw Object.assign(new Error("lock token write made no progress"), {
        code: "EIO",
      });
    }
    offset += written;
  }
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

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function lockedError(lockPath: string, staleMs: number): AxiError {
  const reclaimPath = `${lockPath}${RECLAIM_SUFFIX}`;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      const suggestions = [
        `If no tasks-axi process is running, remove ${lockPath} and retry`,
      ];
      // A leftover reclaim mutex blocks the automatic recovery, so name it too.
      if (existsSync(reclaimPath)) {
        suggestions.push(
          `A reclaim attempt left ${reclaimPath} behind; remove it as well`,
        );
      }
      return new AxiError(
        `backlog lock looks stale: ${lockPath}`,
        "LOCKED",
        suggestions,
      );
    }
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  return new AxiError(
    "backlog is locked by another tasks-axi process",
    "LOCKED",
    ["Wait a moment and retry"],
  );
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

async function acquireLock(
  targetPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
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

      // Self-heal before waiting out the timeout on a holder that is gone. The
      // deadline guard keeps this from looping without a bound.
      if (Date.now() < deadline && reclaimAbandonedLock(lockPath, staleMs)) {
        continue;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(retryMs, remaining));
    }
  }

  throw lockedError(lockPath, staleMs);
}

/** Run `fn` while holding the advisory lock for `path`, releasing it after. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  options?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(path, options);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

export async function withLocks<T>(
  paths: string[],
  fn: () => Promise<T> | T,
  options?: LockOptions,
): Promise<T> {
  const byResolved = new Map<string, string>();
  for (const path of paths) byResolved.set(resolve(path), path);
  const ordered = [...byResolved.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, path]) => path);
  const handles: LockHandle[] = [];
  try {
    for (const path of ordered) handles.push(await acquireLock(path, options));
    return await fn();
  } finally {
    for (const handle of handles.reverse()) handle.release();
  }
}

/** True when a lockfile currently exists for `path`. */
export function isLocked(path: string): boolean {
  return existsSync(`${path}.lock`);
}
