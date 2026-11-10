import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * The markdown and beads backends ship today; the Store seam keeps further
 * additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /**
   * Markdown backlog path (resolved to an absolute path). The beads backend
   * uses it as the canonical-markdown mirror it rewrites after every mutation,
   * but only when `pathConfigured` is true.
   */
  path: string;
  /**
   * True when `path` was set by `--file`, `TASKS_AXI_FILE` or `[markdown] path`
   * rather than defaulted. The beads backend writes no mirror otherwise.
   */
  pathConfigured?: boolean;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  /** Beads backend settings from the `[beads]` table. */
  beads?: {
    /**
     * Workspace directory holding `.beads/` (resolved to an absolute path).
     * Set by `dir` or its alias `path` (which may name the `.beads` directory
     * itself). Unset: bd runs from the current directory and finds its own
     * workspace.
     */
    dir?: string;
    /**
     * Executable to run (default "bd"). Set by `bin` or its alias `binary`;
     * any command that accepts bd's arguments works, including a wrapper.
     */
    bin?: string;
    /** Issue-id prefix of the workspace; when set, other ids are rejected. */
    prefix?: string;
    /** How long a mutation waits on another's lock, in ms (default 30000). */
    lockTimeoutMs?: number;
  };
}

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface TomlConfig {
  backend?: string;
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
  beads?: {
    dir?: string;
    path?: string;
    bin?: string;
    binary?: string;
    prefix?: string;
    lock_timeout_ms?: number;
  };
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "beads" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, a `[markdown]` table with `path` / `archive` / `done_keep`,
 * and a `[beads]` table with `dir` (alias `path`) / `bin` (alias `binary`) /
 * `prefix` / `lock_timeout_ms`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      table = name === "markdown" || name === "beads" ? name : "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "beads") {
      config.beads ??= {};
      if (key === "lock_timeout_ms") {
        if (typeof value !== "number") {
          throw new AxiError(
            "beads.lock_timeout_ms must be an integer",
            "VALIDATION_ERROR",
            ["Set `[beads] lock_timeout_ms = 30000` in .tasks.toml"],
          );
        }
        config.beads.lock_timeout_ms = value;
        continue;
      }
      if (
        key === "dir" ||
        key === "path" ||
        key === "bin" ||
        key === "binary" ||
        key === "prefix"
      ) {
        config.beads[key] = requireTomlString(value, source);
      }
      continue;
    }
    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(table: ConfigTable, key: string): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  if (
    table === "beads" &&
    (key === "dir" ||
      key === "path" ||
      key === "bin" ||
      key === "binary" ||
      key === "prefix" ||
      key === "lock_timeout_ms")
  ) {
    return `beads.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveMarkdownPath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : projectToml.markdown?.path !== undefined
        ? validatePathValue(projectToml.markdown.path, "markdown.path")
        : validatePathValue(homeToml.markdown?.path, "markdown.path");

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  const path = resolveMarkdownPath(explicitPath, tomlPath, cwd);

  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = {
    backend,
    path,
    pathConfigured: explicitPath !== undefined || tomlPath !== undefined,
    doneKeep,
  };
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  const beads = resolveBeadsConfig(projectToml, homeToml, cwd, home);
  if (beads) config.beads = beads;
  return config;
}

/** Expand a leading `~/` against the home directory. */
function expandHome(value: string, home: string): string {
  return value === "~"
    ? home
    : value.startsWith("~/")
      ? join(home, value.slice(2))
      : value;
}

/**
 * Merge the `[beads]` tables. Each file may spell the workspace as `dir` or
 * `path` and the executable as `bin` or `binary` (the long and short forms are
 * aliases; `dir`/`bin` win inside one file). The project file beats the home
 * file key by key. A `path` that names the `.beads` directory itself resolves
 * to its parent, the directory bd runs from.
 */
function resolveBeadsConfig(
  projectToml: TomlConfig,
  homeToml: TomlConfig,
  cwd: string,
  home: string,
): ResolvedConfig["beads"] | undefined {
  const pick = (
    key: "dir" | "bin" | "prefix",
    alias: "path" | "binary" | undefined,
  ): { value: string; source: string } | undefined => {
    for (const toml of [projectToml, homeToml]) {
      if (toml.beads?.[key] !== undefined) {
        return { value: toml.beads[key], source: `beads.${key}` };
      }
      if (alias && toml.beads?.[alias] !== undefined) {
        return { value: toml.beads[alias], source: `beads.${alias}` };
      }
    }
    return undefined;
  };

  const beads: NonNullable<ResolvedConfig["beads"]> = {};
  const dir = pick("dir", "path");
  if (dir) {
    const value = validatePathValue(dir.value, dir.source) as string;
    const absolute = resolve(cwd, expandHome(value, home));
    beads.dir = basename(absolute) === ".beads" ? dirname(absolute) : absolute;
  }
  const bin = pick("bin", "binary");
  if (bin) {
    const value = validatePathValue(bin.value, bin.source) as string;
    beads.bin = expandHome(value, home);
  }
  const prefix = pick("prefix", undefined);
  if (prefix) beads.prefix = validatePrefix(prefix.value);
  const lockTimeout =
    projectToml.beads?.lock_timeout_ms ?? homeToml.beads?.lock_timeout_ms;
  if (lockTimeout !== undefined) {
    if (!Number.isSafeInteger(lockTimeout) || lockTimeout < 0) {
      throw new AxiError(
        "beads.lock_timeout_ms must be a non-negative integer",
        "VALIDATION_ERROR",
        ["Set `[beads] lock_timeout_ms = 30000` in .tasks.toml"],
      );
    }
    beads.lockTimeoutMs = lockTimeout;
  }
  return Object.keys(beads).length > 0 ? beads : undefined;
}

function validatePrefix(value: string): string {
  const prefix = value.trim().replace(/-$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(prefix)) {
    throw new AxiError(
      "beads.prefix must be an issue-id prefix such as `task`",
      "VALIDATION_ERROR",
      ['Set `[beads] prefix = "task"` in .tasks.toml, or remove the key'],
    );
  }
  return prefix;
}
