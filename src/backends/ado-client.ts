import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AxiError } from "../errors.js";

/**
 * Thin Azure DevOps REST surface used by the ADO backend (report §8 P3 seam).
 *
 * The store only ever talks to the `AdoClient` interface, so tests drive it
 * with an in-memory fake and the hot path stays direct REST — `ado-axi` is a
 * side tool, never a shell-out per list.
 */

const execFileAsync = promisify(execFile);

/** Azure DevOps resource id `az` uses when minting an ADO access token. */
export const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

/** PAT env vars, first non-empty wins (same order as ado-axi). */
export const PAT_ENV_VARS = [
	"TASKS_AXI_ADO_PAT",
	"ADO_PAT",
	"AZURE_DEVOPS_EXT_PAT",
	"AZURE_DEVOPS_PAT",
];

const API_VERSION = "7.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFINITIVE_ADO_REJECTIONS = new WeakSet<Error>();

function definitive<T>(error: T): T {
	if (error instanceof Error) DEFINITIVE_ADO_REJECTIONS.add(error);
	return error;
}

export function isDefinitiveAdoRejection(error: unknown): boolean {
	return error instanceof Error && DEFINITIVE_ADO_REJECTIONS.has(error);
}

export interface WorkItemRelation {
	rel: string;
	url: string;
	attributes?: Record<string, unknown>;
}

export interface WorkItem {
	id: number;
	rev?: number;
	fields: Record<string, unknown>;
	relations?: WorkItemRelation[];
}

export interface JsonPatchOp {
	op: "add" | "replace" | "remove" | "test";
	path: string;
	value?: unknown;
}

/** The narrow ADO surface the store depends on. */
export interface AdoClient {
	/** Run a WIQL query and return the matching work item ids. */
	queryIds(wiql: string): Promise<number[]>;
	/** Batch-read work items including relations. */
	getMany(ids: number[]): Promise<WorkItem[]>;
	get(id: number): Promise<WorkItem | null>;
	create(type: string, patch: JsonPatchOp[]): Promise<WorkItem>;
	update(id: number, patch: JsonPatchOp[]): Promise<WorkItem>;
	/** Send a work item to the ADO recycle bin (recoverable, never a hard delete). */
	remove(id: number): Promise<void>;
	/** The canonical `_apis/wit/workItems/<id>` url used in relation values. */
	workItemUrl(id: number): string;
}

export interface AdoRestClientOptions {
	org: string;
	project: string;
	host?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

function enc(value: string): string {
	return encodeURIComponent(value);
}

/** Personal access token from the environment, or undefined. */
export function patFromEnv(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of PAT_ENV_VARS) {
		const value = env[name];
		if (value && value.trim() !== "") return value.trim();
	}
	return undefined;
}

/** Live REST client: PAT Basic auth, falling back to an `az` bearer token. */
export class AdoRestClient implements AdoClient {
	private readonly org: string;
	private readonly project: string;
	private readonly host: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private authHeader?: string;

