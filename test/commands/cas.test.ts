import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { updateCommand } from "../../src/commands/crud.js";
import { revisionCommand } from "../../src/commands/revision.js";
import { mvCommand } from "../../src/commands/state.js";
import type { MoveRevisionSnapshot } from "../../src/revision.js";
import { makeBacklog } from "../helpers.js";

const SOURCE = [
  "# Backlog",
  "",
  "## Queued",
  "- [ ] handoff-q1 - exact delegated work",
  "  private unrelated body",
  "",
  "## Done",
  "",
].join("\n");
const EMPTY = "# Backlog\n\n## Queued\n\n## Done\n";

function capture() {
  let output = "";
  return {
    stdout: { write: (chunk: string) => void (output += chunk) },
    read: () => output,
  };
}

async function readPair(
  source: ReturnType<typeof makeBacklog>,
  target: ReturnType<typeof makeBacklog>,
): Promise<MoveRevisionSnapshot> {
  const output = await revisionCommand(
    ["--to", target.path, "--json"],
    source.ctx,
  );
  return (JSON.parse(output) as { revisions: MoveRevisionSnapshot }).revisions;
}

describe("revision and CAS commands", () => {
  it("returns a two-owner versioned snapshot without task records", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const output = await revisionCommand(
        ["--to", target.path, "--json"],
        source.ctx,
      );
      const parsed = JSON.parse(output) as {
        ok: boolean;
        action: string;
        revisions: MoveRevisionSnapshot;
      };
      expect(parsed).toMatchObject({
        ok: true,
        action: "revision",
        revisions: { schema_version: 1 },
      });
      expect(parsed.revisions.source.revision).toContain(
        "tasks-axi:markdown:v1:",
      );
      expect(output).not.toContain("handoff-q1");
      expect(output).not.toContain("private unrelated body");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it("emits the versioned previous/current CAS contract on success", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const expected = await readPair(source, target);
      const output = await mvCommand(
        [
          "handoff-q1",
          "--to",
          target.path,
          "--cas",
          "--expected-source-revision",
          expected.source.revision,
          "--expected-destination-revision",
          expected.destination.revision,
        ],
        source.ctx,
      );
      const parsed = JSON.parse(output) as {
        ok: boolean;
        action: string;
        id: string;
        cas: {
          schema_version: number;
          previous: MoveRevisionSnapshot;
          current: MoveRevisionSnapshot;
        };
      };
      expect(parsed).toMatchObject({
        ok: true,
        action: "mv",
        id: "handoff-q1",
        cas: { schema_version: 1, previous: expected },
      });
      expect(parsed.cas.current.source.revision).not.toBe(
        expected.source.revision,
      );
      expect(source.read()).not.toContain("handoff-q1");
      expect(target.read()).toContain("handoff-q1");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it("refuses a direct update after revision preparation, then accepts fresh tokens", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const stale = await readPair(source, target);
      await updateCommand(
        ["handoff-q1", "--title", "updated exact delegated work", "--json"],
        source.ctx,
      );
      await expect(
        mvCommand(
          [
            "handoff-q1",
            "--to",
            target.path,
            "--cas",
            "--expected-source-revision",
            stale.source.revision,
            "--expected-destination-revision",
            stale.destination.revision,
          ],
          source.ctx,
        ),
      ).rejects.toMatchObject({
        code: "CAS_REFUSED",
        failures: [{ owner: "source", reason: "stale_revision" }],
      });
      expect(source.read()).toContain("updated exact delegated work");
      expect(target.read()).not.toContain("handoff-q1");

      const fresh = await readPair(source, target);
      await mvCommand(
        [
          "handoff-q1",
          "--to",
          target.path,
          "--cas",
          "--expected-source-revision",
          fresh.source.revision,
          "--expected-destination-revision",
          fresh.destination.revision,
        ],
        source.ctx,
      );
      expect(target.read()).toContain("updated exact delegated work");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it.each([
    {
      name: "missing",
      args: () => ["--cas"],
      reason: "missing_revision",
    },
    {
      name: "malformed",
      args: (pair: MoveRevisionSnapshot) => [
        "--cas",
        "--expected-source-revision=bad-token",
        "--expected-destination-revision",
        pair.destination.revision,
      ],
      reason: "malformed_revision",
    },
    {
      name: "unsupported",
      args: (pair: MoveRevisionSnapshot) => [
        "--cas",
        "--expected-source-revision=tasks-axi:markdown:v9:anything",
        "--expected-destination-revision",
        pair.destination.revision,
      ],
      reason: "unsupported_revision",
    },
    {
      name: "mismatched",
      args: (pair: MoveRevisionSnapshot) => [
        "--cas",
        "--expected-source-revision",
        pair.destination.revision,
        "--expected-destination-revision",
        pair.source.revision,
      ],
      reason: "owner_mismatch",
    },
  ])(
    "prints a machine-readable $name refusal with only safe current evidence",
    async ({ args: casArgs, reason }) => {
      const source = makeBacklog(SOURCE);
      const target = makeBacklog(EMPTY);
      const savedFile = process.env.TASKS_AXI_FILE;
      try {
        const pair = await readPair(source, target);
        process.env.TASKS_AXI_FILE = source.path;
        const output = capture();
        await main({
          argv: ["mv", "handoff-q1", "--to", target.path, ...casArgs(pair)],
          stdout: output.stdout,
        });
        const parsed = JSON.parse(output.read()) as {
          ok: boolean;
          code: string;
          cas: {
            schema_version: number;
            failures: { owner: string; reason: string }[];
            current: MoveRevisionSnapshot;
          };
        };
        expect(parsed).toMatchObject({
          ok: false,
          code: "CAS_REFUSED",
          cas: { schema_version: 1 },
        });
        expect(parsed.cas.failures).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason })]),
        );
        expect(parsed.cas.current).toEqual(pair);
        expect(output.read()).not.toContain("private unrelated body");
        expect(output.read()).not.toContain("exact delegated work");
        expect(process.exitCode).toBe(1);
        expect(source.read()).toBe(SOURCE);
        expect(target.read()).toBe(EMPTY);
      } finally {
        process.exitCode = undefined;
        if (savedFile === undefined) delete process.env.TASKS_AXI_FILE;
        else process.env.TASKS_AXI_FILE = savedFile;
        source.cleanup();
        target.cleanup();
      }
    },
  );

  it("exposes revision and CAS flags in authoritative help", async () => {
    const output = capture();
    await main({ argv: ["revision", "--help"], stdout: output.stdout });
    expect(output.read()).toContain("usage: tasks-axi revision");
    expect(output.read()).toContain("tasks-axi mv --cas");

    const move = capture();
    await main({ argv: ["mv", "--help"], stdout: move.stdout });
    expect(move.read()).toContain("--expected-source-revision");
    expect(move.read()).toContain("--expected-destination-revision");
  });

  it("does not alter archives on a CLI CAS refusal", async () => {
    const source = makeBacklog(SOURCE);
    const target = makeBacklog(EMPTY);
    try {
      const pair = await readPair(source, target);
      // Force stale source evidence through a supported direct write.
      await source.store.update("handoff-q1", { title: "new title" });
      const archiveBefore = source.archive();
      const noteArchiveBefore = source.noteArchive();
      await expect(
        mvCommand(
          [
            "handoff-q1",
            "--to",
            target.path,
            "--cas",
            "--expected-source-revision",
            pair.source.revision,
            "--expected-destination-revision",
            pair.destination.revision,
          ],
          source.ctx,
        ),
      ).rejects.toMatchObject({ code: "CAS_REFUSED" });
      expect(source.archive()).toBe(archiveBefore);
      expect(source.noteArchive()).toBe(noteArchiveBefore);
      expect(readFileSync(source.path, "utf8")).toContain("new title");
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });
});
