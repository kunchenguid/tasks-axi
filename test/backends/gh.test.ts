import { describe, expect, it } from "vitest";
import {
  createGhIssuesClient,
  type GhExec,
  type GhExecResult,
} from "../../src/backends/gh.js";
import { AxiError } from "../../src/errors.js";

interface RecordedCall {
  args: string[];
  stdin?: string;
}

function fakeExec(
  respond: (call: RecordedCall) => GhExecResult,
  calls: RecordedCall[] = [],
): GhExec {
  return (args, stdin) => {
    const call: RecordedCall = { args, ...(stdin !== undefined ? { stdin } : {}) };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
}

const ok = (stdout: string): GhExecResult => ({ stdout, stderr: "", code: 0 });

function graphqlPage(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        issues: { pageInfo: { hasNextPage, endCursor }, nodes },
      },
    },
  });
}

const NODE = {
  number: 7,
  title: "probe",
  body: "prose",
  state: "CLOSED",
  stateReason: "NOT_PLANNED",
  createdAt: "2026-07-01T10:00:00Z",
  closedAt: "2026-07-02T10:00:00Z",
  updatedAt: "2026-07-02T10:00:00Z",
  url: "https://github.com/o/r/issues/7",
  labels: { nodes: [{ name: "held" }] },
};

describe("createGhIssuesClient", () => {
  it("lists issues across GraphQL pages and normalizes fields", async () => {
    const calls: RecordedCall[] = [];
    const client = createGhIssuesClient(
      "o/r",
      fakeExec(
        (call) =>
          call.args.some((a) => a.startsWith("cursor="))
            ? ok(graphqlPage([{ ...NODE, number: 8, state: "OPEN", stateReason: null }], false, null))
            : ok(graphqlPage([NODE], true, "CUR")),
        calls,
      ),
    );

    const issues = await client.listIssues();
    expect(issues.map((i) => i.number)).toEqual([7, 8]);
    expect(issues[0]).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
      labels: ["held"],
      closedAt: "2026-07-02T10:00:00Z",
    });
    expect(issues[1]).toMatchObject({ state: "open", stateReason: null });

    expect(calls).toHaveLength(2);
    expect(calls[0].args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0].args).toContain("owner=o");
    expect(calls[0].args).toContain("name=r");
    expect(calls[1].args).toContain("cursor=CUR");
  });

  it("fails loud when the repository does not resolve", async () => {
    const client = createGhIssuesClient(
      "o/missing",
      fakeExec(() => ok(JSON.stringify({ data: { repository: null } }))),
    );
    await expect(client.listIssues()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: 'GitHub repository "o/missing" not found or not accessible',
    });
  });

  it("creates an issue with a stdin JSON payload and maps the REST response", async () => {
    const calls: RecordedCall[] = [];
    const client = createGhIssuesClient(
      "o/r",
      fakeExec(
        () =>
          ok(
            JSON.stringify({
              number: 12,
              title: "t",
              body: "b\n",
              state: "open",
              state_reason: null,
              created_at: "2026-07-30T00:00:00Z",
              closed_at: null,
              updated_at: "2026-07-30T00:00:00Z",
              html_url: "https://github.com/o/r/issues/12",
              labels: [],
            }),
          ),
        calls,
      ),
    );

    const issue = await client.createIssue("t", "b\n");
    expect(issue).toMatchObject({ number: 12, body: "b\n", state: "open" });
    expect(calls[0].args).toEqual([
      "api",
      "--method",
      "POST",
      "repos/o/r/issues",
      "--input",
      "-",
    ]);
    // The payload travels over stdin so body bytes (incl. the trailing
    // newline) are never mangled by shell substitution (E1 leg 3 caveat).
    expect(JSON.parse(calls[0].stdin ?? "")).toEqual({ title: "t", body: "b\n" });
  });

  it("patches issues and mutates only requested labels through REST", async () => {
    const calls: RecordedCall[] = [];
    const client = createGhIssuesClient("o/r", fakeExec(() => ok("{}"), calls));

    await client.updateIssue(3, { state: "closed", state_reason: "completed" });
    await client.updateLabels(3, {
      add: ["in-flight", "held"],
      remove: ["blocked state"],
    });
    await client.addComment(3, "archived body");

    expect(calls.map((c) => c.args.slice(1, 4))).toEqual([
      ["--method", "PATCH", "repos/o/r/issues/3"],
      ["--method", "POST", "repos/o/r/issues/3/labels"],
      [
        "--method",
        "DELETE",
        "repos/o/r/issues/3/labels/blocked%20state",
      ],
      ["--method", "POST", "repos/o/r/issues/3/comments"],
    ]);
    expect(JSON.parse(calls[1].stdin ?? "")).toEqual({
      labels: ["in-flight", "held"],
    });
    expect(calls[2].stdin).toBeUndefined();
  });

  it("maps a missing gh binary to a structured install hint", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
    });
    const client = createGhIssuesClient("o/r", () => Promise.reject(enoent));
    await expect(client.listIssues()).rejects.toMatchObject({
      code: "UNKNOWN",
      message: "GitHub CLI (gh) not found; the github backend requires it",
    });
  });

  it("maps auth and not-found stderr to structured errors", async () => {
    const authClient = createGhIssuesClient("o/r", () =>
      Promise.resolve({
        stdout: "",
        stderr: "HTTP 401: authentication required (gh auth login)",
        code: 1,
      }),
    );
    await expect(authClient.listIssues()).rejects.toMatchObject({
      code: "UNKNOWN",
      message: "GitHub authentication failed for the github backend",
    });

    const missingClient = createGhIssuesClient("o/r", () =>
      Promise.resolve({ stdout: "", stderr: "HTTP 404: Not Found", code: 1 }),
    );
    await expect(missingClient.updateIssue(1, { state: "open" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const otherClient = createGhIssuesClient("o/r", () =>
      Promise.resolve({ stdout: "", stderr: "boom: broke", code: 1 }),
    );
    const error = await otherClient.listIssues().catch((e: AxiError) => e);
    expect(error).toBeInstanceOf(AxiError);
    expect((error as AxiError).message).toContain("boom: broke");
  });
});
