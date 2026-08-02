import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigToml, resolveConfig } from "../src/config.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cfg-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("parseConfigToml", () => {
  it("reads backend and the [markdown] table", () => {
    const cfg = parseConfigToml(
      [
        "# a comment",
        'backend = "markdown"',
        "",
        "[markdown]",
        'path = "data/backlog.md"',
        "done_keep = 15",
        'archive = "data/done-archive.md"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("markdown");
    expect(cfg.markdown).toEqual({
      path: "data/backlog.md",
      done_keep: 15,
      archive: "data/done-archive.md",
    });
  });

  it("ignores unknown keys and tables", () => {
    const cfg = parseConfigToml('[sqlite]\npath = ".tasks.db"\npath: broken\n');
    expect(cfg.markdown).toBeUndefined();
  });

  it("keeps # inside quoted values while stripping trailing comments", () => {
    const cfg = parseConfigToml(
      '[markdown]\npath = "data/back#log.md" # keep the hash\n',
    );
    expect(cfg.markdown?.path).toBe("data/back#log.md");
  });

  it("rejects an unquoted known string value", () => {
    expect(() =>
      parseConfigToml("[markdown]\npath = data/backlog.md\n"),
    ).toThrow(/markdown\.path/);
  });

  it("rejects an unterminated quoted value", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath = "data/backlog.md\n'),
    ).toThrow(/unterminated/);
  });

  it("rejects a non-numeric done_keep value", () => {
    expect(() => parseConfigToml("[markdown]\ndone_keep = many\n")).toThrow(
      /done_keep/,
    );
  });

  it("rejects malformed assignments in the top-level scope", () => {
    expect(() => parseConfigToml('backend: "markdown"\n')).toThrow(
      /key = value/,
    );
  });

  it("rejects malformed assignments in the markdown table", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath: "data/backlog.md"\n'),
    ).toThrow(/key = value/);
    expect(() => parseConfigToml("[markdown]\ndone_keep 5\n")).toThrow(
      /key = value/,
    );
  });
});

describe("resolveConfig", () => {
  it("defaults to the markdown backend and backlog.md", () => {
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.backend).toBe("markdown");
    expect(cfg.path).toBe(join(dir, "backlog.md"));
    expect(cfg.doneKeep).toBe(10);
  });

  it("prefers data/backlog.md when it exists and backlog.md does not", () => {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "backlog.md"), "# Backlog\n");
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.path).toBe(join(data, "backlog.md"));
  });

  it("honors the override order: flag > env > project toml", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "markdown"\n[markdown]\npath = "from-toml.md"\n',
    );
    const fromToml = resolveConfig({ cwd: dir, home, env: {} });
    expect(fromToml.path).toBe(join(dir, "from-toml.md"));

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("does not validate a lower-priority empty toml path", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[markdown]\npath = ""\n');

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("reads done_keep from the project toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = 5\n");
    expect(resolveConfig({ cwd: dir, home, env: {} }).doneKeep).toBe(5);
  });

  it("rejects negative done_keep from toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = -1\n");
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /done_keep/,
    );
  });

  it.each(["", "   "])("rejects an empty TASKS_AXI_FILE value %#", (value) => {
    expect(() =>
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: value } }),
    ).toThrow(/TASKS_AXI_FILE/);
  });

  it.each(["", "   "])(
    "rejects an empty markdown path from toml %#",
    (value) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `[markdown]\npath = "${value}"\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /markdown\.path/,
      );
    },
  );
});

describe("github config", () => {
  it("parses the [github] table", () => {
    const cfg = parseConfigToml(
      [
        'backend = "github"',
        "[github]",
        'repo = "owner/name"',
        'in_flight_label = "wip"',
        'blocked_label = "stuck"',
        'held_label = "paused"',
        'in_flight_color = "112233"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("github");
    expect(cfg.github).toEqual({
      repo: "owner/name",
      in_flight_label: "wip",
      blocked_label: "stuck",
      held_label: "paused",
      in_flight_color: "112233",
    });
  });

  it("resolves defaults for the label names and requires no repo for markdown homes", () => {
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.github).toBeUndefined();

    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "github"\n[github]\nrepo = "owner/name"\n',
    );
    const github = resolveConfig({ cwd: dir, home, env: {} });
    expect(github.github).toEqual({
      repo: "owner/name",
      inFlightLabel: "tasks-axi:in-flight",
      blockedLabel: "tasks-axi:blocked",
      heldLabel: "tasks-axi:held",
      inFlightColor: "FF8C00",
      blockedColor: "D73A4A",
      heldColor: "8250DF",
    });
  });

  it("attaches the github table even when the backend override comes later", () => {
    const cfg = resolveConfig({ cwd: dir, home, env: {}, backend: "github" });
    expect(cfg.backend).toBe("github");
    expect(cfg.github).toEqual({
      inFlightLabel: "tasks-axi:in-flight",
      blockedLabel: "tasks-axi:blocked",
      heldLabel: "tasks-axi:held",
      inFlightColor: "FF8C00",
      blockedColor: "D73A4A",
      heldColor: "8250DF",
    });
  });

  it("accepts a configured label color and strips a leading #", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[github]\nrepo = "o/r"\nheld_color = "#a1B2c3"\n',
    );
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.github).toMatchObject({ heldColor: "a1B2c3" });
  });

  it.each(["FF8C0", "orange", "FF8C000", "gg8c00"])(
    "rejects the malformed label color %s loudly",
    (value) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `[github]\nrepo = "o/r"\nblocked_color = "${value}"\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /github\.blocked_color must be a 6-digit hex color/,
      );
    },
  );

  it("merges project over home github settings per key", () => {
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      '[github]\nrepo = "home/repo"\nin_flight_label = "wip"\n',
    );
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[github]\nrepo = "project/repo"\n',
    );
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.github).toMatchObject({
      repo: "project/repo",
      inFlightLabel: "wip",
    });
  });

  it("rejects a malformed github repo", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[github]\nrepo = "not-a-repo"\n');
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /github\.repo must be "owner\/name"/,
    );
  });

  it("rejects an empty label name", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[github]\nrepo = "o/r"\nheld_label = " "\n',
    );
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /github\.held_label/,
    );
  });
});
