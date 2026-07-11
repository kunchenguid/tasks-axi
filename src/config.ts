import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > first existing backlog.md/data/backlog.md
 *   found walking up from cwd.
 *
 * `.tasks.toml` is discovered git-style: we walk up from cwd to the nearest
 * ancestor holding one, so verbs run from a subdirectory resolve against the
 * project's real ledger instead of the current directory. When nothing
 * anchors a ledger (no config, no override, no conventional backlog anywhere
 * up the tree) resolution fails loudly rather than silently creating a stray
 * backlog.md in cwd.
 *
 * P1 ships only the markdown backend; the Store seam keeps sqlite/remote
 * additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
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
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key and a `[markdown]` table with `path` / `archive` / `done_keep`.
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
      table = section[1].trim() === "markdown" ? "markdown" : "unsupported";
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

function configKeySource(
  table: ConfigTable,
  key: string,
): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
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

/**
 * Walk up from `startDir` to the filesystem root, returning the first ancestor
 * directory (inclusive) that contains a file named `name`, or undefined.
 */
function findUp(startDir: string, name: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The first conventional backlog candidate present directly in `dir`. */
function backlogAt(dir: string): string | undefined {
  for (const candidate of PATH_CANDIDATES) {
    const full = join(dir, candidate);
    if (existsSync(full)) return full;
  }
  return undefined;
}

/** Walk up from `startDir` to the first existing conventional backlog file. */
function findBacklogUp(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const found = backlogAt(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface PathSources {
  explicitPath: string | undefined;
  projectPath: string | undefined;
  projectRoot: string | undefined;
  homePath: string | undefined;
  cwd: string;
}

/**
 * Resolve the markdown ledger path, throwing when nothing anchors a ledger.
 *
 * Order: explicit --file/env > project `.tasks.toml` markdown.path (relative to
 * the discovered project root) > home config markdown.path > an existing
 * backlog beside a discovered `.tasks.toml` or anywhere up from cwd. With no
 * anchor at all we refuse rather than silently forking a new backlog in cwd.
 */
function resolveMarkdownPath(sources: PathSources): string {
  const { explicitPath, projectPath, projectRoot, homePath, cwd } = sources;

  if (explicitPath !== undefined) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
  }
  if (projectPath !== undefined) {
    return isAbsolute(projectPath)
      ? projectPath
      : resolve(projectRoot ?? cwd, projectPath);
  }
  if (homePath !== undefined) {
    return isAbsolute(homePath) ? homePath : resolve(cwd, homePath);
  }

  // A discovered `.tasks.toml` without an explicit path anchors the ledger at
  // the project root: reuse a backlog already sitting there, else default to
  // creating one there (safe — the config declares this is the project).
  if (projectRoot !== undefined) {
    return backlogAt(projectRoot) ?? join(projectRoot, PATH_CANDIDATES[0]);
  }

  // No config: adopt a conventional backlog found anywhere up from cwd.
  const existing = findBacklogUp(cwd);
  if (existing !== undefined) return existing;

  throw new AxiError(
    "No tasks-axi ledger found here or in any parent directory",
    "NOT_FOUND",
    [
      "Run tasks-axi from your project root, or add a `.tasks.toml` there",
      "Point at a ledger explicitly with `--file <path>` or `TASKS_AXI_FILE`",
    ],
  );
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
  // Git-style discovery: the nearest `.tasks.toml` walking up from cwd anchors
  // the project, so verbs run from a subdirectory hit its real ledger.
  const projectRoot = findUp(cwd, ".tasks.toml");
  const projectToml =
    projectRoot !== undefined
      ? loadToml(join(projectRoot, ".tasks.toml"))
      : {};

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const projectPath =
    explicitPath !== undefined
      ? undefined
      : validatePathValue(projectToml.markdown?.path, "markdown.path");
  const homePath =
    explicitPath !== undefined || projectPath !== undefined
      ? undefined
      : validatePathValue(homeToml.markdown?.path, "markdown.path");

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  const path = resolveMarkdownPath({
    explicitPath,
    projectPath,
    projectRoot,
    homePath,
    cwd,
  });

  // Relative archive paths anchor where their config lives: the project root
  // for a discovered `.tasks.toml`, else cwd for the home default.
  const projectArchive = validatePathValue(
    projectToml.markdown?.archive,
    "markdown.archive",
  );
  const archive =
    projectArchive !== undefined
      ? projectArchive
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const archiveBase =
    projectArchive !== undefined ? (projectRoot ?? cwd) : cwd;
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (archive) {
    config.archivePath = isAbsolute(archive)
      ? archive
      : resolve(archiveBase, archive);
  }
  return config;
}
