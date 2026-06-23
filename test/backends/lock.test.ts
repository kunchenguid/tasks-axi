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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  isLocked,
  readFileSafe,
  withLock,
  withLocks,
} from "../../src/backends/lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-lock-"));
});
afterEach(() => {
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

  it("reclaims a stale lock from a crashed process", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "99999\n");
    // Backdate the lock well past the stale threshold.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const result = await withLock(path, () => "stole it");
    expect(result).toBe("stole it");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not release another holder's reclaimed stale lock", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;
    let releaseReclaimed: (() => void) | undefined;
    let reclaimedFinished: Promise<void> | undefined;
    let markReclaimedHolding!: () => void;
    const reclaimedHolding = new Promise<void>((resolve) => {
      markReclaimedHolding = resolve;
    });

    await withLock(path, async () => {
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockPath, old, old);
      reclaimedFinished = withLock(path, async () => {
        markReclaimedHolding();
        await new Promise<void>((resolve) => {
          releaseReclaimed = resolve;
        });
      });
      await reclaimedHolding;
    });

    expect(existsSync(lockPath)).toBe(true);
    if (!releaseReclaimed || !reclaimedFinished) {
      throw new Error("reclaimed lock was not acquired");
    }
    releaseReclaimed();
    await reclaimedFinished;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not release a different holder token", async () => {
    const path = join(dir, "b.md");
    const lockPath = `${path}.lock`;

    await withLock(path, () => {
      writeFileSync(lockPath, "other-holder\n");
    });

    expect(readFileSync(lockPath, "utf8")).toBe("other-holder\n");
  });

  it("waits on a non-stale lock instead of reclaiming it", async () => {
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
