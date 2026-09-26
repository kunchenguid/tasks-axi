import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite,
  isLocked,
  readFileSafe,
  withLock,
  withLocks,
} from "../../src/backends/lock.js";

let dir: string;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_MODULE = new URL("../../src/backends/lock.js", import.meta.url).href;

/**
 * `process.kill(pid, 0)` liveness and reaped-child pids are POSIX facts. On
 * win32 a pid is recycled aggressively and the errno set differs, so the tests
 * that depend on a *real* pid being gone are skipped there; the reclaim
 * decision itself is covered on every platform by the cases that inject the
 * holder-check answer (ESRCH / EPERM / unknown) instead of relying on the OS.
 */
const realPid = process.platform !== "win32";

/** A pid that is certainly gone: a child process we already reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("could not spawn a child");
  return child.pid;
}

/** A token in the exact shape `lockToken` writes: pid:nonce:millis:counter. */
function token(pid: number | string): string {
  return `${pid}:kq3nonce8zf:1750000000000:1\n`;
}

/** Make `process.kill(pid, 0)` answer with `code` instead of asking the OS. */
function stubHolderCheck(code: string | undefined): void {
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error(`stubbed ${code ?? "bare"} answer`), {
      ...(code !== undefined ? { code } : {}),
    });
  }) as typeof process.kill);
}

/** Write `token` as the lockfile for `path` and age it past any stale window. */
function plantAgedLock(path: string, content: string): string {
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, content);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);
  return lockPath;
}

const AGED = { staleMs: 30_000, timeoutMs: 40, retryMs: 5 } as const;

async function expectLockedAndUntouched(
  path: string,
  lockPath: string,
): Promise<void> {
  const before = readFileSync(lockPath, "utf8");
  await expect(withLock(path, () => "never", AGED)).rejects.toMatchObject({
    code: "LOCKED",
  });
  expect(readFileSync(lockPath, "utf8")).toBe(before);
}

/**
 * A separate process that reclaims `path`'s abandoned lock but pauses inside the
 * reclaim section — after reading the token, before unlinking it — so a second
 * process can be observed against a reclaim in flight. The pause is injected by
 * patching this child's own `process.kill`, the holder-liveness probe, so no test
 * seam is needed in the product code.
 */
const PAUSING_RECLAIMER = `
import { existsSync, writeFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(LOCK_MODULE)};

const [path, pausedAt, go, holdingAt, release] = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (file) => {
  const deadline = Date.now() + 20_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + file);
    Atomics.wait(sleeper, 0, 0, 10);
  }
};

const realKill = process.kill.bind(process);
let paused = false;
process.kill = (pid, signal) => {
  if (!paused && signal === 0) {
    paused = true;
    writeFileSync(pausedAt, String(process.pid));
    waitFor(go);
  }
  return realKill(pid, signal);
};

await withLock(
  path,
  () => {
    writeFileSync(holdingAt, String(process.pid));
    waitFor(release);
  },
  { staleMs: 30_000, timeoutMs: 20_000, retryMs: 10 },
);
`;

