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

  it("reads the [beads] table", () => {
    const cfg = parseConfigToml(
      [
        'backend = "beads"',
        "[beads]",
        'path = "/var/lib/beads/.beads"',
        'binary = "bd"',
        'prefix = "fm"',
        'dir = "/var/lib/beads"',
        'bin = "/usr/local/bin/bd"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("beads");
    expect(cfg.beads).toEqual({
      path: "/var/lib/beads/.beads",
      binary: "bd",
      prefix: "fm",
      dir: "/var/lib/beads",
      bin: "/usr/local/bin/bd",
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

  it("reports whether the markdown path was configured", () => {
    expect(resolveConfig({ cwd: dir, home, env: {} }).pathConfigured).toBe(
      false,
    );
    expect(
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: "x.md" } })
        .pathConfigured,
    ).toBe(true);
    expect(
      resolveConfig({ cwd: dir, home, env: {}, file: "x.md" }).pathConfigured,
    ).toBe(true);
    writeFileSync(join(dir, ".tasks.toml"), '[markdown]\npath = "x.md"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).pathConfigured).toBe(
      true,
    );
  });

  it("resolves beads settings from the project toml", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'backend = "beads"',
        "[beads]",
        'path = ".data/.beads"',
        'binary = "custom-bd"',
        'prefix = "fm"',
      ].join("\n"),
    );
    expect(resolveConfig({ cwd: dir, home, env: {} })).toMatchObject({
      backend: "beads",
      beads: { dir: join(dir, ".data"), bin: "custom-bd", prefix: "fm" },
    });
  });

  it("treats beads dir/path and bin/binary as aliases", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      ["[beads]", 'dir = "ws"', 'bin = "bd"'].join("\n"),
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads).toEqual({
      dir: join(dir, "ws"),
      bin: "bd",
    });
  });

  it("keeps a path that is not a .beads directory as the workspace", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\npath = "ws"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads?.dir).toBe(
      join(dir, "ws"),
    );
  });

  it("prefers dir over path and bin over binary within one file", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      ["[beads]", 'dir = "a"', 'path = "b"', 'bin = "x"', 'binary = "y"'].join(
        "\n",
      ),
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads).toEqual({
      dir: join(dir, "a"),
      bin: "x",
    });
  });

  it("lets the project toml beat the home toml key by key", () => {
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      [
        "[beads]",
        'dir = "home-ws"',
        'binary = "home-bd"',
        'prefix = "hm"',
      ].join("\n"),
    );
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\npath = "proj-ws"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads).toEqual({
      dir: join(dir, "proj-ws"),
      bin: "home-bd",
      prefix: "hm",
    });
  });

  it("expands ~/ in beads paths and the binary", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        "[beads]",
        'path = "~/data/tasks/.beads"',
        'binary = "~/.local/bin/task"',
      ].join("\n"),
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads).toEqual({
      dir: join(home, "data/tasks"),
      bin: join(home, ".local/bin/task"),
    });
  });

  it("leaves beads unset when the toml has no [beads] keys", () => {
    writeFileSync(join(dir, ".tasks.toml"), 'backend = "beads"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads).toBeUndefined();
  });

  it("normalizes the beads prefix and rejects an invalid one", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\nprefix = "task-"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).beads?.prefix).toBe(
      "task",
    );
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\nprefix = "no spaces"\n');
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /beads.prefix/,
    );
  });

  it.each(["", "   "])("rejects an empty beads binary %#", (value) => {
    writeFileSync(join(dir, ".tasks.toml"), `[beads]\nbinary = "${value}"\n`);
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /beads.binary/,
    );
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
