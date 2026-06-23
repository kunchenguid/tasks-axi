import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/guard-generated-files.sh", import.meta.url),
);

type CommandError = Error & {
  status?: number;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
};

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tasks-axi-guard-"));
  repos.push(repo);
  execFileSync("git", ["init", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  });
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function runGuard(
  repo: string,
  base: string,
  head: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [script, base, head], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const commandError = error as CommandError;
    return {
      status: commandError.status ?? 1,
      stdout: outputToString(commandError.stdout),
      stderr: outputToString(commandError.stderr),
    };
  }
}

function outputToString(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

describe("guard-generated-files workflow helper", () => {
  it("allows the one-time addition of a generated manifest", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "seed\n");
    const base = commit(repo, "seed");
    writeFileSync(join(repo, ".release-please-manifest.json"), "{}\n");
    const head = commit(repo, "add manifest");

    const result = runGuard(repo, base, head);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("rejects deleting an existing generated file", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "seed\n");
    writeFileSync(join(repo, ".release-please-manifest.json"), "{}\n");
    const base = commit(repo, "seed");
    rmSync(join(repo, ".release-please-manifest.json"));
    const head = commit(repo, "delete manifest");

    const result = runGuard(repo, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".release-please-manifest.json");
  });

  it("rejects renaming an existing generated file", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
    const base = commit(repo, "seed changelog");
    git(repo, ["mv", "CHANGELOG.md", "NOTES.md"]);
    const head = commit(repo, "rename changelog");

    const result = runGuard(repo, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CHANGELOG.md");
  });

  it("rejects copying an existing file into a generated path", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), '{"."":"0.1.0"}\n');
    const base = commit(repo, "seed");
    writeFileSync(
      join(repo, ".release-please-manifest.json"),
      '{"."":"0.1.0"}\n',
    );
    const head = commit(repo, "copy manifest");

    const result = runGuard(repo, base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".release-please-manifest.json");
  });
});
