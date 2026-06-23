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
    const cfg = parseConfigToml('[sqlite]\npath = ".tasks.db"\n');
    expect(cfg.markdown).toBeUndefined();
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

  it.each(["", "   "])(
    "rejects an empty TASKS_AXI_FILE value %#",
    (value) => {
      expect(() =>
        resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: value } }),
      ).toThrow(/TASKS_AXI_FILE/);
    },
  );

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
