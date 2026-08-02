import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_LABEL_COLORS } from "./backends/github.js";
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
 * Markdown and GitHub Issues ship behind the Store seam, which keeps backend
 * selection invisible to the command layer.
 */

export interface ResolvedGithubConfig {
  /** "owner/name"; required when the github backend is active. */
  repo?: string;
  inFlightLabel: string;
  blockedLabel: string;
  heldLabel: string;
  /** Projection label colors: 6-digit hex, no `#`. */
  inFlightColor: string;
  blockedColor: string;
  heldColor: string;
}

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  /** Present when a [github] table exists or the github backend is active. */
  github?: ResolvedGithubConfig;
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
  github?: {
    repo?: string;
    in_flight_label?: string;
    blocked_label?: string;
    held_label?: string;
    in_flight_color?: string;
    blocked_color?: string;
    held_color?: string;
  };
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "github" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, a `[markdown]` table with `path` / `archive` / `done_keep`
 * (`archive` points at the file that receives pruned tasks), and a `[github]`
 * table with `repo` plus the projection label names.
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
      table = name === "markdown" || name === "github" ? name : "unsupported";
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
    if (table === "github") {
      config.github ??= {};
      const text = requireTomlString(value, source);
      if (key === "repo") config.github.repo = text;
      if (key === "in_flight_label") config.github.in_flight_label = text;
      if (key === "blocked_label") config.github.blocked_label = text;
      if (key === "held_label") config.github.held_label = text;
      if (key === "in_flight_color") config.github.in_flight_color = text;
      if (key === "blocked_color") config.github.blocked_color = text;
      if (key === "held_color") config.github.held_color = text;
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
    table === "github" &&
    (key === "repo" ||
      key === "in_flight_label" ||
      key === "blocked_label" ||
      key === "held_label" ||
      key === "in_flight_color" ||
      key === "blocked_color" ||
      key === "held_color")
  ) {
    return `github.${key}`;
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

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validateGithubRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!GITHUB_REPO_RE.test(value)) {
    throw new AxiError('github.repo must be "owner/name"', "VALIDATION_ERROR", [
      'Set `[github] repo = "owner/name"` in .tasks.toml',
    ]);
  }
  return value;
}

function validateGithubLabel(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "" || /[\r\n]/.test(value)) {
    throw new AxiError(
      `${source} must be a non-empty single-line label name`,
      "VALIDATION_ERROR",
    );
  }
  return value;
}

const GITHUB_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

function validateGithubColor(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!GITHUB_COLOR_RE.test(value)) {
    throw new AxiError(
      `${source} must be a 6-digit hex color like "FF8C00"`,
      "VALIDATION_ERROR",
      ['Set `[github] in_flight_color = "FF8C00"` style values in .tasks.toml'],
    );
  }
  return value.replace(/^#/, "");
}

function resolveGithubConfig(
  projectToml: TomlConfig,
  homeToml: TomlConfig,
  backend: string,
): ResolvedGithubConfig | undefined {
  if (!projectToml.github && !homeToml.github && backend !== "github") {
    return undefined;
  }
  const pick = <K extends keyof NonNullable<TomlConfig["github"]>>(key: K) =>
    projectToml.github?.[key] ?? homeToml.github?.[key];
  const repo = validateGithubRepo(pick("repo"));
  const config: ResolvedGithubConfig = {
    inFlightLabel:
      validateGithubLabel(pick("in_flight_label"), "github.in_flight_label") ??
      "tasks-axi:in-flight",
    blockedLabel:
      validateGithubLabel(pick("blocked_label"), "github.blocked_label") ??
      "tasks-axi:blocked",
    heldLabel:
      validateGithubLabel(pick("held_label"), "github.held_label") ??
      "tasks-axi:held",
    inFlightColor:
      validateGithubColor(pick("in_flight_color"), "github.in_flight_color") ??
      DEFAULT_LABEL_COLORS.inFlight,
    blockedColor:
      validateGithubColor(pick("blocked_color"), "github.blocked_color") ??
      DEFAULT_LABEL_COLORS.blocked,
    heldColor:
      validateGithubColor(pick("held_color"), "github.held_color") ??
      DEFAULT_LABEL_COLORS.held,
  };
  if (repo !== undefined) config.repo = repo;
  return config;
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
  const github = resolveGithubConfig(projectToml, homeToml, backend);
  if (github) config.github = github;
  return config;
}
