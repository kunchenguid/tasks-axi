import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubStore } from "../src/backends/github.js";
import { MarkdownStore } from "../src/backends/markdown.js";
import { resolveTasksContext } from "../src/context.js";

let dir: string;
let home: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-home-"));
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTasksContext", () => {
  it("builds a markdown store by default", () => {
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    expect(ctx.store).toBeInstanceOf(MarkdownStore);
  });

  it("builds a github store when the backend and repo are configured", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "github"\n[github]\nrepo = "owner/name"\n',
    );
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    expect(ctx.store).toBeInstanceOf(GithubStore);
    expect(ctx.store.capabilities()).toMatchObject({
      backend: "github",
      publicFollowups: false,
      prune: false,
      comments: true,
    });
  });

  it("requires a repo for the github backend", () => {
    expect(() =>
      resolveTasksContext({ cwd: dir, home, env: {}, backend: "github" }),
    ).toThrow(/requires a repository/);
  });

  it("names the supported backends for an unknown one", () => {
    expect(() =>
      resolveTasksContext({ cwd: dir, home, env: {}, backend: "sqlite" }),
    ).toThrow(/supported backends: markdown, github/);
  });
});
