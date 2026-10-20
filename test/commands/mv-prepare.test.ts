import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addCommand } from "../../src/commands/crud.js";
import { MV_HELP, mvCommand } from "../../src/commands/state.js";
import { runPrepareCommand } from "../../src/prepare.js";
import type { Store } from "../../src/store.js";
import { type TempBacklog, makeBacklog } from "../helpers.js";

const PREPARE = fileURLToPath(
  new URL("../fixtures/prepare-command.mjs", import.meta.url),
);

const EMPTY = "# Backlog\n\n## Queued\n\n## Done\n";

const LINKED = [
  "# Backlog",
  "",
  "## Queued",
  "- [ ] blocker-a - root work (repo: app)",
  "- [ ] dependent-b - follow-up (repo: app) blocked-by: blocker-a - waits on root",
  "- [ ] bystander-c - unrelated",
  "",
  "## Done",
  "",
].join("\n");

const logOf = (b: TempBacklog): string => `${b.path}.prepare.log`;

function prepareCommand(log: string, ...rest: string[]): string {
  return [process.execPath, PREPARE, log, ...rest]
    .map((part) => `"${part}"`)
    .join(" ");
}

function invocations(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("invoked "))
    : [];
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("mv --prepare", () => {
  const open: TempBacklog[] = [];
  function backlog(content: string): TempBacklog {
    const b = makeBacklog(content);
    open.push(b);
    return b;
  }
  afterEach(() => {
    for (const b of open.splice(0)) b.cleanup();
  });

  it("prepares once and commits a connected set with its dependencies intact", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    const out = await mvCommand(
      [
        "blocker-a",
        "dependent-b",
        "--to",
        target.path,
        "--prepare",
        prepareCommand(log, "ok"),
      ],
      source.ctx,
    );

    expect(out).toContain(`ok: mv blocker-a dependent-b -> ${target.path}`);
    expect(invocations(log)).toHaveLength(1);
    expect(target.read()).toContain(
      "- [ ] dependent-b - follow-up (repo: app) blocked-by: blocker-a - waits on root",
    );
    expect(source.read()).not.toContain("blocker-a");
    expect(source.read()).not.toContain("dependent-b");
    expect(source.read()).toContain("bystander-c");
  });

  it("rejects a move that would strand an active dependent without preparing", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);
    const before = { source: source.read(), target: target.read() };

    await expect(
      mvCommand(
        [
          "blocker-a",
          "--to",
          target.path,
          "--prepare",
          prepareCommand(log, "ok"),
        ],
        source.ctx,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        "still blocking active tasks: dependent-b",
      ),
    });

    expect(existsSync(log)).toBe(false);
    expect(source.read()).toBe(before.source);
    expect(target.read()).toBe(before.target);
  });

  it("rejects a move that would strand a blocker without preparing", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    await expect(
      mvCommand(
        [
          "dependent-b",
          "--to",
          target.path,
          "--prepare",
          prepareCommand(log, "ok"),
        ],
        source.ctx,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('"blocker-a" would be stranded'),
    });

    expect(existsSync(log)).toBe(false);
    expect(source.read()).toBe(LINKED);
  });

  it("moves exactly what a plain mv moves for held, in-flight, and blocked work", async () => {
    const content = [
      "# Backlog",
      "",
      "## In flight",
      "- [ ] held-h1 - paused work (repo: app) (hold: waiting on review) (hold-kind: external) blocked-by: dest-d - needs dest",
      "",
      "## Queued",
      "",
      "## Done",
      "",
    ].join("\n");
    const destination = [
      "# Backlog",
      "",
      "## Queued",
      "- [ ] dest-d - already here",
      "",
      "## Done",
      "",
    ].join("\n");
    const plainSource = backlog(content);
    const plainTarget = backlog(destination);
    const preparedSource = backlog(content);
    const preparedTarget = backlog(destination);
    const log = logOf(preparedSource);

    await mvCommand(["held-h1", "--to", plainTarget.path], plainSource.ctx);
    await mvCommand(
      [
        "held-h1",
        "--to",
        preparedTarget.path,
        "--prepare",
        prepareCommand(log, "ok"),
      ],
      preparedSource.ctx,
    );

    expect(invocations(log)).toHaveLength(1);
    expect(preparedTarget.read()).toBe(plainTarget.read());
    expect(preparedSource.read()).toBe(plainSource.read());
  });

  it("leaves both backlogs untouched when the prepare command fails, and a retry prepares again", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    await expect(
      mvCommand(
        [
          "bystander-c",
          "--to",
          target.path,
          "--prepare",
          prepareCommand(log, "fail", "3"),
        ],
        source.ctx,
      ),
    ).rejects.toMatchObject({
      code: "PREPARE_FAILED",
      message: expect.stringContaining("exit 3"),
    });

    expect(source.read()).toBe(LINKED);
    expect(target.read()).toBe(EMPTY);
    expect(existsSync(`${source.path}.lock`)).toBe(false);
    expect(existsSync(`${target.path}.lock`)).toBe(false);

    await mvCommand(
      [
        "bystander-c",
        "--to",
        target.path,
        "--prepare",
        prepareCommand(log, "ok"),
      ],
      source.ctx,
    );
    expect(invocations(log)).toHaveLength(2);
    expect(target.read()).toContain("bystander-c");
  });

  it("kills a prepare command that outlives its timeout", async () => {
    const source = backlog(EMPTY);
    const log = logOf(source);

    await expect(
      runPrepareCommand(prepareCommand(log, "sleep", "20000"), 300),
    ).rejects.toMatchObject({
      code: "PREPARE_FAILED",
      message: expect.stringContaining("timed out after 300 ms"),
    });

    if (process.platform !== "win32") {
      const pid = Number(invocations(log)[0].split(" ")[1]);
      await waitFor(() => !isAlive(pid));
    }
  });

  it("holds both backlogs locked while preparing, so a concurrent mutation cannot invalidate the move", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    const move = mvCommand(
      [
        "blocker-a",
        "dependent-b",
        "--to",
        target.path,
        "--prepare",
        prepareCommand(log, "sleep", "800"),
      ],
      source.ctx,
    );
    await waitFor(() => invocations(log).length === 1);
    const late = addCommand(
      ["late-d", "late dependent", "--blocked-by", "blocker-a"],
      source.ctx,
    );

    const [moved, added] = await Promise.allSettled([move, late]);

    expect(moved).toMatchObject({ status: "fulfilled" });
    expect(added).toMatchObject({
      status: "rejected",
      reason: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining('blocker "blocker-a" not found'),
      },
    });
    expect(source.read()).not.toContain("late-d");
    expect(target.read()).toContain("blocker-a");
    expect(target.read()).toContain("dependent-b");
  });

  it("makes a mutation that cannot get the lock fail LOCKED within the bounded wait while the move still commits", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    await mvCommand(
      [
        "bystander-c",
        "--to",
        target.path,
        "--prepare",
        prepareCommand(
          log,
          "cli",
          "add",
          "nested-x",
          "nested work",
          "--file",
          source.path,
        ),
      ],
      source.ctx,
    );

    const [status, ...nested] = readFileSync(`${log}.cli`, "utf8").split("\n");
    expect(status).toBe("1");
    expect(nested.join("\n")).toContain("LOCKED");
    expect(source.read()).not.toContain("nested-x");
    expect(target.read()).toContain("bystander-c");
  }, 15000);

  it("refuses to commit when a backlog is hand-edited while preparing", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);

    await expect(
      mvCommand(
        [
          "bystander-c",
          "--to",
          target.path,
          "--prepare",
          prepareCommand(log, "edit", source.path),
        ],
        source.ctx,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(invocations(log)).toHaveLength(1);
    expect(source.read()).toContain("bystander-c");
    expect(source.read()).toContain("- hand edit");
    expect(target.read()).toBe(EMPTY);

    await mvCommand(["bystander-c", "--to", target.path], source.ctx);
    expect(target.read()).toContain("bystander-c");
  });

  it("does not prepare again when a committed move is replayed", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);
    const args = [
      "bystander-c",
      "--to",
      target.path,
      "--prepare",
      prepareCommand(log, "ok"),
    ];

    await mvCommand(args, source.ctx);
    await expect(mvCommand(args, source.ctx)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(invocations(log)).toHaveLength(1);
  });

  it("refuses --prepare on a backend that cannot hold the move locks, without preparing", async () => {
    const source = backlog(LINKED);
    const target = backlog(EMPTY);
    const log = logOf(source);
    const inner = source.store;
    const foreign: Store = {
      capabilities: () => ({ ...inner.capabilities(), backend: "foreign" }),
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

    await expect(
      mvCommand(
        [
          "bystander-c",
          "--to",
          target.path,
          "--prepare",
          prepareCommand(log, "ok"),
        ],
        { ...source.ctx, store: foreign },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(existsSync(log)).toBe(false);
    expect(source.read()).toBe(LINKED);
  });

  it("documents the prepare contract in mv help", () => {
    expect(MV_HELP).toContain("--prepare <command>");
  });
});
