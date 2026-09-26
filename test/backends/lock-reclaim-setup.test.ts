import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Setup failures while creating `<path>.lock.reclaim`. The mutex is created
 * with `openSync(..., "wx")`; if its token is not fully written, the file must
 * not outlive the attempt, or every later recovery of that backlog fails on
 * `EEXIST` until someone deletes it by hand.
 */
const writeFault = vi.hoisted(() => ({
  mode: "none" as "none" | "throw" | "short",
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    const mode = writeFault.mode;
    writeFault.mode = "none";
    if (mode === "throw") {
      throw Object.assign(new Error("injected write failure"), { code: "EIO" });
    }
    if (mode === "short") {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const offset = typeof rest[0] === "number" ? rest[0] : 0;
      return fs.writeSync(fd, bytes, offset, 1);
    }
    return (fs.writeSync as (...args: unknown[]) => number)(fd, data, ...rest);
  }) as typeof fs.writeSync;
  return { ...fs, default: { ...fs, writeSync }, writeSync };
});

const { withLock } = await import("../../src/backends/lock.js");

let dir: string;

function plantAbandonedLock(path: string): string {
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, "4711:kq3nonce8zf:1750000000000:1\n");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockPath, old, old);
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("stubbed ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  return lockPath;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-reclaim-setup-"));
});

afterEach(() => {
  writeFault.mode = "none";
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("reclaim mutex setup", () => {
  it("removes the reclaim mutex when writing its token throws", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAbandonedLock(path);
    writeFault.mode = "throw";

    await expect(
      withLock(path, () => undefined, { timeoutMs: 200, retryMs: 10 }),
    ).rejects.toThrow("injected write failure");
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("writes the whole token after a short write and releases the mutex", async () => {
    const path = join(dir, "b.md");
    const lockPath = plantAbandonedLock(path);
    writeFault.mode = "short";

    let ran = false;
    await withLock(
      path,
      () => {
        ran = true;
      },
      { timeoutMs: 200, retryMs: 10 },
    );
    expect(ran).toBe(true);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
