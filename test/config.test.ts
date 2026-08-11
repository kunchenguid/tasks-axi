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

	it("ignores malformed ADO syntax and values while markdown is selected", () => {
		writeFileSync(
			join(dir, ".tasks.toml"),
			[
				"[ado]",
				"org: true",
				'project = "Internal"',
				'area = "Internal\\\\Firstmate"',
				"id_field = 42",
				"",
			].join("\n"),
		);

		const config = resolveConfig({
			cwd: dir,
			home,
			env: { TASKS_AXI_ADO_ORG: "stray" },
		});
		expect(config.backend).toBe("markdown");
		expect(config.ado).toBeUndefined();
		expect(() =>
			resolveConfig({
				backend: "ado",
				cwd: dir,
				home,
				env: {
					TASKS_AXI_ADO_ORG: "contoso",
					TASKS_AXI_ADO_PROJECT: "Internal",
				},
			}),
		).toThrow(/key = value/);
	});

	describe("[ado] table", () => {
		it("resolves the ado backend config with defaults", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					"area = 'Internal\\Firstmate\\main'",
					"",
				].join("\n"),
			);
			const cfg = resolveConfig({ cwd: dir, home, env: {} });
			expect(cfg.backend).toBe("ado");
			expect(cfg.ado?.area).toBe("Internal\\Firstmate\\main");
			expect(cfg.ado?.org).toBe("contoso");
			expect(cfg.ado?.project).toBe("Internal");
			expect(cfg.ado?.workItemType).toBe("Task");
			expect(cfg.ado?.idField).toBe("Custom.TasksAxiId");
			expect(cfg.ado?.states.done[0]).toBe("Closed");
		});

		it("overrides state names and fields, first entry wins on write", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					'state_in_flight = "Doing, In Progress"',
					'followup_field = "Custom.Relay"',
					"",
				].join("\n"),
			);
			const cfg = resolveConfig({ cwd: dir, home, env: {} });
			expect(cfg.ado?.states.in_flight).toEqual(["Doing", "In Progress"]);
			expect(cfg.ado?.followupField).toBe("Custom.Relay");
		});

		it.each([
			['id_field = ""', /must not be empty/],
			[
				'id_field = "Custom.Shared"\nmeta_field = "Custom.Shared"',
				/must be distinct/,
			],
			[
				'id_field = "Custom.Tasks.Axi"\nmeta_field = "Custom.Tasks_Axi"',
				/must be distinct/,
			],
			['id_field = "System.Title"', /native ADO fields/],
			['id_field = "Custom.Bad/Field]"', /valid Azure DevOps reference names/],
			['id_field = "1.CustomId"', /valid Azure DevOps reference names/],
			['id_field = "_Custom.Id"', /valid Azure DevOps reference names/],
			['id_field = "Custom.Bad--Field"', /valid Azure DevOps reference names/],
			['id_field = "Custom..TasksAxiId"', /valid Azure DevOps reference names/],
		])("rejects unsafe ADO field mappings %#", (fields, message) => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					fields,
					"",
				].join("\n"),
			);
			expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(message);
		});

		it("takes org/project/area from the environment", () => {
			const cfg = resolveConfig({
				backend: "ado",
				cwd: dir,
				home,
				env: {
					TASKS_AXI_ADO_ORG: "contoso",
					TASKS_AXI_ADO_PROJECT: "Internal",
					TASKS_AXI_ADO_AREA: "Internal\\Firstmate",
				},
			});
			expect(cfg.ado?.area).toBe("Internal\\Firstmate");
		});

		it.each([
			['org = "   "\nproject = "Internal"', /ado\.org/],
			['org = "contoso"\nproject = "   "', /ado\.project/],
			[
				'org = "contoso"\nproject = "Internal"\nwork_item_type = "   "',
				/ado\.work_item_type/,
			],
		])("rejects blank effective ADO names %#", (settings, message) => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				`backend = "ado"\n[ado]\n${settings}\n`,
			);
			expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(message);
		});

		it.each([
			['org = " contoso"\nproject = "Internal"', /ado\.org/],
			['org = "contoso"\nproject = "Internal "', /ado\.project/],
			[
				'org = "contoso"\nproject = "Internal"\nwork_item_type = " Task"',
				/ado\.work_item_type/,
			],
			[
				'org = "contoso"\nproject = "Internal"\narea = " Internal"',
				/ado\.area/,
			],
		])(
			"rejects surrounding whitespace in ADO names %#",
			(settings, message) => {
				writeFileSync(
					join(dir, ".tasks.toml"),
					`backend = "ado"\n[ado]\n${settings}\n`,
				);
				expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
					message,
				);
			},
		);

		it.each([
			["TASKS_AXI_ADO_ORG", /ado\.org/],
			["TASKS_AXI_ADO_AREA", /ado\.area/],
		] as const)("rejects multiline %s", (name, message) => {
			expect(() =>
				resolveConfig({
					backend: "ado",
					cwd: dir,
					home,
					env: {
						TASKS_AXI_ADO_ORG: "contoso",
						TASKS_AXI_ADO_PROJECT: "Internal",
						[name]: "contoso\nother",
					},
				}),
			).toThrow(message);
		});

		it.each(["", "   "])("rejects a blank ado.area %#", (area) => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					`area = "${area}"`,
					"",
				].join("\n"),
			);
			let error: unknown;
			try {
				resolveConfig({ cwd: dir, home, env: {} });
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({
				code: "VALIDATION_ERROR",
				message: "ado.area must not be empty",
				suggestions: [
					"Remove ado.area or unset TASKS_AXI_ADO_AREA to use the whole project",
				],
			});
		});

		it.each(["", "   "])("rejects a blank TASKS_AXI_ADO_AREA %#", (area) => {
			let error: unknown;
			try {
				resolveConfig({
					backend: "ado",
					cwd: dir,
					home,
					env: {
						TASKS_AXI_ADO_ORG: "contoso",
						TASKS_AXI_ADO_PROJECT: "Internal",
						TASKS_AXI_ADO_AREA: area,
					},
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({
				code: "VALIDATION_ERROR",
				message: "ado.area must not be empty",
				suggestions: [
					"Remove ado.area or unset TASKS_AXI_ADO_AREA to use the whole project",
				],
			});
		});

		it("validates only effective environment-overridden values", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				'backend = "ado"\n[ado]\norg = 1\nproject = 2\narea = 3\n',
			);
			const env = {
				TASKS_AXI_ADO_ORG: "contoso",
				TASKS_AXI_ADO_PROJECT: "Internal",
				TASKS_AXI_ADO_AREA: "Internal\\Firstmate",
			};

			const cfg = resolveConfig({ cwd: dir, home, env });
			expect(cfg.ado).toMatchObject({
				org: "contoso",
				project: "Internal",
				area: "Internal\\Firstmate",
			});

			writeFileSync(
				join(dir, ".tasks.toml"),
				'backend = "ado"\n[ado]\norg = 1\nproject = 2\narea = 3\nid_field = 4\n',
			);
			expect(() => resolveConfig({ cwd: dir, home, env })).toThrow(
				/ado\.id_field must be a quoted string/,
			);
		});

		it("rejects state names mapped to multiple task states", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					'state_queued = "New, Shared"',
					'state_done = "Closed, shared"',
					"",
				].join("\n"),
			);
			expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
				/mapped to multiple task states/,
			);
		});

		it("keeps Windows-style markdown paths", () => {
			const path = "data\\backlog.md";
			const archive = "data\\done-archive.md";
			writeFileSync(
				join(dir, ".tasks.toml"),
				["[markdown]", `path = "${path}"`, `archive = "${archive}"`, ""].join(
					"\n",
				),
			);

			const config = resolveConfig({ cwd: dir, home, env: {} });
			expect(config.path).toBe(join(dir, path));
			expect(config.archivePath).toBe(join(dir, archive));
		});

		// A backslash escape would resolve to the literal backslashes and quietly
		// point every WIQL read at an area path ADO does not have.
		it("refuses a backslash escape instead of mis-resolving the area path", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				[
					'backend = "ado"',
					"[ado]",
					'org = "contoso"',
					'project = "Internal"',
					'area = "Internal\\\\Firstmate"',
					"",
				].join("\n"),
			);
			expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
				/must not use backslash escapes/,
			);
		});

		it("requires both org and project", () => {
			writeFileSync(
				join(dir, ".tasks.toml"),
				'backend = "ado"\n[ado]\norg = "contoso"\n',
			);
			expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
				/org.*project/,
			);
		});

		it("omits ado config when the table is absent", () => {
			expect(resolveConfig({ cwd: dir, home, env: {} }).ado).toBeUndefined();
		});
	});
});
