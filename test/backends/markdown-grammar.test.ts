import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type BacklogDoc,
  buildProse,
  deriveLinks,
  leadingKind,
  parseBacklog,
  renderBacklog,
  renderTaskLines,
} from "../../src/backends/markdown-grammar.js";
import type { Task } from "../../src/model.js";
import {
  FIRSTMATE_FIXTURE,
  FIXTURE,
  MULTI_REASON_FIXTURE,
} from "../helpers.js";

function markAllDirty(doc: BacklogDoc): void {
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind === "task") entry.dirty = true;
    }
  }
}

function tasksOf(doc: BacklogDoc): Task[] {
  const out: Task[] = [];
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind === "task") out.push(entry.task);
    }
  }
  return out;
}

function toCrlf(src: string): string {
  return src.replace(/\r?\n/g, "\r\n");
}

describe("markdown grammar", () => {
  describe("byte-exact round-trip", () => {
    it("render(parse(src)) === src on the corpus fixture", () => {
      expect(renderBacklog(parseBacklog(FIXTURE))).toBe(FIXTURE);
    });

    it("round-trips CRLF fixtures while still recognizing tasks", () => {
      const src = toCrlf(FIXTURE);
      const doc = parseBacklog(src);
      const tasks = tasksOf(doc);
      const ids = tasks.map((t) => t.id);

      expect(renderBacklog(doc)).toBe(src);
      expect(ids).toContain("cert-cleanup");
      expect(ids).toContain("lease-core-t4");
      expect(
        tasks.find((t) => t.id === "multi-line-w8")?.body,
      ).not.toContain("\r");
    });

    it("round-trips an empty file", () => {
      expect(renderBacklog(parseBacklog(""))).toBe("");
    });

    it("round-trips a file with no trailing newline", () => {
      const src = "# Backlog\n\n## Queued\n- [ ] a-task - do a thing";
      expect(renderBacklog(parseBacklog(src))).toBe(src);
    });

    it("round-trips a file that is only a heading", () => {
      const src = "# Backlog\n";
      expect(renderBacklog(parseBacklog(src))).toBe(src);
    });

    // Real-corpus coverage: byte-exact on firstmate's actual backlog when present
    // (the file is not committed to this public package, so this skips in CI).
    const realPath =
      "/Users/kunchen/github/kunchenguid/firstmate/data/backlog.md";
    it.skipIf(!existsSync(realPath))(
      "render(parse(src)) === src on the real backlog",
      () => {
        const src = readFileSync(realPath, "utf8");
        expect(renderBacklog(parseBacklog(src))).toBe(src);
      },
    );
  });

  describe("parse", () => {
    it("recognizes the three sections and their states", () => {
      const doc = parseBacklog(FIXTURE);
      expect(doc.sections.map((s) => s.state)).toEqual([
        "in_flight",
        "queued",
        "done",
      ]);
    });

    it("recognizes slug ids and leaves odd/annotated lines free-form", () => {
      const ids = tasksOf(parseBacklog(FIXTURE)).map((t) => t.id);
      expect(ids).toContain("owns-widget-h7");
      expect(ids).toContain("lease-adopt");
      expect(ids).toContain("design-scout-d4");
      // "go-live (CAPTAIN-GATED) - ..." and "PR #31 (contributor) - ..." are free-form.
      expect(ids).not.toContain("go-live");
      expect(ids).not.toContain("PR");
    });

    it("extracts repo, blocked-by deps, and a leading-word kind", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "lease-adopt",
      )!;
      expect(task.repo).toBe("acme");
      expect(task.deps).toEqual([{ type: "blocked-by", id: "lease-core-t4" }]);
    });

    it("reads `(local + repo: X)` as repo X", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "release-validation",
      )!;
      expect(task.repo).toBe("builder");
    });

    it("captures only the trailing date tag, leaving mid-sentence ones in prose", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "design-scout-d4",
      )!;
      expect(task.closed).toBe("2026-06-22");
      expect(task.kind).toBe("scout");
      // the mid-sentence "(reported 2026-06-22)" stays in the prose title
      expect(task.title).toContain("report.md (reported 2026-06-22):");
    });

    it("extracts a trailing priority tag", () => {
      const doc = parseBacklog(
        "# Backlog\n\n## Queued\n- [ ] prio-q1 - important work (priority: 2) (since 2026-07-01)\n",
      );
      const task = tasksOf(doc)[0];
      expect(task.title).toBe("important work");
      expect(task.priority).toBe(2);
      expect(task.created).toBe("2026-07-01");
    });

    it("reads indented continuation lines as the body", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "multi-line-w8",
      )!;
      expect(task.body).toContain("Follow-up note added later");
      expect(task.body).toContain("Second continuation line");
    });

    it("derives typed links from prose", () => {
      const links = deriveLinks(
        "shipped https://github.com/o/r/pull/42 see data/x/report.md",
      );
      expect(links).toContainEqual({
        kind: "pr",
        url: "https://github.com/o/r/pull/42",
      });
      expect(links).toContainEqual({ kind: "report", url: "data/x/report.md" });
    });
  });

  describe("canonical render", () => {
    it("orders tags as deps, repo, kind, date", () => {
      const task: Task = {
        id: "x-q1",
        title: "do a thing",
        state: "queued",
        kind: "ship",
        repo: "acme",
        priority: 2,
        links: [],
        deps: [{ type: "blocked-by", id: "y-t1" }],
        created: "2026-07-01",
      };
      expect(buildProse(task)).toBe(
        "do a thing blocked-by: y-t1 (repo: acme) (kind: ship) (priority: 2) (since 2026-07-01)",
      );
    });

    it("omits the kind tag when the prose already leads with the kind word", () => {
      const task: Task = {
        id: "x-q1",
        title: "SHIP a thing",
        state: "queued",
        kind: "ship",
        links: [],
        deps: [],
      };
      expect(buildProse(task)).toBe("SHIP a thing");
    });

    it("renders a done task with the link-derived closure verb", () => {
      const task: Task = {
        id: "x-q1",
        title: "shipped it https://github.com/o/r/pull/9",
        state: "done",
        links: [{ kind: "pr", url: "https://github.com/o/r/pull/9" }],
        deps: [],
        closed: "2026-07-01",
      };
      expect(renderTaskLines(task)).toEqual([
        "- [x] x-q1 - shipped it https://github.com/o/r/pull/9 (merged 2026-07-01)",
      ]);
    });

    it("renders the body as indented continuation lines", () => {
      const task: Task = {
        id: "x-q1",
        title: "title",
        state: "queued",
        body: "line one\nline two",
        links: [],
        deps: [],
      };
      expect(renderTaskLines(task)).toEqual([
        "- [ ] x-q1 - title",
        "  line one",
        "  line two",
      ]);
    });

    it("normalization is idempotent: normalize(normalize(x)) === normalize(x)", () => {
      const doc1 = parseBacklog(FIXTURE);
      markAllDirty(doc1);
      const once = renderBacklog(doc1);
      const doc2 = parseBacklog(once);
      markAllDirty(doc2);
      expect(renderBacklog(doc2)).toBe(once);
    });
  });

  // The two firstmate-adoption blockers: the `- [ ]` checkbox in-flight form and
  // the `blocked-by: <id> - <reason>` dependency edge.
  describe("firstmate format interop", () => {
    it("render(parse(src)) === src on the firstmate-shaped fixture", () => {
      expect(renderBacklog(parseBacklog(FIRSTMATE_FIXTURE))).toBe(
        FIRSTMATE_FIXTURE,
      );
    });

    it("parses the `- [ ] <id>` checkbox in-flight form firstmate uses", () => {
      const task = tasksOf(parseBacklog(FIRSTMATE_FIXTURE)).find(
        (t) => t.id === "fix-login-k3",
      )!;
      expect(task.state).toBe("in_flight");
    });

    it("still parses the legacy `- **<id>**` in-flight form", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "owns-widget-h7",
      )!;
      expect(task.state).toBe("in_flight");
    });

    it("normalizes in-flight items to `- [ ]`, never `- **id**`", () => {
      const doc = parseBacklog(FIXTURE); // legacy bold in-flight items
      markAllDirty(doc);
      const out = renderBacklog(doc);
      expect(out).toMatch(/## In flight[\s\S]*- \[ \] owns-widget-h7/);
      expect(out).not.toContain("**owns-widget-h7**");
    });

    it("parses `blocked-by: <id> - <reason>`, keeping both id and reason", () => {
      const task = tasksOf(parseBacklog(FIRSTMATE_FIXTURE)).find(
        (t) => t.id === "add-tests-q7",
      )!;
      expect(task.title).toBe("one line");
      expect(task.deps).toEqual([
        {
          type: "blocked-by",
          id: "fix-login-k3",
          reason: "waits on the login refactor",
        },
      ]);
    });

    it("still parses a bare `blocked-by: <id>` (no reason)", () => {
      const task = tasksOf(parseBacklog(FIXTURE)).find(
        (t) => t.id === "lease-adopt",
      )!;
      expect(task.deps).toEqual([{ type: "blocked-by", id: "lease-core-t4" }]);
    });

    it("renders a blocked-by dep with its free-text reason", () => {
      const task: Task = {
        id: "add-tests-q7",
        title: "one line",
        state: "queued",
        repo: "app",
        links: [],
        deps: [
          {
            type: "blocked-by",
            id: "fix-login-k3",
            reason: "waits on the login refactor",
          },
        ],
      };
      // A reason-bearing edge renders last (after the parentheticals), exactly
      // as firstmate writes it.
      expect(buildProse(task)).toBe(
        "one line (repo: app) blocked-by: fix-login-k3 - waits on the login refactor",
      );
    });

    it("round-trips the blocked-by reason through a normalize cycle", () => {
      const doc = parseBacklog(FIRSTMATE_FIXTURE);
      markAllDirty(doc);
      const once = renderBacklog(doc);
      expect(once).toContain(
        "blocked-by: fix-login-k3 - waits on the login refactor",
      );
      const dep = tasksOf(parseBacklog(once)).find(
        (t) => t.id === "add-tests-q7",
      )!.deps[0];
      expect(dep).toEqual({
        type: "blocked-by",
        id: "fix-login-k3",
        reason: "waits on the login refactor",
      });
    });

    it("parses multiple reason-bearing blockers without folding the later edge", () => {
      const doc = parseBacklog(MULTI_REASON_FIXTURE);
      const task = tasksOf(doc).find((t) => t.id === "target-q1")!;
      expect(task.title).toBe("work");
      expect(task.deps).toEqual([
        {
          type: "blocked-by",
          id: "blocker-a",
          reason: "first blocker done",
        },
        {
          type: "blocked-by",
          id: "blocker-b",
          reason: "waits on second blocker",
        },
      ]);

      markAllDirty(doc);
      const once = renderBacklog(doc);
      const normalized = parseBacklog(once);
      const reparsed = tasksOf(normalized).find((t) => t.id === "target-q1")!;
      expect(reparsed.deps).toEqual(task.deps);
      markAllDirty(normalized);
      expect(renderBacklog(normalized)).toBe(once);
    });

    it("does not derive task links from dependency reason text", () => {
      const src =
        "# Backlog\n\n## Queued\n- [ ] target-q1 - work blocked-by: blocker-a - see https://example.com/doc\n";
      const task = tasksOf(parseBacklog(src)).find(
        (t) => t.id === "target-q1",
      )!;
      expect(task.title).toBe("work");
      expect(task.links).toEqual([]);
      expect(task.deps).toEqual([
        {
          type: "blocked-by",
          id: "blocker-a",
          reason: "see https://example.com/doc",
        },
      ]);
    });
  });

  describe("leadingKind", () => {
    it("maps the firstmate leading words", () => {
      expect(leadingKind("SHIP a thing")).toBe("ship");
      expect(leadingKind("SCOUT - report")).toBe("scout");
      expect(leadingKind("DOCS-ONLY change")).toBe("docs");
      expect(leadingKind("PERSISTENT SECONDMATE owns it")).toBe("secondmate");
      expect(leadingKind("just prose")).toBeUndefined();
    });
  });
});
