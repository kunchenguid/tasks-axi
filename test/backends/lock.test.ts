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
});
