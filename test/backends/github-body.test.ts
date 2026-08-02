import { describe, expect, it } from "vitest";
import {
  BLOCK_END,
  BLOCK_START,
  composeIssueBody,
  parseIssueBody,
  renderManagedBlock,
  type ManagedFields,
} from "../../src/backends/github-body.js";

const REF = "issue #7";

/** The design §4.1 example block, byte-for-byte (also the E1 probe body). */
const DESIGN_BLOCK = [
  BLOCK_START,
  "(id: homemux-h7) (state: in-flight) (kind: secondmate) (repo: firstmate) (priority: 1) (hold: captain decision pending) (hold-kind: captain) (hold-until: 2026-08-01)",
  "blocked-by: fix-login-k3 - waits on the login refactor",
  BLOCK_END,
].join("\n");

const DESIGN_BODY = `E1 probe issue for the tasks-axi GitHub backend.

This prose paragraph is the human body.

${DESIGN_BLOCK}`;

describe("parseIssueBody", () => {
  it("parses the design §4.1 example, prose and every field", () => {
    const parsed = parseIssueBody(DESIGN_BODY, REF);
    expect(parsed.prose).toBe(
      "E1 probe issue for the tasks-axi GitHub backend.\n\nThis prose paragraph is the human body.",
    );
    expect(parsed.managed).toEqual({
      id: "homemux-h7",
      inFlight: true,
      kind: "secondmate",
      repo: "firstmate",
      priority: 1,
      hold: {
        reason: "captain decision pending",
        kind: "captain",
        until: "2026-08-01",
      },
      deps: [
        {
          type: "blocked-by",
          id: "fix-login-k3",
          reason: "waits on the login refactor",
        },
      ],
    });
  });

  it("treats a body without the versioned marker as unmanaged", () => {
    expect(parseIssueBody("just a human issue\n", REF)).toEqual({
      prose: "just a human issue",
    });
    expect(parseIssueBody("", REF)).toEqual({ prose: "" });
  });

  it("keeps prose written after the block and drops boundary blanks", () => {
    const parsed = parseIssueBody(
      `above\n\n${BLOCK_START}\n(id: a-1)\n${BLOCK_END}\n\nbelow\n`,
      REF,
    );
    expect(parsed.prose).toBe("above\n\nbelow");
    expect(parsed.managed).toEqual({ id: "a-1", inFlight: false, deps: [] });
  });

  it("reads a bare tag line as a queued task (state tag absent means queued)", () => {
    const parsed = parseIssueBody(
      `${BLOCK_START}\n(id: q-1)\n${BLOCK_END}`,
      REF,
    );
    expect(parsed.managed?.inFlight).toBe(false);
  });

  it("accepts hand-reordered tags and an explicit (since) override", () => {
    const parsed = parseIssueBody(
      `${BLOCK_START}\n(kind: ship) (id: x-1) (since 2026-01-05)\n${BLOCK_END}`,
      REF,
    );
    expect(parsed.managed).toEqual({
      id: "x-1",
      inFlight: false,
      kind: "ship",
      created: "2026-01-05",
      deps: [],
    });
  });

  const mangled: Array<[string, string, string]> = [
    [
      "missing id",
      `${BLOCK_START}\n(state: in-flight)\n${BLOCK_END}`,
      "missing (id:) tag",
    ],
    [
      "empty block",
      `${BLOCK_START}\n${BLOCK_END}`,
      "missing the (id:) tag line",
    ],
    [
      "invalid id",
      `${BLOCK_START}\n(id: bad id)\n${BLOCK_END}`,
      'invalid task id "bad id"',
    ],
    [
      "duplicate id tags",
      `${BLOCK_START}\n(id: a-1) (id: b-2)\n${BLOCK_END}`,
      "duplicate (id:) tag",
    ],
    [
      "unknown state",
      `${BLOCK_START}\n(id: a-1) (state: queued)\n${BLOCK_END}`,
      'unknown (state:) value "queued"',
    ],
    [
      "leftover content",
      `${BLOCK_START}\n(id: a-1) stray words\n${BLOCK_END}`,
      'unrecognized content "stray words"',
    ],
    [
      "bad priority",
      `${BLOCK_START}\n(id: a-1) (priority: 9)\n${BLOCK_END}`,
      'unrecognized content "(priority: 9)"',
    ],
    [
      "unknown hold-kind",
      `${BLOCK_START}\n(id: a-1) (hold-kind: bogus)\n${BLOCK_END}`,
      'unrecognized content "(hold-kind: bogus)"',
    ],
    [
      "closure tag",
      `${BLOCK_START}\n(id: a-1) (done 2026-07-01)\n${BLOCK_END}`,
      "closure tags do not belong in the block",
    ],
    [
      "public-followup kind",
      `${BLOCK_START}\n(id: a-1) (kind: public-followup)\n${BLOCK_END}`,
      "public-followup obligations are not supported",
    ],
    ...[
      ["repo", "(repo: one) (repo: two)"],
      ["kind", "(kind: ship) (kind: docs)"],
      ["priority", "(priority: 1) (priority: 2)"],
      ["since", "(since 2026-01-01) (since 2026-01-02)"],
      ["hold", "(hold: one) (hold: two)"],
      ["hold-kind", "(hold-kind: captain) (hold-kind: external)"],
      ["hold-until", "(hold-until: 2026-01-01) (hold-until: 2026-01-02)"],
    ].map(([name, tags]): [string, string, string] => [
      `duplicate ${name} tags`,
      `${BLOCK_START}\n(id: a-1) ${tags}\n${BLOCK_END}`,
      `duplicate (${name}:) tag`,
    ]),
    [
      "garbage dep line",
      `${BLOCK_START}\n(id: a-1)\nnot a dep\n${BLOCK_END}`,
      'unrecognized dependency line "not a dep"',
    ],
    [
      "tagged dep line",
      `${BLOCK_START}\n(id: a-1)\nblocked-by: b-2 (repo: x)\n${BLOCK_END}`,
      "unrecognized dependency line",
    ],
    [
      "duplicate start markers",
      `${BLOCK_START}\n(id: a-1)\n${BLOCK_END}\n${BLOCK_START}\n(id: b-2)\n${BLOCK_END}`,
      "duplicate start markers",
    ],
    ["missing end marker", `${BLOCK_START}\n(id: a-1)`, "missing end marker"],
    [
      "orphaned end marker",
      `prose\n${BLOCK_END}`,
      "end marker without a start marker",
    ],
    [
      "inline start marker",
      `prose ${BLOCK_START}\n(id: a-1)\n${BLOCK_END}`,
      "not on its own line",
    ],
  ];

  for (const [name, body, detail] of mangled) {
    it(`fails loud on a mangled block: ${name}`, () => {
      expect(() => parseIssueBody(body, REF)).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: expect.stringContaining(detail) as string,
        }) as Error,
      );
      expect(() => parseIssueBody(body, REF)).toThrowError(REF);
    });
  }
});