async function waitForFile(file: string, note: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${file}\n${note()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-lock-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("lock + atomic write", () => {
  it("readFileSafe returns undefined for a missing file", () => {
    expect(readFileSafe(join(dir, "nope.md"))).toBeUndefined();
  });

  it("atomicWrite writes content and leaves no temp file behind", () => {
    const path = join(dir, "out.md");
    atomicWrite(path, "hello world");
    expect(readFileSync(path, "utf8")).toBe("hello world");
    const tmps = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(tmps).toHaveLength(0);
  });

  it("withLock runs the function and releases the lock", async () => {
    const path = join(dir, "b.md");
    const result = await withLock(path, () => {
      expect(isLocked(path)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(isLocked(path)).toBe(false);
  });

  it("releases the lock even when the function throws", async () => {
    const path = join(dir, "b.md");
    await expect(
      withLock(path, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isLocked(path)).toBe(false);
  });

  it("fails closed when a held lock remains past the timeout", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "other-holder\n");

    await expect(
      withLock(path, () => "never", { timeoutMs: 20, retryMs: 5 }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    expect(readFileSync(lockPath, "utf8")).toBe("other-holder\n");
  });

  it("reports a stale held lock without removing it", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "crashed-holder\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    await expect(
      withLock(path, () => "never", {
        staleMs: 30_000,
        timeoutMs: 20,
        retryMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringContaining("looks stale"),
      suggestions: [expect.stringContaining(lockPath)],
    });
    expect(readFileSync(lockPath, "utf8")).toBe("crashed-holder\n");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reclaims a lock whose recorded holder answers ESRCH", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAgedLock(path, token(4711));
    stubHolderCheck("ESRCH");

    await expect(withLock(path, () => "recovered", AGED)).resolves.toBe(
      "recovered",
    );
    expect(existsSync(lockPath)).toBe(false);
    // The reclaim mutex is released, not leaked.
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  // Anything other than a definite "no such process" keeps the lock: EPERM is a
  // live pid owned by another user, and an unknown errno is not proof of death.
  it.each([["EPERM"], ["EINVAL"], [undefined]])(
    "keeps an aged lock when the holder check answers %s",
    async (code) => {
      const path = join(dir, "b.md");
      const lockPath = plantAgedLock(path, token(4711));
      stubHolderCheck(code);

      await expectLockedAndUntouched(path, lockPath);
    },
  );

  // Only the exact 4-field shape `lockToken` writes carries a pid this code is
  // allowed to check. Every one of these would be reclaimed by a parser that
  // trusts a leading number, so the holder check is stubbed to "gone" and the
  // token validation is the only thing left standing between them and removal.
  it.each([
    ["opaque", "crashed-holder\n"],
    ["pid only", "4711\n"],
    ["two fields", "4711:kq3nonce8zf\n"],
    ["three fields", "4711:kq3nonce8zf:1750000000000\n"],
    ["five fields", "4711:kq3nonce8zf:1750000000000:1:extra\n"],
    ["pid zero", token(0)],
    ["negative pid", token(-5)],
    ["non-integer pid", token("47.11")],
    ["pid past MAX_SAFE_INTEGER", token("9007199254740993")],
    ["padded pid", token(" 4711")],
    ["zero-padded pid", token("04711")],
    ["human prose with a leading number", "4711 held by hand, do not remove\n"],
  ])("never reclaims a %s token", async (_label, content) => {
    const path = join(dir, "b.md");
    const lockPath = plantAgedLock(path, content);
    stubHolderCheck("ESRCH");

    await expectLockedAndUntouched(path, lockPath);
  });

  it("does not reclaim while another reclaimer holds the reclaim mutex", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAgedLock(path, token(4711));
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(reclaimPath, token(process.pid));
    stubHolderCheck("ESRCH");

    await expect(withLock(path, () => "never", AGED)).rejects.toMatchObject({
      code: "LOCKED",
      // The leftover mutex is named, so an operator can clear a reclaimer that
      // was killed inside its own critical section.
      suggestions: [
        expect.stringContaining(lockPath),
        expect.stringContaining(reclaimPath),
      ],
    });
    expect(readFileSync(lockPath, "utf8")).toBe(token(4711));
    // Another process's mutex is left exactly as found.
    expect(readFileSync(reclaimPath, "utf8")).toBe(token(process.pid));
  });

  it("keeps a lock whose recorded holder is this live process", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAgedLock(path, token(process.pid));

    await expectLockedAndUntouched(path, lockPath);
  });

  // The holder check is not instantaneous: the OS can deschedule the reclaimer
  // between reading the token and acting on it. The abandoned holder can be
  // released in that window and a normal writer can take the lock with a plain
  // `openSync(..., "wx")` — no reclaim mutex involved — so the mutex alone does
  // not prove the file is still the one that was read. The swap is injected at
  // the holder probe, which is exactly where that window sits.
  it("never removes a lock a normal writer took during the holder check", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAgedLock(path, token(4711));
    const live = token(process.pid);
    vi.spyOn(process, "kill").mockImplementation((() => {
      // The dead holder's lock is replaced by a live writer's, aged past the
      // stale window so nothing but the token check can save it.
      writeFileSync(lockPath, live);
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockPath, old, old);
      throw Object.assign(new Error("stubbed ESRCH answer"), { code: "ESRCH" });
    }) as typeof process.kill);

    await expect(withLock(path, () => "never", AGED)).rejects.toMatchObject({
      code: "LOCKED",
    });
    expect(readFileSync(lockPath, "utf8")).toBe(live);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it.runIf(realPid)(
    "reclaims a lock left by a process that really exited",
    async () => {
      const path = join(dir, "b.md");
      const lockPath = plantAgedLock(path, token(deadPid()));

      await expect(withLock(path, () => "recovered", AGED)).resolves.toBe(
        "recovered",
      );
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.runIf(realPid)(
    "keeps an aged lock whose recorded holder is still running",
    async () => {
      const path = join(dir, "b.md");
      const holder = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, 60000)",
      ]);
      try {
        const lockPath = plantAgedLock(path, token(holder.pid ?? 0));

        await expectLockedAndUntouched(path, lockPath);
      } finally {
        holder.kill("SIGKILL");
      }
    },
  );

  it.runIf(realPid)(
    "keeps a fresh lock even when its recorded holder is gone",
    async () => {
      const path = join(dir, "b.md");
      const lockPath = `${path}.lock`;
      writeFileSync(lockPath, token(deadPid()));

      await expectLockedAndUntouched(path, lockPath);
    },
  );

  it.runIf(realPid)(
    "never removes the lock another process took while a reclaim was paused mid-decision",
    async () => {
      const path = join(dir, "b.md");
      const lockPath = plantAgedLock(path, token(deadPid()));
      const abandoned = readFileSync(lockPath, "utf8");
      const script = join(dir, "pausing-reclaimer.mjs");
      writeFileSync(script, PAUSING_RECLAIMER);
      const pausedAt = join(dir, "paused");
      const go = join(dir, "go");
      const holdingAt = join(dir, "holding");
      const release = join(dir, "release");

      const child = spawn(
        process.execPath,
        ["--import", "tsx", script, path, pausedAt, go, holdingAt, release],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let noise = "";
      child.stdout.on("data", (chunk: Buffer) => (noise += chunk));
      child.stderr.on("data", (chunk: Buffer) => (noise += chunk));
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      );

      try {
        // The child has read the abandoned token and is about to unlink it.
        await waitForFile(pausedAt, () => noise);

        // While that decision is in flight, no second process reclaims: this
        // one fails closed and leaves the victim exactly as it found it. Without
        // the mutex this call wins the lock the paused child is about to unlink,
        // which is the whole bug.
        await expectLockedAndUntouched(path, lockPath);
        expect(readFileSync(lockPath, "utf8")).toBe(abandoned);
        expect(existsSync(`${lockPath}.reclaim`)).toBe(true);

        // Let the child finish the reclaim; it now holds a lock of its own.
        writeFileSync(go, "");
        await waitForFile(holdingAt, () => noise);
        const held = readFileSync(lockPath, "utf8");
        expect(held.startsWith(`${child.pid}:`)).toBe(true);

        // The decision this process took before that lock existed cannot reach
        // it — not even aged past the stale window, which is the exact file a
        // re-read-then-unlink reclaimer would delete.
        const old = new Date(Date.now() - 120_000);
        utimesSync(lockPath, old, old);
        await expectLockedAndUntouched(path, lockPath);
        expect(readFileSync(lockPath, "utf8")).toBe(held);
      } finally {
        writeFileSync(release, "");
      }

      expect(await exited).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      await expect(withLock(path, () => "free")).resolves.toBe("free");
    },
    40_000,
  );

  it("does not release a different holder token", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;

    await withLock(path, () => {
      writeFileSync(lockPath, "other-holder\n");
    });

    expect(readFileSync(lockPath, "utf8")).toBe("other-holder\n");
  });

  it("waits on a non-stale lock until it is released", async () => {
    const path = join(dir, "b.md");
    let markFirstHolding!: () => void;
    let releaseFirst!: () => void;
    const firstHolding = new Promise<void>((resolve) => {
      markFirstHolding = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;

    const first = withLock(path, async () => {
      markFirstHolding();
      await firstRelease;
    });
    await firstHolding;

    const second = withLock(path, () => {
      secondEntered = true;
      return "second";
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await first;
    await expect(second).resolves.toBe("second");
    expect(secondEntered).toBe(true);
  });

  it("serializes reversed multi-lock acquisition orders", async () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    let active = 0;
    let maxActive = 0;
    const hold = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };

    await Promise.all([withLocks([a, b], hold), withLocks([b, a], hold)]);

    expect(maxActive).toBe(1);
    expect(isLocked(a)).toBe(false);
    expect(isLocked(b)).toBe(false);
  });
});
