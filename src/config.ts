import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";

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

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key and a `[markdown]` table with `path` / `archive` / `done_keep`.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: "" | "markdown" = "";

  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      table = section[1].trim() === "markdown" ? "markdown" : "";
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = parseTomlValue(kv[2]);

    if (table === "") {
      if (key === "backend" && typeof value === "string") config.backend = value;
      continue;
    }
    config.markdown ??= {};
    if (key === "path" && typeof value === "string") config.markdown.path = value;
    if (key === "archive" && typeof value === "string")
      config.markdown.archive = value;
    if (key === "done_keep" && typeof value === "number")
      config.markdown.done_keep = value;
  }

  return config;
}

function parseTomlValue(raw: string): string | number | undefined {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^"([^"]*)"$/) ?? trimmed.match(/^'([^']*)'$/);
  if (quoted) return quoted[1];
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return undefined;
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

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  const path = resolveMarkdownPath(
    overrides.file ?? env.TASKS_AXI_FILE,
    projectToml.markdown?.path ?? homeToml.markdown?.path,
    cwd,
  );

  const archive = projectToml.markdown?.archive ?? homeToml.markdown?.archive;
  const doneKeep =
    projectToml.markdown?.done_keep ?? homeToml.markdown?.done_keep ?? DEFAULT_KEEP;

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  return config;
}