describe("renderManagedBlock", () => {
  const FULL: ManagedFields = {
    id: "homemux-h7",
    inFlight: true,
    kind: "secondmate",
    repo: "firstmate",
    priority: 1,
    hold: {
      reason: "captain decision pending",
      kind: "captain",
      until: "2026-08-01",
    },
    deps: [
      {
        type: "blocked-by",
        id: "fix-login-k3",
        reason: "waits on the login refactor",
      },
      { type: "parent", id: "homemux-root" },
    ],
  };

  it("renders canonically and round-trips through parse", () => {
    const block = renderManagedBlock(FULL);
    expect(block).toBe(
      [
        BLOCK_START,
        "(id: homemux-h7) (state: in-flight) (repo: firstmate) (kind: secondmate) (priority: 1) (hold: captain decision pending) (hold-kind: captain) (hold-until: 2026-08-01)",
        "blocked-by: fix-login-k3 - waits on the login refactor",
        "parent: homemux-root",
        BLOCK_END,
      ].join("\n"),
    );
    const reparsed = parseIssueBody(block, REF);
    expect(reparsed.managed).toEqual(FULL);
    expect(reparsed.prose).toBe("");
  });

  it("normalizes the design example to canonical form idempotently", () => {
    const parsed = parseIssueBody(DESIGN_BODY, REF);
    const rendered = composeIssueBody(
      parsed.prose,
      renderManagedBlock(parsed.managed as ManagedFields),
    );
    const reparsed = parseIssueBody(rendered, REF);
    expect(reparsed.managed).toEqual(parsed.managed);
    expect(reparsed.prose).toBe(parsed.prose);
    // A second render is byte-identical: canonicalization is idempotent.
    expect(
      composeIssueBody(
        reparsed.prose,
        renderManagedBlock(reparsed.managed as ManagedFields),
      ),
    ).toBe(rendered);
  });

  it("renders a minimal queued block as the id line alone", () => {
    expect(renderManagedBlock({ id: "q-1", inFlight: false, deps: [] })).toBe(
      `${BLOCK_START}\n(id: q-1)\n${BLOCK_END}`,
    );
  });

  it("emits (since) only when an explicit created override is present", () => {
    expect(
      renderManagedBlock({
        id: "m-1",
        inFlight: false,
        created: "2026-01-05",
        deps: [],
      }),
    ).toContain("(id: m-1) (since 2026-01-05)");
  });
});

describe("composeIssueBody", () => {
  it("puts the block at the foot under one blank line", () => {
    expect(composeIssueBody("prose", "BLOCK")).toBe("prose\n\nBLOCK");
    expect(composeIssueBody("", "BLOCK")).toBe("BLOCK");
  });

  it.each([BLOCK_START, BLOCK_END])(
    "rejects the reserved marker line %s in prose",
    (marker) => {
      expect(() =>
        composeIssueBody(`before\n${marker}\nafter`, "BLOCK"),
      ).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: expect.stringContaining("reserved tasks-axi marker lines"),
        }) as Error,
      );
    },
  );
});
