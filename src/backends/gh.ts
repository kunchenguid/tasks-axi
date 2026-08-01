import { spawn } from "node:child_process";
import { AxiError } from "../errors.js";

/**
 * Thin exec adapter over the GitHub CLI (design §6): zero new dependencies,
 * auth fully delegated to `gh auth login`, stderr mapped to structured errors.
 *
 * Request bodies travel over stdin (`--input -`), never through shell command
 * substitution, so payload bytes (including trailing newlines) reach GitHub
 * exactly as composed — the E1 round-trip experiment showed `$(cat file)`
 * strips a trailing newline before the request is made.
 */

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable process runner: `gh <args>` with an optional stdin payload. */
export type GhExec = (args: string[], stdin?: string) => Promise<GhExecResult>;

/** One issue as the store consumes it, normalized across GraphQL and REST. */
export interface IssueData {
  number: number;
  /**
   * The global issue id (GraphQL `databaseId`, REST `id`). Sub-issue write
   * endpoints take this id in `sub_issue_id`, never the issue number.
   */
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** Lowercase close reason (completed | not_planned | duplicate | reopened), or null. */
  stateReason: string | null;
  labels: string[];
  /** The native sub-issue parent's issue number, or null when top-level. */
  parentNumber: number | null;
  createdAt: string;
  closedAt: string | null;
  updatedAt: string;
  url: string;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned";
}

export interface LabelPatch {
  add: string[];
  remove: string[];
}

/** The typed GitHub surface the store consumes; faked wholesale in tests. */
export interface GhIssuesClient {
  readonly repo: string;
  /** Every issue (open and closed) in one paginated GraphQL read. */
  listIssues(): Promise<IssueData[]>;
  createIssue(title: string, body: string): Promise<IssueData>;
  updateIssue(number: number, patch: IssuePatch): Promise<void>;
  updateLabels(number: number, patch: LabelPatch): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
  /**
   * Link `subIssueId` (a global issue id) under parent `number` via the native
   * sub-issues API. `replaceParent` reparents an already-linked sub-issue.
   */
  addSubIssue(
    number: number,
    subIssueId: number,
    replaceParent?: boolean,
  ): Promise<void>;
  /** Unlink `subIssueId` (a global issue id) from parent `number`. */
  removeSubIssue(number: number, subIssueId: number): Promise<void>;
}

export const execGh: GhExec = (args, stdin) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(stdin ?? "");
  });

const ghErrorStderr = new WeakMap<Error, string>();

function withGhStderr(error: AxiError, stderr: string): AxiError {
  ghErrorStderr.set(error, stderr);
  return error;
}

function ghFailure(repo: string, stderr: string): AxiError {
  const detail = stderr.trim().split("\n")[0] ?? "";
  if (/HTTP 401|not logged in|gh auth login/i.test(stderr)) {
    return withGhStderr(
      new AxiError(
        "GitHub authentication failed for the github backend",
        "UNKNOWN",
        ["Run `gh auth login`, then retry"],
      ),
      stderr,
    );
  }
  if (/HTTP 404|Could not resolve to a Repository/i.test(stderr)) {
    return withGhStderr(
      new AxiError(
        `GitHub repository or resource not found (repo "${repo}")${detail ? `: ${detail}` : ""}`,
        "NOT_FOUND",
        ['Check `[github] repo = "owner/name"` in .tasks.toml and your access'],
      ),
      stderr,
    );
  }
  return withGhStderr(
    new AxiError(
      `GitHub CLI call failed${detail ? `: ${detail}` : ""}`,
      "UNKNOWN",
      ["Retry, or run the failing `gh` call manually to inspect the error"],
    ),
    stderr,
  );
}

function ghErrorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return `${error.message}\n${ghErrorStderr.get(error) ?? ""}`;
}

function isMissingLabelError(error: unknown): boolean {
  return /label.*(?:does not exist|not found|missing|invalid)|(?:does not exist|not found|missing).*label/i.test(
    ghErrorText(error),
  );
}

function isExistingLabelError(error: unknown): boolean {
  return /already[_ ]exists/i.test(ghErrorText(error));
}

