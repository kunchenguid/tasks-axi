import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MarkdownStore,
  type CasFailureStage,
} from "../../src/backends/markdown.js";
import { CasRefusalError } from "../../src/revision.js";
import { makeBacklog } from "../helpers.js";

const SOURCE = [
  "# Backlog",
  "",
  "## In flight",
  "",
  "## Queued",
  "- [ ] handoff-q1 - exact delegated work (repo: firstmate)",
  "  Exact body.",
  "",
  "## Done",
  "",
].join("\n");

const EMPTY = "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n";

async function refusalOf(promise: Promise<unknown>): Promise<CasRefusalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CasRefusalError);
    return error as CasRefusalError;
  }
  throw new Error("Expected CAS refusal");
}

describe("MarkdownStore owner revisions and CAS move", () => {
  it("derives opaque owner-bound tokens from exact bytes and missing state", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(SOURCE);
    const missingPath = join(source.dir, "missing", "backlog.md");
    const missing = new MarkdownStore({ path: missingPath });
    try {
      const pair = await source.store.readMoveRevisions(target.store);
      expect(pair).toMatchObject({ schema_version: 1 });
      expect(pair.source.owner).not.toBe(pair.destination.owner);
      expect(pair.source.revision).toMatch(
        /^tasks-axi:markdown:v1:[a-f0-9]{64}:[a-f0-9]{64}$/,
      );
      // Identical bytes still cannot exchange tokens because owner identity is
      // part of each token.
      expect(pair.source.revision).not.toBe(pair.destination.revision);

      const before = await missing.readOwnerRevision();
      mkdirSync(join(source.dir, "missing"), { recursive: true });
      writeFileSync(missingPath, "", "utf8");
      const empty = await missing.readOwnerRevision();
      expect(empty.revision).not.toBe(before.revision);

      writeFileSync(source.path, `${SOURCE}free-form hand edit\n`, "utf8");
      const changed = await source.store.readOwnerRevision();
      expect(changed.revision).not.toBe(pair.source.revision);

      // Hash raw bytes, not a lossy UTF-8 decode that could collapse distinct
      // invalid input to the same replacement character.
      writeFileSync(source.path, Buffer.from([0xff]));
      const invalidOne = await source.store.readOwnerRevision();
      writeFileSync(source.path, Buffer.from([0xfe]));
      const invalidTwo = await source.store.readOwnerRevision();
      expect(invalidTwo.revision).not.toBe(invalidOne.revision);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it("moves only when both locked owner revisions match and returns new evidence", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const expected = await source.store.readMoveRevisions(target.store);
      const result = await source.store.moveManyToCas(
        ["handoff-q1"],
        target.store,
        {
          source: expected.source.revision,
          destination: expected.destination.revision,
        },
      );

      expect(result.tasks.map((task) => task.id)).toEqual(["handoff-q1"]);
      expect(result.previous).toEqual(expected);
      expect(result.current.source.revision).not.toBe(expected.source.revision);
      expect(result.current.destination.revision).not.toBe(
        expected.destination.revision,
      );
      expect(source.read()).not.toContain("handoff-q1");
      expect(target.read()).toContain("handoff-q1");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it.each([
    {
      name: "missing",
      expected: (
        current: Awaited<ReturnType<MarkdownStore["readMoveRevisions"]>>,
      ) => ({
        destination: current.destination.revision,
      }),
      reason: "missing_revision",
    },
    {
      name: "malformed",
      expected: (
        current: Awaited<ReturnType<MarkdownStore["readMoveRevisions"]>>,
      ) => ({
        source: "not-a-revision",
        destination: current.destination.revision,
      }),
      reason: "malformed_revision",
    },
    {
      name: "unsupported",
      expected: (
        current: Awaited<ReturnType<MarkdownStore["readMoveRevisions"]>>,
      ) => ({
        source: "tasks-axi:markdown:v2:future-format",
        destination: current.destination.revision,
      }),
      reason: "unsupported_revision",
    },
    {
      name: "wrong owner",
      expected: (
        current: Awaited<ReturnType<MarkdownStore["readMoveRevisions"]>>,
      ) => ({
        source: current.destination.revision,
        destination: current.source.revision,
      }),
      reason: "owner_mismatch",
    },
  ])(
    "refuses a $name revision under both locks with safe current evidence",
    async ({ expected: makeExpected, reason }) => {
      const source = makeBacklog(SOURCE);
      const target = makeBacklog(EMPTY);
      try {
        const current = await source.store.readMoveRevisions(target.store);
        const sourceBefore = source.read();
        const targetBefore = target.read();
        const refusal = await refusalOf(
          source.store.moveManyToCas(
            ["handoff-q1"],
            target.store,
            makeExpected(current),
          ),
        );

        expect(refusal.code).toBe("CAS_REFUSED");
        expect(refusal.failures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ owner: "source", reason }),
          ]),
        );
        expect(refusal.current).toEqual(current);
        expect(source.read()).toBe(sourceBefore);
        expect(target.read()).toBe(targetBefore);
        expect(source.archive()).toBe("");
        expect(source.noteArchive()).toBe("");
      } finally {
        source.cleanup();
        target.cleanup();
      }
    },
  );

  it("returns revision evidence for a refusal before parsing corrupt owner contents", async () => {
    const source = makeBacklog(
      "# Backlog\n\n## Queued\n- [ ] public-q1 - safe (kind: public-followup)\n  <!-- tasks-axi:public-followup/v1:not-json -->\n",
    );
    const target = makeBacklog(EMPTY);
    try {
      const current = await source.store.readMoveRevisions(target.store);
      const refusal = await refusalOf(
        source.store.moveManyToCas(["public-q1"], target.store, {
          destination: current.destination.revision,
        }),
      );
      expect(refusal.failures).toEqual([
        { owner: "source", reason: "missing_revision" },
      ]);
      expect(refusal.current).toEqual(current);
      expect(source.read()).toContain("v1:not-json");
      expect(target.read()).toBe(EMPTY);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it.each([
    ["source-only", true, false, ["source"]],
    ["destination-only", false, true, ["destination"]],
    ["both-side", true, true, ["source", "destination"]],
  ] as const)(
    "refuses a %s race without changing either raced state",
    async (_name, raceSource, raceDestination, failedOwners) => {
      const source = makeBacklog(SOURCE);
      const target = makeBacklog(EMPTY);
      try {
        const expected = await source.store.readMoveRevisions(target.store);
        if (raceSource) {
          await source.store.update("handoff-q1", {
            title: "direct source mutation won",
          });
        }
        if (raceDestination) {
          await target.store.create({
            id: "direct-destination-q2",
            title: "direct destination mutation won",
          });
        }
        const sourceBefore = source.read();
        const targetBefore = target.read();

        const refusal = await refusalOf(
          source.store.moveManyToCas(["handoff-q1"], target.store, {
            source: expected.source.revision,
            destination: expected.destination.revision,
          }),
        );

        expect(refusal.failures).toEqual(
          failedOwners.map((owner) => ({
            owner,
            reason: "stale_revision",
          })),
        );
        expect(source.read()).toBe(sourceBefore);
        expect(target.read()).toBe(targetBefore);
      } finally {
        source.cleanup();
        target.cleanup();
      }
    },
  );

  it("serializes a concurrent supported direct mutation and refuses its stale CAS", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const expected = await source.store.readMoveRevisions(target.store);
      let pendingCas: Promise<unknown> | undefined;

      await source.store.update("handoff-q1", {
        get title() {
          // update() is the same direct Store mutation used by the CLI. It
          // already holds the source lock when the CAS starts, so the CAS must
          // wait, re-read, and refuse rather than validate an unlocked value.
          pendingCas = source.store.moveManyToCas(
            ["handoff-q1"],
            target.store,
            {
              source: expected.source.revision,
              destination: expected.destination.revision,
            },
          );
          // Attach immediately because the direct mutation completes before
          // this test awaits the CAS outcome.
          void pendingCas.catch(() => undefined);
          return "concurrent direct CLI mutation";
        },
      });

      expect(pendingCas).toBeDefined();
      const refusal = await refusalOf(pendingCas as Promise<unknown>);
      expect(refusal.failures).toContainEqual({
        owner: "source",
        reason: "stale_revision",
      });
      expect(source.read()).toContain("concurrent direct CLI mutation");
      expect(target.read()).not.toContain("handoff-q1");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it("retries successfully with the fresh evidence returned by a refusal", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const old = await source.store.readMoveRevisions(target.store);
      await source.store.update("handoff-q1", { title: "fresh exact work" });
      const refusal = await refusalOf(
        source.store.moveManyToCas(["handoff-q1"], target.store, {
          source: old.source.revision,
          destination: old.destination.revision,
        }),
      );
      expect(refusal.current).toBeDefined();

      await source.store.moveManyToCas(["handoff-q1"], target.store, {
        source: refusal.current?.source.revision,
        destination: refusal.current?.destination.revision,
      });
      expect(source.read()).not.toContain("handoff-q1");
      expect(target.read()).toContain("fresh exact work");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it.each(["same path", "hardlink"] as const)(
    "refuses a %s same-file destination before preparing the move",
    async (kind) => {
      const source = makeBacklog(SOURCE);
      try {
        const targetPath =
          kind === "same path" ? source.path : join(source.dir, "hardlink.md");
        if (kind === "hardlink") linkSync(source.path, targetPath);
        const target = new MarkdownStore({ path: targetPath });
        const expected = await source.store.readMoveRevisions(target);
        const before = source.read();
        const refusal = await refusalOf(
          source.store.moveManyToCas(["handoff-q1"], target, {
            source: expected.source.revision,
            destination: expected.destination.revision,
          }),
        );
        expect(refusal.failures).toEqual([
          { owner: "operation", reason: "same_owner" },
        ]);
        expect(source.read()).toBe(before);
      } finally {
        source.cleanup();
      }
    },
  );

  it("refuses the same owner through a canonical directory symlink alias", async () => {
    const source = makeBacklog(SOURCE);
    const aliasHolder = makeBacklog(EMPTY);
    const aliasDir = join(aliasHolder.dir, "owner-alias");
    try {
      symlinkSync(
        source.dir,
        aliasDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      const alias = new MarkdownStore({ path: join(aliasDir, "backlog.md") });
      const expected = await source.store.readMoveRevisions(alias);
      const before = source.read();
      const refusal = await refusalOf(
        source.store.moveManyToCas(["handoff-q1"], alias, {
          source: expected.source.revision,
          destination: expected.destination.revision,
        }),
      );

      expect(refusal.failures).toEqual([
        { owner: "operation", reason: "same_owner" },
      ]);
      expect(refusal.current?.source.owner).toBe(
        refusal.current?.destination.owner,
      );
      expect(source.read()).toBe(before);
    } finally {
      try {
        unlinkSync(aliasDir);
      } catch {
        // The assertion may fail before the alias is created.
      }
      source.cleanup();
      aliasHolder.cleanup();
    }
  });

  it.each<CasFailureStage>([
    "before-write",
    "after-destination-write",
    "after-source-write",
  ])(
    "restores exact owners and never writes archives after %s failure",
    async (stage) => {
      const source = makeBacklog(SOURCE);
      const target = makeBacklog(EMPTY);
      const doneArchive = join(source.dir, "done-archive.md");
      const noteArchive = join(source.dir, "note-archive.md");
      writeFileSync(doneArchive, "preserved done archive\n", "utf8");
      writeFileSync(noteArchive, "preserved note archive\n", "utf8");
      const injectingSource = new MarkdownStore({
        path: source.path,
        casFailureInjector: (at) => {
          if (at === stage) throw new Error(`injected ${stage}`);
        },
      });
      try {
        const expected = await injectingSource.readMoveRevisions(target.store);
        const sourceBefore = source.read();
        const targetBefore = target.read();

        await expect(
          injectingSource.moveManyToCas(["handoff-q1"], target.store, {
            source: expected.source.revision,
            destination: expected.destination.revision,
          }),
        ).rejects.toThrow(`injected ${stage}`);

        expect(source.read()).toBe(sourceBefore);
        expect(target.read()).toBe(targetBefore);
        expect(readFileSync(doneArchive, "utf8")).toBe(
          "preserved done archive\n",
        );
        expect(readFileSync(noteArchive, "utf8")).toBe(
          "preserved note archive\n",
        );
      } finally {
        source.cleanup();
        target.cleanup();
      }
    },
  );

  it("removes a newly published destination when failure is injected after its write", async () => {
    const source = makeBacklog(SOURCE);
    const destinationPath = join(source.dir, "new-home", "data", "backlog.md");
    const target = new MarkdownStore({ path: destinationPath });
    const injectingSource = new MarkdownStore({
      path: source.path,
      casFailureInjector: (stage) => {
        if (stage === "after-destination-write") throw new Error("injected");
      },
    });
    try {
      const expected = await injectingSource.readMoveRevisions(target);
      const sourceBefore = source.read();
      await expect(
        injectingSource.moveManyToCas(["handoff-q1"], target, {
          source: expected.source.revision,
          destination: expected.destination.revision,
        }),
      ).rejects.toThrow("injected");
      expect(source.read()).toBe(sourceBefore);
      expect(existsSync(destinationPath)).toBe(false);
    } finally {
      source.cleanup();
    }
  });
});
