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
        'start_fence = ".control/start-fence"',
        "",
        "[markdown]",
        'path = "data/backlog.md"',
        "done_keep = 15",
        'archive = "data/done-archive.md"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("markdown");
    expect(cfg.start_fence).toBe(".control/start-fence");
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
    expect(() =>
      parseConfigToml("[markdown]\ndone_keep = many\n"),
    ).toThrow(/done_keep/);
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

  it("leaves the start fence unconfigured by default", () => {
    expect(
      resolveConfig({ cwd: dir, home, env: {} }).startFencePath,
    ).toBeUndefined();
  });

  it("resolves a configured start fence with env taking precedence", () => {
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      'start_fence = "from-home"\n',
    );
    const fromHome = resolveConfig({ cwd: dir, home, env: {} });
    expect(fromHome.startFencePath).toBe(join(dir, "from-home"));

    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'start_fence = "from-project"',
        "[markdown]",
        'path = "data/backlog.md"',
      ].join("\n"),
    );

    const fromProject = resolveConfig({ cwd: dir, home, env: {} });
    expect(fromProject.startFencePath).toBe(join(dir, "data", "from-project"));

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_START_FENCE: "from-env" },
    });
    expect(fromEnv.startFencePath).toBe(join(dir, "data", "from-env"));
  });

  it("uses an absolute start fence path as-is", () => {
    const absolute = join(home, "absolute-start-fence");
    expect(
      resolveConfig({
        cwd: dir,
        home,
        env: { TASKS_AXI_START_FENCE: absolute },
      }).startFencePath,
    ).toBe(absolute);
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

  it.each(["", "   "])(
    "rejects an empty TASKS_AXI_START_FENCE value %#",
    (value) => {
      expect(() =>
        resolveConfig({
          cwd: dir,
          home,
          env: { TASKS_AXI_START_FENCE: value },
        }),
      ).toThrow(/TASKS_AXI_START_FENCE/);
    },
  );

  it.each(["", "   "])(
    "rejects an empty start_fence config value %#",
    (value) => {
      writeFileSync(join(dir, ".tasks.toml"), `start_fence = "${value}"\n`);
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /start_fence/,
      );
    },
  );
});