const LIST_ISSUES_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number databaseId title body state stateReason
        createdAt closedAt updatedAt url
        labels(first: 100) { nodes { name } }
        parent { number }
      }
    }
  }
}`;

interface GraphqlIssueNode {
  number: number;
  databaseId: number;
  parent: { number: number } | null;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  createdAt: string;
  closedAt: string | null;
  updatedAt: string;
  url: string;
  labels: { nodes: Array<{ name: string }> };
}

interface GraphqlIssuesPage {
  data?: {
    repository: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GraphqlIssueNode[];
      };
    } | null;
  };
}

interface RestIssue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  created_at: string;
  closed_at: string | null;
  updated_at: string;
  html_url: string;
  labels: Array<{ name: string } | string>;
}

function fromGraphqlNode(node: GraphqlIssueNode): IssueData {
  return {
    number: node.number,
    id: node.databaseId,
    title: node.title,
    body: node.body,
    state: node.state === "CLOSED" ? "closed" : "open",
    stateReason: node.stateReason ? node.stateReason.toLowerCase() : null,
    labels: node.labels.nodes.map((label) => label.name),
    parentNumber: node.parent?.number ?? null,
    createdAt: node.createdAt,
    closedAt: node.closedAt,
    updatedAt: node.updatedAt,
    url: node.url,
  };
}

function fromRestIssue(issue: RestIssue): IssueData {
  return {
    number: issue.number,
    id: issue.id,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    stateReason: issue.state_reason ? issue.state_reason.toLowerCase() : null,
    labels: issue.labels.map((label) =>
      typeof label === "string" ? label : label.name,
    ),
    // The REST issue payload carries no parent; only the GraphQL read does.
    // REST responses are consumed for freshly created issues, which start
    // top-level, so null is exact here.
    parentNumber: null,
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };
}

export function createGhIssuesClient(
  repo: string,
  exec: GhExec = execGh,
): GhIssuesClient {
  const run = async (args: string[], stdin?: string): Promise<string> => {
    let result: GhExecResult;
    try {
      result = await exec(args, stdin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new AxiError(
          "GitHub CLI (gh) not found; the github backend requires it",
          "UNKNOWN",
          [
            "Install the GitHub CLI (https://cli.github.com), then `gh auth login`",
          ],
        );
      }
      throw error;
    }
    if (result.code !== 0) throw ghFailure(repo, result.stderr);
    return result.stdout;
  };

  const rest = async (
    method: string,
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<string> => {
    const args = ["api", "--method", method, path];
    if (payload !== undefined) args.push("--input", "-");
    return run(
      args,
      payload !== undefined ? JSON.stringify(payload) : undefined,
    );
  };

  return {
    repo,

    async listIssues(): Promise<IssueData[]> {
      const [owner, name] = repo.split("/");
      const issues: IssueData[] = [];
      let cursor: string | null = null;
      for (;;) {
        const args = [
          "api",
          "graphql",
          "-f",
          `query=${LIST_ISSUES_QUERY}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ];
        if (cursor !== null) args.push("-f", `cursor=${cursor}`);
        const page = JSON.parse(await run(args)) as GraphqlIssuesPage;
        const repository = page.data?.repository;
        if (!repository) {
          throw new AxiError(
            `GitHub repository "${repo}" not found or not accessible`,
            "NOT_FOUND",
            [
              'Check `[github] repo = "owner/name"` in .tasks.toml and your access',
            ],
          );
        }
        issues.push(...repository.issues.nodes.map(fromGraphqlNode));
        if (!repository.issues.pageInfo.hasNextPage) return issues;
        cursor = repository.issues.pageInfo.endCursor;
      }
    },

    async createIssue(title: string, body: string): Promise<IssueData> {
      const stdout = await rest("POST", `repos/${repo}/issues`, {
        title,
        body,
      });
      return fromRestIssue(JSON.parse(stdout) as RestIssue);
    },

    async updateIssue(number: number, patch: IssuePatch): Promise<void> {
      await rest("PATCH", `repos/${repo}/issues/${number}`, { ...patch });
    },

    async updateLabels(number: number, patch: LabelPatch): Promise<void> {
      if (patch.add.length > 0) {
        const applyLabels = () =>
          rest("POST", `repos/${repo}/issues/${number}/labels`, {
            labels: patch.add,
          });
        try {
          await applyLabels();
        } catch (error) {
          if (!isMissingLabelError(error)) throw error;
          for (const label of patch.add) {
            try {
              await rest("POST", `repos/${repo}/labels`, { name: label });
            } catch (createError) {
              if (!isExistingLabelError(createError)) throw createError;
            }
          }
          await applyLabels();
        }
      }
      for (const label of patch.remove) {
        try {
          await rest(
            "DELETE",
            `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
          );
        } catch (error) {
          if (!(error instanceof AxiError) || error.code !== "NOT_FOUND") {
            throw error;
          }
        }
      }
    },

    async addComment(number: number, body: string): Promise<void> {
      await rest("POST", `repos/${repo}/issues/${number}/comments`, { body });
    },

    async addSubIssue(
      number: number,
      subIssueId: number,
      replaceParent = false,
    ): Promise<void> {
      await rest("POST", `repos/${repo}/issues/${number}/sub_issues`, {
        sub_issue_id: subIssueId,
        ...(replaceParent ? { replace_parent: true } : {}),
      });
    },

    async removeSubIssue(number: number, subIssueId: number): Promise<void> {
      // Singular path per the sub-issues API: DELETE .../sub_issue with the
      // global id in the body.
      await rest("DELETE", `repos/${repo}/issues/${number}/sub_issue`, {
        sub_issue_id: subIssueId,
      });
    },
  };
}
