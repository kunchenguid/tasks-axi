import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, backlog.md).
 *
 * P1 ships only the markdown backend; the Store seam keeps sqlite/remote
 * additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (absolute or cwd-relative). */
  path: string;
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

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  return config;
}
