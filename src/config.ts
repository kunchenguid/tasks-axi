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
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
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
	/** Azure DevOps backend settings (`[ado]`), present when configured. */
	ado?: AdoConfig;
}

/** Resolved `[ado]` table (see src/backends/ado.ts for the field map). */
export interface AdoConfig {
	org: string;
	project: string;
	/** Root area path new work items land in, e.g. `Firstmate\\main`. */
	area?: string;
	workItemType: string;
	idField: string;
	metaField: string;
	followupField: string;
	/** ADO state names per tasks-axi state; the first entry is the write value. */
	states: Record<AdoState, string[]>;
}

type AdoState = "queued" | "in_flight" | "done";

const ADO_DEFAULTS = {
	workItemType: "Task",
	idField: "Custom.TasksAxiId",
	metaField: "Custom.TasksAxiMeta",
	followupField: "Custom.TasksAxiPublicFollowup",
	states: {
		queued: ["New", "To Do", "Proposed"],
		in_flight: ["Active", "In Progress", "Doing", "Committed"],
		done: ["Closed", "Done", "Resolved", "Removed"],
	},
} as const;

const ADO_REFERENCE_NAME_RE =
	/^(?![0-9_])(?=.*\.)[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])$/;

const ADO_KEYS = [
	"org",
	"project",
	"area",
	"work_item_type",
	"id_field",
	"meta_field",
	"followup_field",
	"state_queued",
	"state_in_flight",
	"state_done",
] as const;

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
	ado?: string[];
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "ado" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, a `[markdown]` table with `path` / `archive` / `done_keep`,
 * and an `[ado]` table (org/project/area/fields/state names).
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
			table =
				name === "markdown" || name === "ado"
					? (name as ConfigTable)
					: "unsupported";
			continue;
		}

		if (table === "ado") {
			config.ado ??= [];
			config.ado.push(rawLine);
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

function configKeySource(table: ConfigTable, key: string): string | undefined {
	if (table === "root" && key === "backend") return "backend";
	if (
		table === "markdown" &&
		(key === "path" || key === "archive" || key === "done_keep")
	) {
		return `markdown.${key}`;
	}
	if (table === "ado" && (ADO_KEYS as readonly string[]).includes(key)) {
		return `ado.${key}`;
	}
	return undefined;
}

function parseAdoTable(lines: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of lines) {
		const line = stripTomlComment(rawLine).trim();
		if (line === "") continue;
		const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
		if (!kv) {
			throw new AxiError(
				"Invalid config line: expected `key = value`",
				"VALIDATION_ERROR",
				["Use `key = value` assignments in .tasks.toml"],
			);
		}
		const key = kv[1];
		if (!(ADO_KEYS as readonly string[]).includes(key)) {
			throw new AxiError(`Unknown ado config key: ${key}`, "VALIDATION_ERROR");
		}
		values[key] = kv[2];
	}
	return values;
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

/** Comma-separated ADO state names; the first entry is the write value. */
function stateNames(
	raw: string | undefined,
	fallback: readonly string[],
): string[] {
	if (raw === undefined) return [...fallback];
	const names = raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	if (names.length === 0) {
		throw new AxiError(
			"ado state names must not be empty",
			"VALIDATION_ERROR",
			['Set e.g. `[ado] state_done = "Closed, Done"`'],
		);
	}
	return names;
}

function resolveAdo(
	table: Record<string, string>,
	env: NodeJS.ProcessEnv,
): AdoConfig | undefined {
	const values: Record<string, string> = {};
	for (const [key, raw] of Object.entries(table)) {
		if (
			(key === "org" && env.TASKS_AXI_ADO_ORG !== undefined) ||
			(key === "project" && env.TASKS_AXI_ADO_PROJECT !== undefined) ||
			(key === "area" && env.TASKS_AXI_ADO_AREA !== undefined)
		) {
			continue;
		}
		const source = `ado.${key}`;
		values[key] = requireTomlString(parseTomlValue(raw, source), source);
	}
	const org = env.TASKS_AXI_ADO_ORG ?? values.org;
	const project = env.TASKS_AXI_ADO_PROJECT ?? values.project;
	const area = env.TASKS_AXI_ADO_AREA ?? values.area;
	const workItemType = values.work_item_type ?? ADO_DEFAULTS.workItemType;
	for (const [name, value] of [
		["org", org],
		["project", project],
		["work_item_type", workItemType],
	] as const) {
		if (
			value !== undefined &&
			(value.trim() === "" || value !== value.trim() || /[\r\n]/.test(value))
		) {
			throw new AxiError(
				`ado.${name} must be a non-empty single line without surrounding whitespace`,
				"VALIDATION_ERROR",
			);
		}
	}
	if (area !== undefined) {
		if (area.trim() === "") {
			throw new AxiError("ado.area must not be empty", "VALIDATION_ERROR", [
				"Remove ado.area or unset TASKS_AXI_ADO_AREA to use the whole project",
			]);
		}
		if (area !== area.trim() || /[\r\n]/.test(area)) {
			throw new AxiError(
				"ado.area must be a single line without surrounding whitespace",
				"VALIDATION_ERROR",
			);
		}
	}
	if (!org && !project && Object.keys(values).length === 0) return undefined;
	if (!org || !project) {
		throw new AxiError(
			"The ado backend needs both `[ado] org` and `[ado] project`",
			"VALIDATION_ERROR",
			['Set `[ado] org = "contoso"` and `project = "Internal"` in .tasks.toml'],
		);
	}
	if (
		env.TASKS_AXI_ADO_AREA === undefined &&
		table.area?.trim().startsWith('"') &&
		values.area?.includes("\\")
	) {
		throw new AxiError(
			"ado.area must not use backslash escapes",
			"VALIDATION_ERROR",
			["Use a TOML literal string instead: ado.area = 'Internal\\Firstmate'"],
		);
	}
	const states: AdoConfig["states"] = {
		queued: stateNames(values.state_queued, ADO_DEFAULTS.states.queued),
		in_flight: stateNames(
			values.state_in_flight,
			ADO_DEFAULTS.states.in_flight,
		),
		done: stateNames(values.state_done, ADO_DEFAULTS.states.done),
	};
	const queuedStates = new Set(states.queued.map((name) => name.toLowerCase()));
	const inFlightStates = new Set(
		states.in_flight.map((name) => name.toLowerCase()),
	);
	const overlap =
		states.in_flight.find((name) => queuedStates.has(name.toLowerCase())) ??
		states.done.find(
			(name) =>
				queuedStates.has(name.toLowerCase()) ||
				inFlightStates.has(name.toLowerCase()),
		);
	if (overlap) {
		throw new AxiError(
			`ADO state "${overlap}" is mapped to multiple task states`,
			"VALIDATION_ERROR",
		);
	}
	const idField = values.id_field ?? ADO_DEFAULTS.idField;
	const metaField = values.meta_field ?? ADO_DEFAULTS.metaField;
	const followupField = values.followup_field ?? ADO_DEFAULTS.followupField;
	const fields = [idField, metaField, followupField];
	if (fields.some((field) => field.trim() === "")) {
		throw new AxiError(
			"ADO id_field, meta_field, and followup_field must not be empty",
			"VALIDATION_ERROR",
		);
	}
	if (
		fields.some(
			(field) =>
				field.length > 70 ||
				field.includes("--") ||
				field.includes("..") ||
				!ADO_REFERENCE_NAME_RE.test(field),
		)
	) {
		throw new AxiError(
			"ADO id_field, meta_field, and followup_field must be valid Azure DevOps reference names",
			"VALIDATION_ERROR",
		);
	}
	if (fields.some((field) => /^(System|Microsoft\.VSTS)\./i.test(field))) {
		throw new AxiError(
			"ADO id_field, meta_field, and followup_field must not reference native ADO fields",
			"VALIDATION_ERROR",
		);
	}
	if (
		new Set(fields.map((field) => field.toLowerCase().replaceAll(".", "_")))
			.size !== fields.length
	) {
		throw new AxiError(
			"ADO id_field, meta_field, and followup_field must be distinct",
			"VALIDATION_ERROR",
		);
	}
	const config: AdoConfig = {
		org,
		project,
		workItemType,
		idField,
		metaField,
		followupField,
		states,
	};
	if (area) config.area = area;
	return config;
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
	if (backend === "ado") {
		const ado = resolveAdo(
			{
				...parseAdoTable(homeToml.ado ?? []),
				...parseAdoTable(projectToml.ado ?? []),
			},
			env,
		);
		if (ado) config.ado = ado;
	}
	return config;
}
