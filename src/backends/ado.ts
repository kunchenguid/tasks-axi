import { AxiError } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
	Dep,
	Hold,
	State,
	Task,
	TaskInput,
	TaskLink,
	TaskPatch,
	TaskQuery,
	TaskUpdateChange,
	TaskUpdateResult,
	TransitionOpts,
} from "../model.js";
import { HOLD_KINDS } from "../model.js";
import {
	PUBLIC_FOLLOWUP_KIND,
	assertPublicFollowupMutation,
	assertPublicFollowupTaskContent,
	assertPublicFollowupTaskState,
	canonicalEqual,
	decodePublicFollowup,
	encodePublicFollowup,
	isPublicFollowupTask,
	isPublicFollowupTerminal,
	normalizePublicFollowup,
	type PublicFollowupMutation,
} from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import {
	isDefinitiveAdoRejection,
	type AdoClient,
	type JsonPatchOp,
	type WorkItem,
} from "./ado-client.js";
import { normalizeTypedLinks } from "./markdown-grammar.js";

/**
 * Azure DevOps backend (phase 1). ADO is a full tasks-axi backend, not a
 * mirror: the CLI layer only ever sees the `Store` seam.
 *
 * Field map — ADO owns what ADO models, tasks-axi owns the rest:
 *   id             -> `<idField>`      (join key, queried through WIQL)
 *   title          -> System.Title
 *   state          -> System.State     (1:1 through the configured state map)
 *   body           -> System.Description
 *   kind / repo    -> System.Tags      (`kind:<v>` / `repo:<v>`, filterable in ADO)
 *   deps           -> work item links  (predecessor / parent / related)
 *   public_followup-> `<followupField>` (same canonical base64url payload as markdown)
 *   area (moveTo)  -> System.AreaPath
 *   the remainder  -> `<metaField>`    (priority, hold, links, dates, meta)
 *
 * Not force-fitted: `prune`/`render` are absent (capability-gated), and
 * `remove` sends the work item to the ADO recycle bin rather than hard-deleting.
 */

