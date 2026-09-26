import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { showCommand, updateCommand } from "../../src/commands/crud.js";
import { publicFollowupCommand } from "../../src/commands/public-followup.js";
import { makeBacklog } from "../helpers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(REPO_ROOT, "bin", "tasks-axi.ts");
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BACKLOG = [
  "## In flight",
  "",
  "## Queued",
  "- [ ] claim-q1 - claimable row (repo: x)",
  "  Status: open",
  "- [ ] other-q2 - unrelated row   with odd   spacing (repo: y)",
  "  keep me byte-exact",
  "- [ ] empty-q3 - no body yet (repo: z)",
  "",
  "## Done",
  "",
].join("\n");

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface CliResult {
  status: number | null;
  stdout: string;
}

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
      cwd: REPO_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: stdout + stderr }));
  });
}

describe("update --expect-body-sha256", () => {
  it("writes when the hash matches and reports the hash a reader will see", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const shown = JSON.parse(
        await showCommand(["claim-q1", "--json"], b.ctx),
      );
      expect(shown.body_sha256).toBe(sha("Status: open"));
      const callerText = "Claim: bot-a\n\n";
      expect(sha(callerText)).not.toBe(shown.body_sha256);
      const out = JSON.parse(
        await updateCommand(
          [
            "claim-q1",
            "--body",
            callerText,
            "--archive-body",
            "--expect-body-sha256",
            shown.body_sha256,
            "--json",
          ],
          b.ctx,
        ),
      );
      const reread = JSON.parse(
        await showCommand(["claim-q1", "--json"], b.ctx),
      );
      expect(out.task.body_sha256).toBe(reread.body_sha256);
      expect(reread.body).toBe("Claim: bot-a");
      expect(reread.body_sha256).toBe(sha("Claim: bot-a"));
      expect(reread.body_sha256).not.toBe(sha(callerText));
      expect(b.read()).toContain(
        "- [ ] other-q2 - unrelated row   with odd   spacing (repo: y)\n  keep me byte-exact\n",
      );
      expect(b.noteArchive()).toContain("Status: open");
    } finally {
      b.cleanup();
    }
  });

  it("refuses a stale hash without touching the backlog or archive", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const before = b.read();
      await expect(
        updateCommand(
          [
            "claim-q1",
            "--body",
            "Claim: bot-b",
            "--archive-body",
            "--expect-body-sha256",
            sha("Status: stale"),
          ],
          b.ctx,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(b.read()).toBe(before);
      expect(b.noteArchive()).toBe("");
    } finally {
      b.cleanup();
    }
  });

  it("rejects a malformed hash before reading the store", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        updateCommand(
          ["claim-q1", "--body", "x", "--expect-body-sha256", "ABC"],
          b.ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      b.cleanup();
    }
  });

  it("lets exactly one of two concurrent processes claim the row", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const expected = sha("Status: open");
      const claim = (who: string) =>
        cli([
          "update",
          "claim-q1",
          "--body",
          `Claim: ${who}`,
          "--expect-body-sha256",
          expected,
          "--json",
          "--file",
          b.path,
        ]);
      const results = await Promise.all([claim("bot-a"), claim("bot-b")]);
      const winners = results.filter((result) => result.status === 0);
      const losers = results.filter((result) => result.status !== 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].stdout).toContain("CONFLICT");
      const winner = JSON.parse(winners[0].stdout).task.body as string;
      expect(b.read()).toContain(`  ${winner}\n`);
      expect(b.read().match(/Claim: /g)).toHaveLength(1);
    } finally {
      b.cleanup();
    }
  }, 30_000);

  it("hashes an absent body as the empty string", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const shown = JSON.parse(
        await showCommand(["empty-q3", "--json"], b.ctx),
      );
      expect(shown.body).toBeNull();
      expect(shown.body_sha256).toBe(EMPTY_BODY_SHA256);
    } finally {
      b.cleanup();
    }
  });

  it("conflicts a non-body patch against a stale hash", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const before = b.read();
      await expect(
        updateCommand(
          [
            "claim-q1",
            "--title",
            "still claimable",
            "--expect-body-sha256",
            sha("Status: stale"),
          ],
          b.ctx,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(b.read()).toBe(before);
    } finally {
      b.cleanup();
    }
  });

  it("conflicts a stale hash even when the requested body already matches", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        updateCommand(
          [
            "claim-q1",
            "--body",
            "Status: open",
            "--expect-body-sha256",
            sha("Status: stale"),
          ],
          b.ctx,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      b.cleanup();
    }
  });

  it("reports body_sha256 null for kind=public-followup", async () => {
    const b = makeBacklog(
      "# Backlog\n\n## In flight\n\n## Queued\n- [ ] ordinary-q1 - ordinary work\n\n## Done\n",
    );
    try {
      const requestPath = join(b.dir, "pf-request.json");
      const expectedPath = join(b.dir, "pf-expected.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          request_id: "req-public-demo",
          platform: "discord",
          context_binding: { version: "ctx1", value: "ctx1_opaque_demo" },
          public_safe_summary: "Follow up when the public-safe fix ships",
          received_at: "2026-07-13T12:00:00Z",
          followup_expires_at: "2026-08-13T12:00:00Z",
          reservation_expires_at: "2026-09-13T12:00:00Z",
        }),
        "utf8",
      );
      writeFileSync(
        expectedPath,
        JSON.stringify({
          type: "pr-merged",
          project: "demo",
          required_deliverables: ["pr_url"],
          completion_policy: "all-required",
        }),
        "utf8",
      );
      await publicFollowupCommand(
        [
          "add",
          "public-final-ab",
          "--request-context-file",
          requestPath,
          "--purpose",
          "promised-final",
          "--expected-final-file",
          expectedPath,
          "--expires-at",
          "2026-10-01T00:00:00Z",
          "--json",
        ],
        b.ctx,
      );
      const shown = JSON.parse(
        await showCommand(["public-final-ab", "--json"], b.ctx),
      );
      expect(shown.kind).toBe("public-followup");
      expect(shown.body).toBeNull();
      expect(shown.body_sha256).toBeNull();
    } finally {
      b.cleanup();
    }
  });

  it("returns NOT_FOUND for show --json on a missing id", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        showCommand(["missing-q9", "--json"], b.ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      b.cleanup();
    }
  });
});
