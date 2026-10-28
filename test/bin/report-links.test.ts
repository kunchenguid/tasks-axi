import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TaskLink } from "../../src/model.js";
import { makeBacklog, type TempBacklog } from "../helpers.js";

const BIN = fileURLToPath(
  new URL("../../dist/bin/tasks-axi.js", import.meta.url),
);
const EMPTY = "## In flight\n\n## Queued\n\n## Done\n";
const REPORT = "data/repro-report-link/report.md";

async function mutate(b: TempBacklog, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [BIN, ...args, "--file", b.path, "--json"],
    { cwd: b.dir, encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    already?: boolean;
    task: {
      title: string;
      state: string;
      links: TaskLink[];
      closed: string | null;
    };
  };
  expect(output.ok).toBe(true);
  const stored = await b.store.get("repro-report-link");
  expect(stored).not.toBeNull();
  expect(output.task).toMatchObject({
    title: stored!.title,
    state: stored!.state,
    links: stored!.links,
    closed: stored!.closed ?? null,
  });
  return output;
}

describe("built CLI report links", () => {
  it("preserves a legacy report link through a title-only update", async () => {
    const b = makeBacklog(
      `## Queued\n- [ ] repro-report-link - original title ${REPORT}\n`,
    );
    try {
      const rename = await mutate(b, [
        "update",
        "repro-report-link",
        "--title",
        "renamed title",
      ]);
      expect(rename.task.title).toBe("renamed title");
      expect(rename.task.links).toEqual([{ kind: "report", url: REPORT }]);
    } finally {
      b.cleanup();
    }
  });

  it("round-trips add, title updates, report updates, and done independently", async () => {
    const b = makeBacklog(EMPTY);
    try {
      const add = await mutate(b, [
        "add",
        "repro-report-link",
        "original title",
        "--report",
        REPORT,
      ]);
      expect(add.task.title).toBe("original title");
      expect(add.task.links).toEqual([{ kind: "report", url: REPORT }]);

      const rename = await mutate(b, [
        "update",
        "repro-report-link",
        "--title",
        "renamed title",
      ]);
      expect(rename.task.title).toBe("renamed title");
      expect(rename.task.links).toEqual(add.task.links);

      const repeat = await mutate(b, [
        "update",
        "repro-report-link",
        "--report",
        REPORT,
      ]);
      expect(repeat.already).toBe(true);
      expect(repeat.task).toEqual(rename.task);

      const second = "data/second-report/report.md";
      const update = await mutate(b, [
        "update",
        "repro-report-link",
        "--report",
        second,
      ]);
      expect(update.task.title).toBe("renamed title");
      expect(update.task.links).toEqual([
        ...add.task.links,
        { kind: "report", url: second },
      ]);

      const final = "data/final-report/report.md";
      const done = await mutate(b, [
        "done",
        "repro-report-link",
        "--report",
        final,
        "--no-prune",
      ]);
      expect(done.task.title).toBe("renamed title");
      expect(done.task.state).toBe("done");
      expect(done.task.links).toEqual([
        ...update.task.links,
        { kind: "report", url: final },
      ]);

      const backfill = await mutate(b, [
        "done",
        "repro-report-link",
        "--report",
        "data/backfill/report.md",
        "--no-prune",
      ]);
      expect(backfill.task.title).toBe("renamed title");
      expect(backfill.task.closed).toBe(done.task.closed);
      expect(backfill.task.links).toHaveLength(4);
    } finally {
      b.cleanup();
    }
  });

  it.each(["update", "done"])(
    "keeps a first report supplied by %s out of the title",
    async (command) => {
      const b = makeBacklog(EMPTY);
      try {
        await mutate(b, ["add", "repro-report-link", "original title"]);
        const result = await mutate(b, [
          command,
          "repro-report-link",
          "--report",
          REPORT,
          ...(command === "done" ? ["--no-prune"] : []),
        ]);
        expect(result.task.title).toBe("original title");
        expect(result.task.links).toEqual([{ kind: "report", url: REPORT }]);
      } finally {
        b.cleanup();
      }
    },
  );

  it.each([`Review ${REPORT} before release`, `Review ${REPORT}`])(
    "preserves prose paths, legacy links, and unrelated bytes for %s",
    async (title) => {
      const unrelated =
        "- [ ] untouched - original   spacing (repo: app)\r\n  note\r\n\r\n";
      const b = makeBacklog(
        `## Queued\n- [ ] repro-report-link - ${title}\n${unrelated}## Done\n`,
      );
      try {
        const update = await mutate(b, [
          "update",
          "repro-report-link",
          "--report",
          "data/other(report)/report.md",
        ]);
        expect(update.task.title).toBe(title);
        expect(update.task.links).toContainEqual({
          kind: "report",
          url: REPORT,
        });
        const rename = await mutate(b, [
          "update",
          "repro-report-link",
          "--title",
          "renamed title",
        ]);
        expect(rename.task.title).toBe("renamed title");
        expect(rename.task.links).toEqual(update.task.links);
        expect(b.read()).toContain(unrelated);
      } finally {
        b.cleanup();
      }
    },
  );
});