export interface AdoStoreOptions {
	client: AdoClient;
	project: string;
	/** Root area path new work items land in, e.g. `Firstmate\\main`. */
	area?: string;
	workItemType: string;
	idField: string;
	metaField: string;
	followupField: string;
	/** ADO state names per tasks-axi state; the first entry is the write value. */
	states: Record<State, string[]>;
	/** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
	now?: () => string;
}

const F_TITLE = "System.Title";
const F_STATE = "System.State";
const F_PROJECT = "System.TeamProject";
const F_WORK_ITEM_TYPE = "System.WorkItemType";
const F_AREA = "System.AreaPath";
const F_DESCRIPTION = "System.Description";
const F_TAGS = "System.Tags";
const F_CHANGED = "System.ChangedDate";
const F_CREATED = "System.CreatedDate";

const REL_BLOCKED_BY = "System.LinkTypes.Dependency-Reverse";
const REL_BLOCKS = "System.LinkTypes.Dependency-Forward";
const REL_PARENT = "System.LinkTypes.Hierarchy-Reverse";
const REL_RELATED = "System.LinkTypes.Related";
const PARENT_MARKER = "parent";
const DISCOVERED_MARKER = "discovered-from";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const META_VERSION = 1;

/** The tasks-axi-only residue that has no native ADO home. */
interface MetaBlob {
	v: number;
	priority?: number;
	hold?: Hold;
	links?: TaskLink[];
	created?: string;
	closed?: string;
	pending_closed?: string;
	meta?: Record<string, unknown>;
}

function today(): string {
	const d = new Date();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

function validation(message: string, suggestions?: string[]): never {
	throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function unconfirmedCreate(
	id: string,
	action: string,
	error: unknown,
	suggestion: string,
	createRequestReturned: boolean,
): never {
	if (!createRequestReturned && isDefinitiveAdoRejection(error)) throw error;
	const reason = error instanceof Error ? `: ${error.message}` : "";
	throw new AxiError(
		`Task "${id}" ${action} has an unconfirmed outcome${reason}; its existence and state could not be confirmed`,
		"CONFLICT",
		[suggestion],
	);
}

function normalizeTitle(title: string): string {
	if (/[\r\n]/.test(title)) validation("Task title must be a single line");
	const trimmed = title.trim();
	if (trimmed === "") validation("Task title must not be empty");
	return trimmed;
}

/** kind/repo ride along as ADO tags, so `;` and `,` are not representable. */
function normalizeTagValue(
	value: string | undefined,
	field: "kind" | "repo",
): string | undefined {
	if (value === undefined) return undefined;
	if (/[;,\r\n]/.test(value)) {
		validation(`Task ${field} must be a single line without ";" or ","`);
	}
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function normalizeDate(value: string, field: string): string {
	const trimmed = value.trim();
	if (!DATE_RE.test(trimmed)) validation(`${field} must be YYYY-MM-DD`);
	return trimmed;
}

function normalizePriority(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 0 || value > 4) {
		validation("Task priority must be an integer between 0 and 4");
	}
	return value;
}

function normalizeHold(hold: Hold | undefined): Hold | undefined {
	if (!hold) return undefined;
	const reason = hold.reason?.trim() ?? "";
	if (reason === "" || /[\r\n]/.test(reason)) {
		validation("Hold reason must be a non-empty single line");
	}
	const next: Hold = { reason };
	if (hold.kind !== undefined) {
		if (!HOLD_KINDS.includes(hold.kind)) {
			validation(`Hold kind must be one of ${HOLD_KINDS.join(", ")}`);
		}
		next.kind = hold.kind;
	}
	if (hold.until !== undefined)
		next.until = normalizeDate(hold.until, "hold-until");
	return next;
}

function sameHold(a: Hold | undefined, b: Hold | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function normalizeDep(id: string, dep: Dep): Dep {
	const depId = validateDependencyId(dep.id);
	if (depId === id) validation(`Task "${id}" cannot depend on itself`);
	const next: Dep = { type: dep.type, id: depId };
	if (dep.reason !== undefined) {
		const reason = dep.reason.trim();
		if (/[\r\n]/.test(dep.reason)) {
			validation("Dependency reason must be a single line");
		}
		if (reason !== "") next.reason = reason;
	}
	return next;
}

function dateOnly(value: unknown): string | undefined {
	return typeof value === "string" && value.length >= 10
		? value.slice(0, 10)
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseTags(raw: unknown): string[] {
	return typeof raw === "string"
		? raw
				.split(";")
				.map((tag) => tag.trim())
				.filter((tag) => tag !== "")
		: [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMeta(raw: unknown): MetaBlob {
	if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
		return { v: META_VERSION };
	}
	if (typeof raw !== "string") {
		validation("Work item tasks-axi metadata must be a string");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		validation("Work item tasks-axi metadata is not valid JSON");
	}
	if (!isRecord(parsed)) {
		validation("Work item tasks-axi metadata must be a JSON object");
	}
	const version = parsed.v;
	if (version !== META_VERSION) {
		validation(`Unsupported tasks-axi metadata version: ${String(version)}`);
	}
	const unknown = Object.keys(parsed).find(
		(key) =>
			![
				"v",
				"priority",
				"hold",
				"links",
				"created",
				"closed",
				"pending_closed",
				"meta",
			].includes(key),
	);
	if (unknown) validation(`Unknown tasks-axi metadata field: ${unknown}`);

	const meta: MetaBlob = { v: META_VERSION };
	if (parsed.priority !== undefined) {
		if (typeof parsed.priority !== "number") {
			validation("Work item tasks-axi metadata priority must be a number");
		}
		meta.priority = normalizePriority(parsed.priority);
	}
	if (parsed.hold !== undefined) {
		if (!isRecord(parsed.hold)) {
			validation("Work item tasks-axi metadata hold must be an object");
		}
		const unknownHold = Object.keys(parsed.hold).find(
			(key) => !["reason", "kind", "until"].includes(key),
		);
		if (unknownHold) {
			validation(`Unknown tasks-axi metadata hold field: ${unknownHold}`);
		}
		const reason = parsed.hold.reason;
		if (
			typeof reason !== "string" ||
			reason === "" ||
			reason !== reason.trim() ||
			/[\r\n]/.test(reason)
		) {
			validation("Work item tasks-axi metadata hold reason is invalid");
		}
		const hold: Hold = { reason };
		if (parsed.hold.kind !== undefined) {
			if (
				typeof parsed.hold.kind !== "string" ||
				!HOLD_KINDS.includes(parsed.hold.kind as NonNullable<Hold["kind"]>)
			) {
				validation("Work item tasks-axi metadata hold kind is invalid");
			}
			hold.kind = parsed.hold.kind as NonNullable<Hold["kind"]>;
		}
		if (parsed.hold.until !== undefined) {
			if (
				typeof parsed.hold.until !== "string" ||
				!DATE_RE.test(parsed.hold.until)
			) {
				validation(
					"Work item tasks-axi metadata hold-until must be YYYY-MM-DD",
				);
			}
			hold.until = parsed.hold.until;
		}
		meta.hold = hold;
	}
	if (parsed.links !== undefined) {
		if (!Array.isArray(parsed.links)) {
			validation("Work item tasks-axi metadata links must be an array");
		}
		const links = parsed.links.map((value) => {
			if (
				!isRecord(value) ||
				Object.keys(value).some((key) => !["kind", "url"].includes(key)) ||
				!["pr", "report", "doc"].includes(value.kind as string) ||
				typeof value.url !== "string"
			) {
				validation("Work item tasks-axi metadata link is invalid");
			}
			return { kind: value.kind as TaskLink["kind"], url: value.url };
		});
		try {
			meta.links = normalizeTypedLinks(links);
		} catch (error) {
			if (error instanceof AxiError) {
				validation(
					`Work item tasks-axi metadata link is invalid: ${error.message}`,
				);
			}
			throw error;
		}
	}
	for (const field of ["created", "closed", "pending_closed"] as const) {
		const value = parsed[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || !DATE_RE.test(value)) {
			validation(`Work item tasks-axi metadata ${field} must be YYYY-MM-DD`);
		}
		meta[field] = value;
	}
	if (meta.closed && meta.pending_closed) {
		validation(
			"Work item tasks-axi metadata cannot contain both closed and pending_closed",
		);
	}
	if (parsed.meta !== undefined) {
		if (!isRecord(parsed.meta)) {
			validation("Work item tasks-axi metadata meta must be an object");
		}
		meta.meta = parsed.meta;
	}
	return meta;
}

function relationTargetId(url: string): number | undefined {
	const match = /\/(\d+)$/.exec(url);
	return match ? Number(match[1]) : undefined;
}

function comment(relation: { attributes?: Record<string, unknown> }): string {
	const value = relation.attributes?.comment;
	return typeof value === "string" ? value : "";
}

function normalizedField(field: string, value: unknown): unknown {
	if (field === F_STATE || field === F_AREA) {
		return typeof value === "string" ? value.toLowerCase() : value;
	}
	if (field === F_TAGS) return parseTags(value).sort();
	if (field === F_DESCRIPTION && (value === undefined || value === null))
		return "";
	return value;
}

function normalizedRelations(relations: WorkItem["relations"]): string[] {
	return (relations ?? [])
		.map((relation) =>
			JSON.stringify({
				rel: relation.rel,
				target: relationTargetId(relation.url) ?? relation.url,
				comment: comment(relation),
			}),
		)
		.sort((left, right) => left.localeCompare(right));
}

function requirePatchPostconditions(
	before: WorkItem,
	after: WorkItem,
	ops: JsonPatchOp[],
): void {
	const fields = new Map<string, JsonPatchOp>();
	const relations = structuredClone(before.relations ?? []);
	let relationsChanged = false;
	for (const op of ops) {
		const field = /^\/fields\/(.+)$/.exec(op.path)?.[1];
		if (field) {
			fields.set(field, op);
			continue;
		}
		if (op.path === "/relations/-") {
			relations.push(op.value as NonNullable<WorkItem["relations"]>[number]);
			relationsChanged = true;
			continue;
		}
		const relation = /^\/relations\/(\d+)$/.exec(op.path);
		if (relation && op.op === "remove") {
			relations.splice(Number(relation[1]), 1);
			relationsChanged = true;
		}
	}
	for (const [field, op] of fields) {
		const matches =
			op.op === "remove"
				? !Object.hasOwn(after.fields, field)
				: canonicalEqual(
						normalizedField(field, after.fields[field]),
						normalizedField(field, op.value),
					);
		if (!matches) {
			throw new AxiError(
				`Work item ${after.id} did not persist ${field}`,
				"CONFLICT",
			);
		}
	}
	if (
		relationsChanged &&
		!canonicalEqual(
			normalizedRelations(after.relations),
			normalizedRelations(relations),
		)
	) {
		throw new AxiError(
			`Work item ${after.id} did not persist its relation changes`,
			"CONFLICT",
		);
	}
}

function ownedRelationMarkerOwner(
	relation: { rel: string; attributes?: Record<string, unknown> },
	relationType: string,
	marker: string,
): string | undefined {
	if (relation.rel !== relationType) return undefined;
	const prefix = `${marker}:`;
	const text = comment(relation);
	if (!text.startsWith(prefix)) return undefined;
	return text.slice(prefix.length).split(":", 1)[0];
}

function relationMarkerOwner(relation: {
	rel: string;
	attributes?: Record<string, unknown>;
}): string | undefined {
	return (
		ownedRelationMarkerOwner(relation, REL_PARENT, PARENT_MARKER) ??
		ownedRelationMarkerOwner(relation, REL_RELATED, DISCOVERED_MARKER)
	);
}

function requireOwnedRelationEndpoints(
	items: WorkItem[],
	slugs: Map<number, string>,
): void {
	for (const item of items) {
		const ownerId = slugs.get(item.id);
		if (!ownerId) validation(`Work item ${item.id} has no tasks-axi id`);
		for (const relation of item.relations ?? []) {
			const markerOwner = relationMarkerOwner(relation);
			if (markerOwner === undefined) continue;
			const targetId = relationTargetId(relation.url);
			const targetSlug =
				targetId === undefined ? undefined : slugs.get(targetId);
			if (!targetSlug) {
				validation(
					`Work item ${item.id} has an unavailable owned relation target`,
				);
			}
			if (markerOwner !== ownerId && markerOwner !== targetSlug) {
				throw new AxiError(
					`Work item ${item.id} has a stale tasks-axi relation marker for "${markerOwner}"; its endpoints are "${ownerId}" and "${targetSlug}"`,
					"CONFLICT",
					["Repair or remove the stale relation in Azure DevOps"],
				);
			}
		}
	}
}

function ownedRelationReason(
	relation: { rel: string; attributes?: Record<string, unknown> },
	relationType: string,
	marker: string,
	ownerId: string,
): string | undefined {
	if (ownedRelationMarkerOwner(relation, relationType, marker) !== ownerId) {
		return undefined;
	}
	const text = comment(relation);
	const ownerMarker = `${marker}:${ownerId}`;
	if (text === ownerMarker) return "";
	return text.startsWith(`${ownerMarker}:`)
		? text.slice(ownerMarker.length + 1)
		: undefined;
}

function discoveredReason(
	relation: { rel: string; attributes?: Record<string, unknown> },
	ownerId: string,
): string | undefined {
	return ownedRelationReason(relation, REL_RELATED, DISCOVERED_MARKER, ownerId);
}

function parentReason(
	relation: { rel: string; attributes?: Record<string, unknown> },
	ownerId: string,
): string | undefined {
	return ownedRelationReason(relation, REL_PARENT, PARENT_MARKER, ownerId);
}

export class AdoStore implements Store {
	private readonly client: AdoClient;
	private readonly project: string;
	private readonly area?: string;
	private readonly workItemType: string;
	private readonly idField: string;
	private readonly metaField: string;
	private readonly followupField: string;
	private readonly states: Record<State, string[]>;
	private readonly now: () => string;

	constructor(options: AdoStoreOptions) {
		this.client = options.client;
		this.project = options.project;
		if (options.area) this.area = options.area;
		this.workItemType = options.workItemType;
		this.idField = options.idField;
		this.metaField = options.metaField;
		this.followupField = options.followupField;
		this.states = options.states;
		this.now = options.now ?? today;
	}

	capabilities(): Capabilities {
		return {
			backend: "ado",
			deps: true,
			// No hard prune and no canonical re-render: ADO owns its own storage.
			prune: false,
			comments: false,
			fullTextSearch: false,
			realtimeSync: false,
			customStates: false,
			serverMintsIds: false,
			publicFollowups: true,
			fileMoves: false,
		};
	}

	// ---------------------------------------------------------------------
	// State mapping
	// ---------------------------------------------------------------------

	private adoState(state: State): string {
		return this.states[state][0];
	}

	private toState(adoState: string): State {
		const normalized = adoState.toLowerCase();
		for (const state of ["queued", "in_flight", "done"] as State[]) {
			if (
				this.states[state].some((name) => name.toLowerCase() === normalized)
			) {
				return state;
			}
		}
		return validation(
			`Azure DevOps state "${adoState}" is not mapped to a tasks-axi state`,
			[
				"Add it to `[ado] state_queued` / `state_in_flight` / `state_done` in .tasks.toml",
			],
		);
	}

	// ---------------------------------------------------------------------
	// Read
	// ---------------------------------------------------------------------

	private wiql(where: string[], area = this.area): string {
		const clauses = [
			`[System.TeamProject] = '${sq(this.project)}'`,
			`[System.WorkItemType] = '${sq(this.workItemType)}'`,
			`[${this.idField}] <> ''`,
			...(area ? [`[System.AreaPath] UNDER '${sq(area)}'`] : []),
			...where,
		];
		return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")}`;
	}

	/** Resolve a tasks-axi slug id to its work item id. */
	private async findWorkItemId(id: string): Promise<number | undefined> {
		const ids = await this.client.queryIds(
			this.wiql([`[${this.idField}] = '${sq(id)}'`]),
		);
		if (ids.length > 1) {
			throw new AxiError(
				`Task "${id}" matches multiple Azure DevOps work items`,
				"CONFLICT",
				[`Make ${this.idField} unique before retrying`],
			);
		}
		return ids[0];
	}

	private isAreaInScope(areaPath: string | undefined): boolean {
		if (!this.area) return true;
		const area = areaPath?.toLowerCase();
		const expected = this.area.toLowerCase();
		return area === expected || area?.startsWith(`${expected}\\`) === true;
	}

	private requireInProject(item: WorkItem): void {
		if (
			str(item.fields[F_PROJECT])?.toLowerCase() !== this.project.toLowerCase()
		) {
			throw new AxiError(
				`Work item ${item.id} left the configured Azure DevOps project while it was being loaded`,
				"CONFLICT",
				["Retry the command after checking the work item's Team Project"],
			);
		}
	}

	private requireInProjectAndType(item: WorkItem): void {
		this.requireInProject(item);
		const workItemType = str(item.fields[F_WORK_ITEM_TYPE]);
		if (workItemType?.toLowerCase() !== this.workItemType.toLowerCase()) {
			throw new AxiError(
				`Work item ${item.id} has Azure DevOps type "${workItemType ?? ""}", expected "${this.workItemType}"`,
				"CONFLICT",
				["Retry the command after checking the work item's Work Item Type"],
			);
		}
	}

	private requireInScope(item: WorkItem): void {
		this.requireInProjectAndType(item);
		if (!this.isAreaInScope(str(item.fields[F_AREA]))) {
			throw new AxiError(
				`Work item ${item.id} left the configured Azure DevOps area while it was being loaded`,
				"CONFLICT",
				["Retry the command after checking the work item's Area Path"],
			);
		}
	}

	private requireMutationResult(
		item: WorkItem,
		expectedId: string,
		expectedArea?: string,
	): void {
		if (expectedArea === undefined) {
			this.requireInScope(item);
		} else {
			this.requireInProjectAndType(item);
			if (
				str(item.fields[F_AREA])?.toLowerCase() !== expectedArea.toLowerCase()
			) {
				throw new AxiError(
					`Work item ${item.id} did not land in Azure DevOps area "${expectedArea}"`,
					"CONFLICT",
				);
			}
		}
		if (this.taskId(item) !== expectedId) {
			throw new AxiError(
				`Work item ${item.id} returned an unexpected ${this.idField} value`,
				"CONFLICT",
			);
		}
	}

	private taskId(item: WorkItem): string | undefined {
		const id = str(item.fields[this.idField]);
		if (!id) return undefined;
		try {
			return validateId(id);
		} catch {
			validation(
				`Work item ${item.id} has invalid ${this.idField} value ${JSON.stringify(id)}`,
			);
		}
	}

	private async loadItem(id: string): Promise<WorkItem | undefined> {
		const workItemId = await this.findWorkItemId(id);
		if (workItemId === undefined) return undefined;
		const item = await this.client.get(workItemId);
		if (!item) return undefined;
		if (this.taskId(item) !== id) {
			throw new AxiError(
				`Task "${id}" changed identity while it was being loaded`,
				"CONFLICT",
				["Retry the command after checking the Azure DevOps join field"],
			);
		}
		this.requireInScope(item);
		return item;
	}

	private async requireItem(id: string): Promise<WorkItem> {
		const item = await this.loadItem(id);
		if (!item) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
		return item;
	}

	/**
	 * Map linked work item ids to their tasks-axi slugs. Relations point at
	 * numeric ids, so one batched read turns them back into join keys.
	 */
	private async slugMap(items: WorkItem[]): Promise<Map<number, string>> {
		const known = new Map<number, string>();
		const workItemBySlug = new Map<string, number>();
		const remember = (item: WorkItem) => {
			const slug = this.taskId(item);
			if (!slug) {
				validation(`Work item ${item.id} has no ${this.idField} value`);
			}
			const key = slug.toLowerCase();
			const existing = workItemBySlug.get(key);
			if (existing !== undefined && existing !== item.id) {
				throw new AxiError(
					`Task "${slug}" matches multiple Azure DevOps work items`,
					"CONFLICT",
					[`Make ${this.idField} unique before retrying`],
				);
			}
			known.set(item.id, slug);
			workItemBySlug.set(key, item.id);
		};
		for (const item of items) remember(item);
		const missing = new Map<number, boolean>();
		for (const item of items) {
			for (const relation of item.relations ?? []) {
				const forwardDependency = relation.rel === REL_BLOCKS;
				const markerOwner = relationMarkerOwner(relation);
				const supported =
					relation.rel === REL_BLOCKED_BY ||
					forwardDependency ||
					markerOwner !== undefined;
				const target = supported ? relationTargetId(relation.url) : undefined;
				if (supported && target === undefined) {
					validation(
						`Work item ${item.id} has a malformed ${relation.rel} relation target`,
					);
				}
				if (target !== undefined && !known.has(target)) {
					missing.set(
						target,
						(missing.get(target) ?? false) || !forwardDependency,
					);
				}
			}
		}
		if (missing.size > 0) {
			for (const item of await this.client.getMany([...missing.keys()])) {
				if (!missing.get(item.id) && !this.taskId(item)) continue;
				this.requireInScope(item);
				remember(item);
			}
		}
		requireOwnedRelationEndpoints(items, known);
		return known;
	}

	private toTask(item: WorkItem, slugs: Map<number, string>): Task {
		const fields = item.fields;
		const id = this.taskId(item);
		if (!id) {
			validation(`Work item ${item.id} has no ${this.idField} value`);
		}
		const rawMeta = fields[this.metaField];
		const meta = parseMeta(rawMeta);
		const tags = parseTags(fields[F_TAGS]);
		const task: Task = {
			id,
			title: str(fields[F_TITLE]) ?? "",
			state: this.toState(String(fields[F_STATE] ?? "")),
			links: meta.links ?? [],
			deps: this.depsOf(item, slugs),
		};
		const kind = tagValue(tags, "kind");
		const repo = tagValue(tags, "repo");
		if (kind) task.kind = kind;
		if (repo) task.repo = repo;
		const body = str(fields[F_DESCRIPTION]);
		if (body) task.body = body;
		if (meta.hold) task.hold = meta.hold;
		if (meta.priority !== undefined) task.priority = meta.priority;
		const metaMissing =
			rawMeta == null || (typeof rawMeta === "string" && rawMeta.trim() === "");
		const created =
			meta.created ?? (metaMissing ? dateOnly(fields[F_CREATED]) : undefined);
		if (created) task.created = created;
		const updated = dateOnly(fields[F_CHANGED]);
		if (updated) task.updated = updated;
		// An ADO-only reopen/re-close between reads retains the last tasks-axi close date.
		const closed = meta.closed ?? meta.pending_closed;
		if (closed && task.state === "done") task.closed = closed;
		const followup = str(fields[this.followupField]);
		const hasFollowup = followup !== undefined && followup.trim() !== "";
		if ((kind === PUBLIC_FOLLOWUP_KIND) !== hasFollowup) {
			validation(
				"kind=public-followup and typed public_followup data must be present together",
			);
		}
		if (hasFollowup) {
			if (meta.hold) {
				validation("Public-followup obligations cannot use dispatch holds");
			}
			task.public_followup = decodePublicFollowup(followup);
			assertPublicFollowupTaskState(task.state, task.public_followup, id);
			assertPublicFollowupTaskContent(task, task.public_followup);
		}
		const extra = {
			...(meta.meta ?? {}),
			ado_id: item.id,
			ado_area: str(fields[F_AREA]),
		};
		task.meta = extra;
		return task;
	}

	private depsOf(item: WorkItem, slugs: Map<number, string>): Dep[] {
		const deps: Dep[] = [];
		const ownerId = slugs.get(item.id)!;
		for (const relation of item.relations ?? []) {
			const target = relationTargetId(relation.url);
			const slug = target === undefined ? undefined : slugs.get(target);
			if (!slug) continue;
			const text = comment(relation);
			if (relation.rel === REL_BLOCKED_BY) {
				deps.push(dep("blocked-by", slug, text));
			} else {
				const parent = parentReason(relation, ownerId);
				if (parent !== undefined) {
					deps.push(dep("parent", slug, parent));
					continue;
				}
				const discovered = discoveredReason(relation, ownerId);
				if (discovered !== undefined) {
					deps.push(dep("discovered-from", slug, discovered));
				}
			}
		}
		return deps;
	}

	async get(id: string): Promise<Task | null> {
		const item = await this.loadItem(id);
		if (!item) return null;
		return this.toTask(item, await this.slugMap([item]));
	}

	async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
		const ids = await this.client.queryIds(this.wiql([]));
		const workItems = await this.client.getMany(ids);
		for (const item of workItems) this.requireInScope(item);
		const slugs = await this.slugMap(workItems);
		let items = workItems.map((item) => this.toTask(item, slugs));
		if (query.state) items = items.filter((t) => t.state === query.state);
		if (query.repo) items = items.filter((t) => t.repo === query.repo);
		if (query.kind) items = items.filter((t) => t.kind === query.kind);
		const total = items.length;
		if (query.limit !== undefined && query.limit >= 0) {
			items = items.slice(0, query.limit);
		}
		return { items, total };
	}

	// ---------------------------------------------------------------------
	// Write helpers
	// ---------------------------------------------------------------------

	private metaBlob(task: Task, pendingClosed?: string): string {
		const blob: MetaBlob = { v: META_VERSION };
		if (task.priority !== undefined) blob.priority = task.priority;
		if (task.hold) blob.hold = task.hold;
		const links = normalizeTypedLinks(task.links);
		if (links.length > 0) blob.links = links;
		if (task.created) blob.created = task.created;
		if (pendingClosed) blob.pending_closed = pendingClosed;
		else if (task.closed) blob.closed = task.closed;
		const meta = { ...task.meta };
		delete meta.ado_id;
		delete meta.ado_area;
		if (Object.keys(meta).length > 0) blob.meta = meta;
		return JSON.stringify(blob);
	}

	/** Rebuild the tag string, preserving tags this backend does not own. */
	private tagString(item: WorkItem | undefined, task: Task): string {
		const foreign = parseTags(item?.fields[F_TAGS]).filter(
			(tag) => !tag.startsWith("kind:") && !tag.startsWith("repo:"),
		);
		const owned = [
			...(task.kind ? [`kind:${task.kind}`] : []),
			...(task.repo ? [`repo:${task.repo}`] : []),
		];
		return [...owned, ...foreign].join("; ");
	}

	private async applyPatch(
		item: WorkItem,
		ops: JsonPatchOp[],
		expectedArea?: string,
	): Promise<WorkItem> {
		if (item.rev === undefined) {
			throw new AxiError(
				`Work item ${item.id} has no revision; refusing an unguarded update`,
				"CONFLICT",
			);
		}
		const expectedId = this.taskId(item);
		if (!expectedId) {
			validation(`Work item ${item.id} has no ${this.idField} value`);
		}
		const updated = await this.client.update(item.id, [
			{ op: "test", path: "/rev", value: item.rev },
			...ops,
		]);
		this.requireMutationResult(updated, expectedId, expectedArea);
		requirePatchPostconditions(item, updated, ops);
		return updated;
	}

	private async rollbackRelations(
		item: WorkItem,
		relations: NonNullable<WorkItem["relations"]>,
	): Promise<void> {
		if (item.rev === undefined) {
			throw new AxiError(
				`Work item ${item.id} has no revision; refusing an unguarded update`,
				"CONFLICT",
			);
		}
		const available = (item.relations ?? []).map((relation, index) => ({
			index,
			key: normalizedRelations([relation])[0],
		}));
		const used = new Set<number>();
		const indexes = relations.map((relation) => {
			const key = normalizedRelations([relation])[0];
			const match = available.find(
				(candidate) => candidate.key === key && !used.has(candidate.index),
			);
			if (!match) {
				throw new AxiError(
					`Work item ${item.id} did not return an appended relation`,
					"CONFLICT",
				);
			}
			used.add(match.index);
			return match.index;
		});
		const ops: JsonPatchOp[] = indexes
			.sort((left, right) => right - left)
			.map((index) => ({ op: "remove", path: `/relations/${index}` }));
		const rolledBack = await this.client.update(item.id, [
			{ op: "test", path: "/rev", value: item.rev },
			...ops,
		]);
		if (rolledBack.id !== item.id) {
			throw new AxiError(
				`Azure DevOps returned work item ${rolledBack.id}, expected ${item.id}`,
				"CONFLICT",
			);
		}
		requirePatchPostconditions(item, rolledBack, ops);
	}

	/** Resolve dependency slugs to work item ids, failing on a missing target. */
	private async resolveDeps(deps: Dep[]): Promise<Map<string, number>> {
		const resolved = new Map<string, number>();
		for (const d of deps) {
			if (resolved.has(d.id)) continue;
			const item = await this.loadItem(d.id);
			if (!item) {
				const label = d.type === "blocked-by" ? "blocker" : "dependency";
				validation(`${label} "${d.id}" not found`, [
					"Create the dependency task first, or choose an existing task id",
				]);
			}
			resolved.set(d.id, item.id);
		}
		return resolved;
	}

	private async requireResolvedDeps(
		resolved: Map<string, number>,
	): Promise<Map<number, string>> {
		const slugs = new Map<number, string>();
		for (const [id, workItemId] of resolved) {
			const item = await this.loadItem(id);
			if (!item || item.id !== workItemId) {
				throw new AxiError(
					`Dependency "${id}" changed identity or scope while its relation was being written`,
					"CONFLICT",
				);
			}
			slugs.set(workItemId, id);
		}
		return slugs;
	}

	private relationValue(
		ownerId: string,
		dep: Dep,
		workItemId: number,
	): { rel: string; url: string; attributes?: Record<string, unknown> } {
		const rel =
			dep.type === "blocked-by"
				? REL_BLOCKED_BY
				: dep.type === "parent"
					? REL_PARENT
					: REL_RELATED;
		const marker = dep.type === "parent" ? PARENT_MARKER : DISCOVERED_MARKER;
		const text =
			dep.type === "blocked-by"
				? dep.reason
				: dep.reason
					? `${marker}:${ownerId}: ${dep.reason}`
					: `${marker}:${ownerId}`;
		return {
			rel,
			url: this.client.workItemUrl(workItemId),
			...(text ? { attributes: { comment: text } } : {}),
		};
	}

	// ---------------------------------------------------------------------
	// CRUD
	// ---------------------------------------------------------------------

	async create(input: TaskInput): Promise<Task> {
		const id = validateId(input.id);
		const state: State = input.state ?? "queued";
		const initialState: State = "queued";
		const title = normalizeTitle(input.title);
		const kind = normalizeTagValue(input.kind, "kind");
		const repo = normalizeTagValue(input.repo, "repo");
		const hold = normalizeHold(input.hold);
		const priority = normalizePriority(input.priority);
		const deps = [
			...new Map(
				(input.deps ?? []).map((value) => {
					const dep = normalizeDep(id, value);
					return [`${dep.type}:${dep.id}`, dep] as const;
				}),
			).values(),
		];

		let publicFollowup;
		if (kind === PUBLIC_FOLLOWUP_KIND) {
			if (hold) {
				validation("Public-followup obligations cannot use dispatch holds");
			}
			if (!input.public_followup) {
				validation("kind=public-followup requires typed public_followup data", [
					"Use `tasks-axi public-followup add ...`",
				]);
			}
			publicFollowup = normalizePublicFollowup(input.public_followup);
			if (
				publicFollowup.revision !== 1 ||
				publicFollowup.delivery.state !== "intent" ||
				publicFollowup.work_relations.length !== 0 ||
				state !== "queued"
			) {
				validation(
					"New public-followup must start as a revision 1 queued intent",
					["Use `tasks-axi public-followup add ...`"],
				);
			}
			assertPublicFollowupTaskState(state, publicFollowup, id);
			assertPublicFollowupTaskContent(
				{ title, body: input.body, links: input.links ?? [] },
				publicFollowup,
			);
		} else if (input.public_followup) {
			validation("Typed public_followup data requires kind=public-followup");
		}

		// ADO cannot enforce custom-field uniqueness: concurrent creates can both
		// pass this precheck, after which the read-side duplicate guard fails closed.
		if ((await this.findWorkItemId(id)) !== undefined) {
			throw new AxiError(`Task "${id}" already exists`, "CONFLICT");
		}
		const depIds = await this.resolveDeps(deps);

		const task: Task = {
			id,
			title,
			state,
			links: input.links ?? [],
			deps,
		};
		if (kind) task.kind = kind;
		if (repo) task.repo = repo;
		if (input.body) task.body = input.body;
		if (hold) task.hold = hold;
		if (priority !== undefined) task.priority = priority;
		if (publicFollowup) task.public_followup = publicFollowup;
		if (input.meta) task.meta = input.meta;
		if (input.created !== undefined) {
			if (input.created !== null) {
				task.created = normalizeDate(input.created, "created date");
			}
		} else if (state !== "done") {
			task.created = this.now();
		}
		const requestedClose =
			input.closed === undefined
				? undefined
				: normalizeDate(input.closed, "closed date");
		if (requestedClose) task.closed = requestedClose;
		let retryVerb: "start" | "done" | undefined;
		if (state === "in_flight") retryVerb = "start";
		if (state === "done") retryVerb = "done";
		const retrySuggestion = retryVerb
			? `Run \`tasks-axi show ${id}\`, then \`tasks-axi ${retryVerb} ${id}\` if needed`
			: `Run \`tasks-axi show ${id}\` before retrying creation`;

		const ops: JsonPatchOp[] = [
			add(`/fields/${this.idField}`, id),
			add(`/fields/${F_TITLE}`, title),
			add(`/fields/${F_STATE}`, this.adoState(initialState)),
			add(
				`/fields/${this.metaField}`,
				this.metaBlob(task, state === "done" ? requestedClose : undefined),
			),
		];
		if (this.area) ops.push(add(`/fields/${F_AREA}`, this.area));
		if (task.body) ops.push(add(`/fields/${F_DESCRIPTION}`, task.body));
		const tags = this.tagString(undefined, task);
		if (tags) ops.push(add(`/fields/${F_TAGS}`, tags));
		if (publicFollowup) {
			ops.push(
				add(
					`/fields/${this.followupField}`,
					encodePublicFollowup(publicFollowup),
				),
			);
		}
		const depRelations = deps.map((dep) =>
			this.relationValue(id, dep, depIds.get(dep.id)!),
		);
		for (const relation of depRelations) {
			ops.push(add("/relations/-", relation));
		}

		let createdTask: Task;
		let created: WorkItem | undefined;
		let initialCreateReturned = false;
		try {
			created = await this.client.create(this.workItemType, ops);
			initialCreateReturned = true;
			this.requireMutationResult(created, id);
			requirePatchPostconditions(
				{ id: created.id, fields: {}, relations: [] },
				created,
				ops,
			);
			const slugs = await this.requireResolvedDeps(depIds);
			slugs.set(created.id, id);
			createdTask = this.toTask(created, slugs);
		} catch (error) {
			if (created && depRelations.length > 0) {
				try {
					await this.rollbackRelations(created, depRelations);
				} catch (rollbackError) {
					const verificationMessage =
						error instanceof Error ? error.message : String(error);
					const rollbackMessage =
						rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError);
					throw new AxiError(
						`Task "${id}" post-create verification has an unconfirmed outcome: ${verificationMessage}; dependency rollback could not be confirmed: ${rollbackMessage}`,
						"CONFLICT",
						[
							`Inspect Azure DevOps work item ${created.id} directly and remove the appended dependency relations before retrying`,
						],
					);
				}
			}
			unconfirmedCreate(
				id,
				initialCreateReturned ? "post-create verification" : "creation",
				error,
				retrySuggestion,
				initialCreateReturned,
			);
		}
		if (state !== initialState) {
			try {
				return await this.transition(
					id,
					state,
					state === "done" && requestedClose ? { date: requestedClose } : {},
				);
			} catch (error) {
				unconfirmedCreate(
					id,
					`transition to ${state}`,
					error,
					retrySuggestion,
					true,
				);
			}
		}
		return createdTask;
	}

	async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
		const item = await this.requireItem(id);
		const slugs = await this.slugMap([item]);
		const task = this.toTask(item, slugs);
		const pendingClose =
			task.state === "done"
				? undefined
				: parseMeta(item.fields[this.metaField]).pending_closed;

		if (
			isPublicFollowupTask(task) &&
			(patch.title !== undefined ||
				patch.body !== undefined ||
				patch.archiveBody ||
				(patch.addBodyLines?.length ?? 0) > 0 ||
				(patch.addLinks?.length ?? 0) > 0 ||
				patch.hold !== undefined)
		) {
			validation(
				"Public-followup content and holds cannot change through generic update",
				["Create a successor obligation when the public promise changes"],
			);
		}
		if (patch.archiveBody) {
			throw new AxiError(
				"The ado backend does not support body archiving",
				"UNSUPPORTED",
				["Drop --archive-body, or keep the superseded notes in the body"],
			);
		}

		const changed: TaskUpdateChange[] = [];
		const mark = (field: TaskUpdateChange) => {
			if (!changed.includes(field)) changed.push(field);
		};
		const ops: JsonPatchOp[] = [];

		if (patch.title !== undefined) {
			const title = normalizeTitle(patch.title);
			if (task.title !== title) {
				task.title = title;
				mark("title");
			}
		}
		if (patch.body !== undefined) {
			const body = patch.body || undefined;
			if (task.body !== body) {
				task.body = body;
				mark("body");
			}
		}
		for (const line of patch.addBodyLines ?? []) {
			if (line !== "" && !bodyHasLine(task.body, line)) {
				task.body = task.body ? `${task.body}\n${line}` : line;
				mark("body");
			}
		}
		if (patch.repo !== undefined) {
			const repo = normalizeTagValue(patch.repo, "repo");
			if (task.repo !== repo) {
				if (repo === undefined) delete task.repo;
				else task.repo = repo;
				mark("repo");
			}
		}
		if (patch.kind !== undefined) {
			const kind = normalizeTagValue(patch.kind, "kind");
			if (task.kind === PUBLIC_FOLLOWUP_KIND || kind === PUBLIC_FOLLOWUP_KIND) {
				validation(
					"Public-followup kind cannot be changed through generic update",
					["Use the dedicated `tasks-axi public-followup` commands"],
				);
			}
			if (task.kind !== kind) {
				if (kind === undefined) delete task.kind;
				else task.kind = kind;
				mark("kind");
			}
		}
		if (patch.hold !== undefined) {
			const hold = normalizeHold(patch.hold ?? undefined);
			if (!sameHold(task.hold, hold)) {
				if (hold) task.hold = hold;
				else delete task.hold;
				mark("hold");
			}
		}
		if (patch.priority !== undefined) {
			const priority = normalizePriority(patch.priority);
			if (task.priority !== priority) {
				task.priority = priority;
				mark("priority");
			}
		}
		if (patch.meta) {
			const incoming = { ...patch.meta };
			delete incoming.ado_id;
			delete incoming.ado_area;
			const meta = { ...task.meta, ...incoming };
			if (JSON.stringify(meta) !== JSON.stringify(task.meta)) {
				task.meta = meta;
				mark("meta");
			}
		}
		for (const link of normalizeTypedLinks(patch.addLinks ?? [])) {
			if (!task.links.some((l) => l.kind === link.kind && l.url === link.url)) {
				task.links = [...task.links, link];
				mark("links");
			}
		}
		if (changed.length === 0) return { task, changed };

		if (changed.includes("title")) {
			ops.push(add(`/fields/${F_TITLE}`, task.title));
		}
		if (changed.includes("body")) {
			ops.push(add(`/fields/${F_DESCRIPTION}`, task.body ?? ""));
		}
		if (changed.includes("kind") || changed.includes("repo")) {
			ops.push(add(`/fields/${F_TAGS}`, this.tagString(item, task)));
		}
		ops.push(
			add(`/fields/${this.metaField}`, this.metaBlob(task, pendingClose)),
		);

		const updated = await this.applyPatch(item, ops);
		return { task: this.toTask(updated, slugs), changed };
	}

	async remove(id: string): Promise<Task> {
		const item = await this.requireItem(id);
		const task = this.toTask(item, await this.slugMap([item]));
		if (
			isPublicFollowupTask(task) &&
			task.public_followup &&
			!isPublicFollowupTerminal(task.public_followup)
		) {
			validation("Active public-followup obligations cannot be removed", [
				"Record a posted receipt or Captain-approved waiver first",
			]);
		}
		await this.requireNoActiveDependents(id);
		// The dependent check is a best-effort snapshot: a concurrent addDep can race ADO's unconditional DELETE, but recycle-bin removal is recoverable.
		await this.client.remove(item.id);
		return task;
	}

	private async requireNoActiveDependents(id: string): Promise<void> {
		const { items } = await this.list({});
		const dependents = items
			.filter(
				(task) =>
					task.state !== "done" &&
					task.id !== id &&
					task.deps.some((d) => d.type === "blocked-by" && d.id === id),
			)
			.map((task) => task.id);
		if (dependents.length === 0) return;
		validation(
			`Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
			[
				`Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
			],
		);
	}

	/** Cross-queue move: the destination is an ADO area path, not a file. */
	async moveTo(id: string, areaPath: string): Promise<Task> {
		const area = areaPath.trim();
		if (area === "" || /[\r\n]/.test(area)) {
			validation("Target area path must be a non-empty single line");
		}
		const item = await this.requireItem(id);
		const task = this.toTask(item, await this.slugMap([item]));
		if (str(item.fields[F_AREA]) === area) return task;
		const destinationIds = await this.client.queryIds(
			this.wiql([`[${this.idField}] = '${sq(id)}'`], area),
		);
		if (destinationIds.some((workItemId) => workItemId !== item.id)) {
			throw new AxiError(
				`Task "${id}" already exists in Azure DevOps area "${area}"`,
				"CONFLICT",
			);
		}
		if (!this.isAreaInScope(area)) {
			const { items } = await this.list({});
			const current = items.find((candidate) => candidate.id === id);
			if (!current) {
				throw new AxiError(
					`Task "${id}" left the configured Azure DevOps area before it could be moved`,
					"CONFLICT",
				);
			}
			let source = id;
			let edge: Dep | undefined = current.deps[0];
			if (!edge) {
				for (const candidate of items) {
					edge = candidate.deps.find((dep) => dep.id === id);
					if (edge) {
						source = candidate.id;
						break;
					}
				}
			}
			if (edge) {
				validation(
					`Moving "${id}" would split ${edge.type} relation "${source}" -> "${edge.id}" across the configured Azure DevOps area`,
					["Remove the relation before moving the task outside this area"],
				);
			}
		}
		const moved = await this.applyPatch(
			item,
			[add(`/fields/${F_AREA}`, area)],
			area,
		);
		return this.toTask(moved, await this.slugMap([moved]));
	}

	// ---------------------------------------------------------------------
	// State + dependencies
	// ---------------------------------------------------------------------

	async transition(
		id: string,
		to: State,
		opts: TransitionOpts = {},
	): Promise<Task> {
		const item = await this.requireItem(id);
		const slugs = await this.slugMap([item]);
		const task = this.toTask(item, slugs);
		if (isPublicFollowupTask(task)) {
			validation(
				"Public-followup state cannot change through generic transitions",
				[
					"Use `tasks-axi public-followup record-delivery` or `tasks-axi public-followup waive`",
				],
			);
		}
		const already = task.state === to;
		const pendingClose =
			task.state === "done"
				? undefined
				: parseMeta(item.fields[this.metaField]).pending_closed;
		const date = normalizeDate(
			(to === "done" && already ? task.closed : undefined) ??
				opts.date ??
				(to === "done" ? pendingClose : undefined) ??
				this.now(),
			"transition date",
		);

		if (opts.pr !== undefined)
			task.links = [...task.links, { kind: "pr", url: opts.pr }];
		if (opts.report !== undefined) {
			task.links = [...task.links, { kind: "report", url: opts.report }];
		}
		if (opts.note)
			task.body = task.body ? `${task.body}\n${opts.note}` : opts.note;

		task.state = to;
		if (to === "done") {
			task.closed = date;
		} else {
			delete task.closed;
			if (to === "in_flight" && !task.created) task.created = date;
		}

		const ops: JsonPatchOp[] = [
			add(`/fields/${this.metaField}`, this.metaBlob(task)),
		];
		if (!already) ops.unshift(add(`/fields/${F_STATE}`, this.adoState(to)));
		if (opts.note) ops.push(add(`/fields/${F_DESCRIPTION}`, task.body ?? ""));
		const updated = await this.applyPatch(item, ops);
		return this.toTask(updated, slugs);
	}

	async addDep(id: string, dep: Dep): Promise<boolean> {
		const checked = normalizeDep(id, dep);
		const item = await this.requireItem(id);
		const slugs = await this.slugMap([item]);
		const task = this.toTask(item, slugs);
		if (
			task.public_followup &&
			!["intent", "pending-work", "ready"].includes(
				task.public_followup.delivery.state,
			)
		) {
			validation("Cannot add blockers after public delivery has started");
		}
		if (task.deps.some((d) => d.type === checked.type && d.id === checked.id)) {
			return false;
		}
		const resolved = await this.resolveDeps([checked]);
		const relation = this.relationValue(
			task.id,
			checked,
			resolved.get(checked.id)!,
		);
		if (item.rev === undefined) {
			throw new AxiError(
				`Work item ${item.id} has no revision; refusing an unguarded update`,
				"CONFLICT",
			);
		}
		const expectedId = this.taskId(item);
		if (!expectedId) {
			validation(`Work item ${item.id} has no ${this.idField} value`);
		}
		const ops = [add("/relations/-", relation)];
		let updated: WorkItem | undefined;
		try {
			updated = await this.client.update(item.id, [
				{ op: "test", path: "/rev", value: item.rev },
				...ops,
			]);
			this.requireMutationResult(updated, expectedId);
			requirePatchPostconditions(item, updated, ops);
			await this.requireResolvedDeps(resolved);
		} catch (verificationError) {
			if (!updated) {
				if (isDefinitiveAdoRejection(verificationError)) {
					throw verificationError;
				}
				const verificationMessage =
					verificationError instanceof Error
						? verificationError.message
						: String(verificationError);
				throw new AxiError(
					`Task "${id}" dependency update has an unconfirmed outcome: ${verificationMessage}`,
					"CONFLICT",
					[
						`Inspect task "${id}" in Azure DevOps and remove the appended ${checked.type} relation before retrying`,
					],
				);
			}
			try {
				await this.rollbackRelations(updated, [relation]);
			} catch (rollbackError) {
				const verificationMessage =
					verificationError instanceof Error
						? verificationError.message
						: String(verificationError);
				const rollbackMessage =
					rollbackError instanceof Error
						? rollbackError.message
						: String(rollbackError);
				throw new AxiError(
					`Task "${id}" dependency update has an unconfirmed outcome: ${verificationMessage}; rollback could not be confirmed: ${rollbackMessage}`,
					"CONFLICT",
					[
						`Inspect task "${id}" in Azure DevOps and remove the appended ${checked.type} relation before retrying`,
					],
				);
			}
			throw verificationError;
		}
		return true;
	}

	async removeDep(id: string, dep: Dep): Promise<boolean> {
		const depId = validateDependencyId(dep.id);
		const item = await this.requireItem(id);
		const slugs = await this.slugMap([item]);
		const relations = item.relations ?? [];
		const ownerId = slugs.get(item.id)!;
		const indices = relations.flatMap((relation, index) => {
			const target = relationTargetId(relation.url);
			const targetId = target === undefined ? undefined : slugs.get(target);
			if (targetId !== depId) {
				if (targetId?.toLowerCase() === depId.toLowerCase()) {
					throw new AxiError(
						`Task "${depId}" changed identity while it was being loaded`,
						"CONFLICT",
						["Retry the command after checking the Azure DevOps join field"],
					);
				}
				return [];
			}
			const matches =
				dep.type === "blocked-by"
					? relation.rel === REL_BLOCKED_BY
					: dep.type === "parent"
						? parentReason(relation, ownerId) !== undefined
						: discoveredReason(relation, ownerId) !== undefined;
			return matches ? [index] : [];
		});
		if (indices.length === 0) return false;
		await this.applyPatch(
			item,
			indices
				.reverse()
				.map((index) => ({ op: "remove", path: `/relations/${index}` })),
		);
		return true;
	}

	async updatePublicFollowup(
		id: string,
		mutation: PublicFollowupMutation,
	): Promise<Task> {
		const item = await this.requireItem(id);
		const slugs = await this.slugMap([item]);
		const task = this.toTask(item, slugs);
		if (!isPublicFollowupTask(task) || !task.public_followup) {
			validation(`Task "${id}" is not a public-followup obligation`);
		}
		const expected = normalizePublicFollowup(mutation.expectedPublicFollowup);
		if (
			task.public_followup.revision !== mutation.expectedRevision ||
			expected.revision !== mutation.expectedRevision ||
			!canonicalEqual(task.public_followup, expected)
		) {
			throw new AxiError(
				`Public-followup "${id}" changed; retry the command`,
				"CONFLICT",
				["Read the latest obligation revision, then retry"],
			);
		}
		if (task.state === "done") {
			throw new AxiError(
				`Public-followup "${id}" is already complete`,
				"CONFLICT",
			);
		}
		if (mutation.requireUnblocked) {
			// ponytail: blocker state is read, then only the obligation revision is tested.
			// Serialize graph-sensitive ADO writes if blocker reopen races matter in practice.
			const { items } = await this.list({});
			const byId = new Map(items.map((entry) => [entry.id, entry]));
			const blocked = task.deps.some((d) => {
				if (d.type !== "blocked-by") return false;
				const blocker = byId.get(d.id);
				return blocker !== undefined && blocker.state !== "done";
			});
			if (blocked) {
				validation(
					"Cannot begin delivery while the obligation has an active blocker",
				);
			}
		}

		const next = normalizePublicFollowup(mutation.publicFollowup);
		assertPublicFollowupMutation(task.public_followup, next);
		if (mutation.complete && !isPublicFollowupTerminal(next)) {
			validation(
				"Only a posted receipt or Captain-approved waiver may complete a public-followup",
			);
		}
		if (!mutation.complete && isPublicFollowupTerminal(next)) {
			validation(
				"Terminal public-followup data requires an atomic completion mutation",
			);
		}

		task.public_followup = next;
		const ops: JsonPatchOp[] = [
			add(`/fields/${this.followupField}`, encodePublicFollowup(next)),
		];
		if (mutation.complete) {
			task.state = "done";
			task.closed = this.now();
			assertPublicFollowupTaskState(task.state, next, id);
			ops.push(add(`/fields/${F_STATE}`, this.adoState("done")));
		} else {
			assertPublicFollowupTaskState(task.state, next, id);
		}
		ops.push(add(`/fields/${this.metaField}`, this.metaBlob(task)));
		const updated = await this.applyPatch(item, ops);
		return this.toTask(updated, slugs);
	}
}

function add(path: string, value: unknown): JsonPatchOp {
	return { op: "add", path, value };
}

function dep(type: Dep["type"], id: string, reason: string): Dep {
	return reason.trim() === ""
		? { type, id }
		: { type, id, reason: reason.trim() };
}

function tagValue(tags: string[], prefix: string): string | undefined {
	const matches = tags.filter((tag) => tag.startsWith(`${prefix}:`));
	if (matches.length > 1) {
		validation(`Azure DevOps work item has multiple ${prefix}: tags`);
	}
	const match = matches[0];
	return match ? match.slice(prefix.length + 1).trim() || undefined : undefined;
}

function bodyHasLine(body: string | undefined, line: string): boolean {
	return (body ?? "").split("\n").some((entry) => entry.trim() === line.trim());
}

/** Escape a WIQL single-quoted literal. */
function sq(value: string): string {
	return value.replace(/'/g, "''");
}
