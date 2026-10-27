import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { updateCommand } from "../../src/commands/crud.js";
import type { TaskPatch } from "../../src/model.js";
import { makeBacklog } from "../helpers.js";

const UNTOUCHED =
  "- [ ] other-q2 - keep   spacing (repo: demo)\n  untouched notes\n";
const BACKLOG = [
  "## In flight",
  "",
  "## Queued",
  "- [ ] notes-q1 - task notes (repo: demo)",
  "  Original paragraph.",
  "",
  "  ## Evidence",
  "  Keep this evidence.",
  UNTOUCHED.trimEnd(),
  "## Done",
  "",
].join("\n");
const ORIGINAL = "Original paragraph.\n\n## Evidence\nKeep this evidence.";

describe("update --append-body", () => {
  it("appends multiline notes without replacing the existing body", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const note =
        "New evidence.\n\n- repeated detail\n- repeated detail\nUnicode: ✓";
      const out = JSON.parse(
        await updateCommand(
          ["notes-q1", "--append-body", note, "--json"],
          b.ctx,
        ),
      );
      expect(out).toMatchObject({
        ok: true,
        action: "update",
        changed: ["body"],
        task: { body: `${ORIGINAL}\n\n${note}` },
      });
      expect((await b.store.get("notes-q1"))?.body).toBe(
        `${ORIGINAL}\n\n${note}`,
      );
      expect(b.read()).toContain(UNTOUCHED);
      expect(b.noteArchive()).toBe("");
    } finally {
      b.cleanup();
    }
  });

  it("accepts a body file and confirms the write in TOON", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const path = join(b.dir, "note.md");
      writeFileSync(path, "File note.\n\nSecond paragraph.", "utf8");
      const out = await updateCommand(
        ["notes-q1", "--append-body-file", path],
        b.ctx,
      );
      expect(out).toMatch(/^ok: updated notes-q1 \(body\)/);
      expect((await b.store.get("notes-q1"))?.body).toBe(
        `${ORIGINAL}\n\nFile note.\n\nSecond paragraph.`,
      );
    } finally {
      b.cleanup();
    }
  });

  it("starts a body when the task has no notes", async () => {
    const b = makeBacklog("## Queued\n- [ ] empty-q1 - no notes\n");
    try {
      await updateCommand(["empty-q1", "--append-body", "First note."], b.ctx);
      expect((await b.store.get("empty-q1"))?.body).toBe("First note.");
    } finally {
      b.cleanup();
    }
  });

  describe.each(["inline", "file", "store"] as const)("%s append", (input) => {
    it.each([true, false])(
      "rejects reserved metadata without changing persisted bytes, existing body: %s",
      async (hasBody) => {
        const source = hasBody
          ? BACKLOG
          : "## Queued\n- [ ] notes-q1 - task notes\n";
        const b = makeBacklog(source);
        try {
          const note = "Investigated tasks-axi:public-followup parsing";
          let operation: Promise<unknown>;
          if (input === "store") {
            operation = b.store.update("notes-q1", { appendBody: note });
          } else if (input === "file") {
            const path = join(b.dir, "note.md");
            writeFileSync(path, note, "utf8");
            operation = updateCommand(
              ["notes-q1", "--append-body-file", path],
              b.ctx,
            );
          } else {
            operation = updateCommand(
              ["notes-q1", "--append-body", note],
              b.ctx,
            );
          }
          await expect(operation).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
          });
          expect(b.read()).toBe(source);
          expect(b.noteArchive()).toBe("");
          const reader = new MarkdownStore({ path: b.path });
          expect((await reader.get("notes-q1"))?.body).toBe(
            hasBody ? ORIGINAL : undefined,
          );
          expect((await reader.list({})).total).toBe(hasBody ? 2 : 1);
        } finally {
          b.cleanup();
        }
      },
    );
  });

  it("preserves both concurrent appends from separate store instances", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      const other = {
        ...b.ctx,
        store: new MarkdownStore({ path: b.path }),
      };
      await Promise.all([
        updateCommand(["notes-q1", "--append-body", "Writer A."], b.ctx),
        updateCommand(["notes-q1", "--append-body", "Writer B."], other),
      ]);
      const body = (await b.store.get("notes-q1"))?.body;
      expect([
        `${ORIGINAL}\n\nWriter A.\n\nWriter B.`,
        `${ORIGINAL}\n\nWriter B.\n\nWriter A.`,
      ]).toContain(body);
      expect(b.read()).toContain(UNTOUCHED);
    } finally {
      b.cleanup();
    }
  });

  it("appends once per invocation, including repeated paragraphs", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await b.store.update("notes-q1", { appendBody: "Same note." });
      await b.store.update("notes-q1", { appendBody: "Same note." });
      expect((await b.store.get("notes-q1"))?.body).toBe(
        `${ORIGINAL}\n\nSame note.\n\nSame note.`,
      );
    } finally {
      b.cleanup();
    }
  });

  it.each<TaskPatch>([
    { appendBody: "" },
    { appendBody: " \n " },
    { appendBody: "note", body: "replacement" },
    { appendBody: "note", archiveBody: true },
  ])("rejects unsafe append patches at the store seam: %j", async (patch) => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(b.store.update("notes-q1", patch)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(b.read()).toBe(BACKLOG);
      expect(b.noteArchive()).toBe("");
    } finally {
      b.cleanup();
    }
  });

  it.each([
    ["--append-body"],
    ["--append-body", ""],
    ["--append-body", " \n "],
    ["--append-body", "note", "--archive-body"],
    ["--append-body", "note", "--body", "replacement"],
    ["--append-body", "note", "--append-body-file", "unused.md"],
  ])("rejects invalid input without writing: %j", async (...args) => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        updateCommand(["notes-q1", ...args], b.ctx),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(b.read()).toBe(BACKLOG);
      expect(b.noteArchive()).toBe("");
    } finally {
      b.cleanup();
    }
  });

  it("refuses an unreadable append file without touching the body", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        updateCommand(
          ["notes-q1", "--append-body-file", join(b.dir, "missing.md")],
          b.ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(b.read()).toBe(BACKLOG);
    } finally {
      b.cleanup();
    }
  });

  it("reports a missing task without changing the backlog", async () => {
    const b = makeBacklog(BACKLOG);
    try {
      await expect(
        updateCommand(["missing-q1", "--append-body", "note"], b.ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(b.read()).toBe(BACKLOG);
    } finally {
      b.cleanup();
    }
  });
});