	constructor(options: AdoRestClientOptions) {
		this.org = options.org;
		this.project = options.project;
		this.host = options.host ?? "dev.azure.com";
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private async authorization(): Promise<string> {
		if (this.authHeader) return this.authHeader;
		const pat = patFromEnv(this.env);
		if (pat) {
			this.authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
			return this.authHeader;
		}
		let stdout: string;
		try {
			({ stdout } = await execFileAsync(
				"az",
				[
					"account",
					"get-access-token",
					"--resource",
					ADO_RESOURCE,
					"-o",
					"json",
				],
				{ env: this.env, timeout: this.timeoutMs },
			));
		} catch (error) {
			throw new AxiError(
				`No Azure DevOps credential: set ${PAT_ENV_VARS[0]} or sign in with \`az login\` (${error instanceof Error ? error.message : String(error)})`,
				"VALIDATION_ERROR",
				[`export ${PAT_ENV_VARS[0]}=<pat>`, "az login"],
			);
		}
		const tokenResponse = parseJson<unknown>(stdout, "az access-token output");
		if (
			!isRecord(tokenResponse) ||
			typeof tokenResponse.accessToken !== "string" ||
			tokenResponse.accessToken.trim() === ""
		) {
			throw new AxiError(
				"az returned no valid access token for Azure DevOps",
				"VALIDATION_ERROR",
			);
		}
		this.authHeader = `Bearer ${tokenResponse.accessToken.trim()}`;
		return this.authHeader;
	}

	private async request<T>(
		path: string,
		options: {
			method?: string;
			query?: Record<string, string | number | undefined>;
			body?: unknown;
			contentType?: string;
		} = {},
	): Promise<T> {
		const query: Record<string, string> = { "api-version": API_VERSION };
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined && value !== "") query[key] = String(value);
		}
		const qs = new URLSearchParams(query).toString();
		const url = `https://${this.host}/${enc(this.org)}${path}?${qs}`;
		let authorization: string;
		try {
			authorization = await this.authorization();
		} catch (error) {
			throw definitive(error);
		}
		const signal = AbortSignal.timeout(this.timeoutMs);
		let response: Response;
		let text: string;
		try {
			response = await this.fetchImpl(url, {
				method: options.method ?? "GET",
				headers: {
					Authorization: authorization,
					Accept: "application/json",
					...(options.body === undefined
						? {}
						: { "Content-Type": options.contentType ?? "application/json" }),
				},
				signal,
				...(options.body === undefined
					? {}
					: { body: JSON.stringify(options.body) }),
			});
			text = await response.text();
		} catch (error) {
			if (signal.aborted) {
				throw new AxiError(
					`Azure DevOps request timed out after ${this.timeoutMs}ms`,
					"UNKNOWN",
				);
			}
			throw error;
		}
		if (!response.ok) {
			throw adoError(response.status, text);
		}
		// Azure DevOps answers an unauthenticated REST call with 203 and an HTML
		// sign-in page instead of a 401, so `response.ok` is true and the body is
		// not JSON. Caught here, where every request routes through, so a bad or
		// missing credential reads as an auth failure rather than a parse error.
		if (response.status === 203 || /^\s*</.test(text)) {
			throw definitive(
				new AxiError(
					"Azure DevOps rejected the credential (it returned a sign-in page)",
					"VALIDATION_ERROR",
					[
						`export ${PAT_ENV_VARS[0]}=<pat> with Work Items (read & write) scope`,
						"Or run `az login` for a bearer token",
						`Check the org is spelled correctly: https://${this.host}/${enc(this.org)}`,
					],
				),
			);
		}
		return (
			text ? parseJson<T>(text, "Azure DevOps response") : undefined
		) as T;
	}

	async queryIds(wiql: string): Promise<number[]> {
		const data = await this.request<unknown>(
			`/${enc(this.project)}/_apis/wit/wiql`,
			{ method: "POST", body: { query: wiql } },
		);
		let workItems: unknown;
		if (typeof data === "object" && data !== null && "workItems" in data) {
			workItems = data.workItems;
		}
		if (
			!Array.isArray(workItems) ||
			workItems.some(
				(item) =>
					typeof item !== "object" ||
					item === null ||
					!("id" in item) ||
					typeof item.id !== "number" ||
					!Number.isSafeInteger(item.id) ||
					item.id <= 0,
			)
		) {
			throw new AxiError(
				"Azure DevOps WIQL response did not contain a valid workItems array",
				"UNKNOWN",
			);
		}
		return workItems.map((item) => (item as { id: number }).id);
	}

	async getMany(ids: number[]): Promise<WorkItem[]> {
		const out: WorkItem[] = [];
		for (let i = 0; i < ids.length; i += 200) {
			const chunk = ids.slice(i, i + 200);
			const data = await this.request<unknown>(
				`/${enc(this.project)}/_apis/wit/workitems`,
				{
					query: {
						ids: chunk.join(","),
						$expand: "Relations",
						errorPolicy: "Fail",
					},
				},
			);
			if (!isRecord(data) || !Array.isArray(data.value)) {
				throw new AxiError(
					"Azure DevOps batch response did not contain a work item array",
					"UNKNOWN",
				);
			}
			const items = data.value.map((value) =>
				decodeWorkItem(value, "Azure DevOps batch response"),
			);
			const expected = new Set(chunk);
			const returned = new Set(items.map((item) => item.id));
			if (
				items.length !== expected.size ||
				returned.size !== items.length ||
				[...expected].some((id) => !returned.has(id)) ||
				[...returned].some((id) => !expected.has(id))
			) {
				throw new AxiError(
					`Azure DevOps batch read returned ids [${[...returned].join(", ")}], expected [${[...expected].join(", ")}]`,
					"CONFLICT",
				);
			}
			out.push(...items);
		}
		return out;
	}

	async get(id: number): Promise<WorkItem | null> {
		try {
			return decodeWorkItem(
				await this.request<unknown>(
					`/${enc(this.project)}/_apis/wit/workitems/${id}`,
					{ query: { $expand: "Relations" } },
				),
				"Azure DevOps get response",
				id,
			);
		} catch (error) {
			if (error instanceof AxiError && error.code === "NOT_FOUND") return null;
			throw error;
		}
	}

	async create(type: string, patch: JsonPatchOp[]): Promise<WorkItem> {
		return decodeWorkItem(
			await this.request<unknown>(
				`/${enc(this.project)}/_apis/wit/workitems/$${enc(type)}`,
				{
					method: "POST",
					query: { $expand: "Relations" },
					body: patch,
					contentType: "application/json-patch+json",
				},
			),
			"Azure DevOps create response",
		);
	}

	async update(id: number, patch: JsonPatchOp[]): Promise<WorkItem> {
		return decodeWorkItem(
			await this.request<unknown>(
				`/${enc(this.project)}/_apis/wit/workitems/${id}`,
				{
					method: "PATCH",
					query: { $expand: "Relations" },
					body: patch,
					contentType: "application/json-patch+json",
				},
			),
			"Azure DevOps update response",
			id,
		);
	}

	async remove(id: number): Promise<void> {
		await this.request<unknown>(
			`/${enc(this.project)}/_apis/wit/workitems/${id}`,
			{ method: "DELETE" },
		);
	}

	workItemUrl(id: number): string {
		return `https://${this.host}/${enc(this.org)}/_apis/wit/workItems/${id}`;
	}
}

function parseJson<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new AxiError(`${what} was not valid JSON`, "UNKNOWN");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeWorkItem(
	value: unknown,
	what: string,
	expectedId?: number,
): WorkItem {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		!Number.isSafeInteger(value.id) ||
		value.id <= 0 ||
		(value.rev !== undefined &&
			(typeof value.rev !== "number" ||
				!Number.isSafeInteger(value.rev) ||
				value.rev <= 0)) ||
		!isRecord(value.fields) ||
		(value.relations !== undefined &&
			(!Array.isArray(value.relations) ||
				value.relations.some(
					(relation) =>
						!isRecord(relation) ||
						typeof relation.rel !== "string" ||
						typeof relation.url !== "string" ||
						(relation.attributes !== undefined &&
							!isRecord(relation.attributes)),
				)))
	) {
		throw new AxiError(`${what} did not contain a valid work item`, "UNKNOWN");
	}
	if (expectedId !== undefined && value.id !== expectedId) {
		throw new AxiError(
			`${what} returned work item ${value.id}, expected ${expectedId}`,
			"CONFLICT",
		);
	}
	return value as unknown as WorkItem;
}

/** Map an ADO HTTP failure onto the tasks-axi error vocabulary. */
export function adoError(status: number, body: string): AxiError {
	let message = body.slice(0, 500);
	try {
		const parsed = JSON.parse(body) as { message?: string };
		if (parsed.message) message = parsed.message;
	} catch {
		// Non-JSON error body: keep the truncated text.
	}
	let error: AxiError;
	if (status === 401 || status === 403) {
		error = new AxiError(
			`Azure DevOps rejected the credential (${status}): ${message}`,
			"VALIDATION_ERROR",
			[
				`export ${PAT_ENV_VARS[0]}=<pat> with Work Items (read & write) scope`,
				"Or run `az login` for a bearer token",
			],
		);
	} else if (status === 404) {
		error = new AxiError(message, "NOT_FOUND");
	} else if (status === 409 || status === 412) {
		error = new AxiError(message, "CONFLICT");
	} else if (status === 400) {
		error = new AxiError(message, "VALIDATION_ERROR");
	} else {
		error = new AxiError(
			`Azure DevOps request failed (${status}): ${message}`,
			"UNKNOWN",
		);
	}
	return status >= 400 && status < 500 ? definitive(error) : error;
}
