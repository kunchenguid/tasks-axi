import { AxiError } from "../../src/errors.js";
import type {
	AdoClient,
	JsonPatchOp,
	WorkItem,
	WorkItemRelation,
} from "../../src/backends/ado-client.js";

/**
 * In-memory stand-in for the Azure DevOps REST surface: enough JSON-patch and
 * WIQL semantics to drive the store without touching a live project.
 */
export class FakeAdoClient implements AdoClient {
	readonly items = new Map<number, WorkItem>();
	private nextId = 1;
	/** Every mutating call, so tests can assert the wire shape. */
	readonly calls: { kind: string; id?: number; patch?: JsonPatchOp[] }[] = [];

	constructor(
		private readonly idField = "Custom.TasksAxiId",
		private readonly project = "Internal",
	) {}

	workItemUrl(id: number): string {
		return `https://dev.azure.com/org/_apis/wit/workItems/${id}`;
	}

	async queryIds(wiql: string): Promise<number[]> {
		const byId = new RegExp(
			`\\[${escapeRegExp(this.idField)}\\] = '([^']*)'`,
		).exec(wiql);
		const project = /\[System\.TeamProject\] = '([^']*)'/.exec(wiql);
		const workItemType = /\[System\.WorkItemType\] = '([^']*)'/.exec(wiql);
		const area = /UNDER '([^']*)'/.exec(wiql);
		return [...this.items.values()]
			.filter((item) => {
				const slug = item.fields[this.idField];
				if (typeof slug !== "string" || slug === "") return false;
				if (
					byId &&
					slug.toLowerCase() !== byId[1].replace(/''/g, "'").toLowerCase()
				) {
					return false;
				}
				if (
					project &&
					item.fields["System.TeamProject"] !== project[1].replace(/''/g, "'")
				) {
					return false;
				}
				if (
					workItemType &&
					String(item.fields["System.WorkItemType"] ?? "").toLowerCase() !==
						workItemType[1].replace(/''/g, "'").toLowerCase()
				) {
					return false;
				}
				if (area) {
					const path = String(item.fields["System.AreaPath"] ?? "");
					if (path !== area[1] && !path.startsWith(`${area[1]}\\`))
						return false;
				}
				return true;
			})
			.map((item) => item.id);
	}

	async getMany(ids: number[]): Promise<WorkItem[]> {
		const items = ids.flatMap((id) => {
			const item = this.items.get(id);
			return item ? [item] : [];
		});
		const expected = new Set(ids);
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
		return items.map(clone);
	}

	async get(id: number): Promise<WorkItem | null> {
		const item = this.items.get(id);
		return item ? clone(item) : null;
	}

	async create(type: string, patch: JsonPatchOp[]): Promise<WorkItem> {
		const item: WorkItem = {
			id: this.nextId++,
			rev: 1,
			fields: {
				"System.WorkItemType": type,
				"System.TeamProject": this.project,
				"System.CreatedDate": "2026-06-22T09:00:00Z",
				"System.ChangedDate": "2026-06-22T09:00:00Z",
			},
			relations: [],
		};
		this.calls.push({ kind: "create", patch });
		applyPatch(item, patch);
		this.items.set(item.id, item);
		this.syncRelations(item, []);
		return clone(item);
	}

	async update(id: number, patch: JsonPatchOp[]): Promise<WorkItem> {
		const item = this.items.get(id);
		if (!item) throw new AxiError(`work item ${id} not found`, "NOT_FOUND");
		const previousRelations = structuredClone(item.relations ?? []);
		this.calls.push({ kind: "update", id, patch });
		applyPatch(item, patch);
		this.syncRelations(item, previousRelations);
		item.rev = (item.rev ?? 0) + 1;
		item.fields["System.ChangedDate"] = "2026-06-23T09:00:00Z";
		return clone(item);
	}

	async remove(id: number): Promise<void> {
		this.calls.push({ kind: "remove", id });
		this.items.delete(id);
	}

	private syncRelations(item: WorkItem, previous: WorkItemRelation[]): void {
		const current = (item.relations ?? []).filter(hasCompanion);
		for (const relation of previous.filter(hasCompanion)) {
			if (current.some((candidate) => sameRelation(candidate, relation)))
				continue;
			const target = this.items.get(workItemId(relation.url));
			const companion = relationCompanion(relation, this.workItemUrl(item.id));
			if (!target || !companion) continue;
			target.relations = (target.relations ?? []).filter(
				(candidate) => !sameRelation(candidate, companion),
			);
		}
		for (const relation of current) {
			if (previous.some((candidate) => sameRelation(candidate, relation)))
				continue;
			const target = this.items.get(workItemId(relation.url));
			const companion = relationCompanion(relation, this.workItemUrl(item.id));
			if (!target || !companion) continue;
			target.relations = [...(target.relations ?? []), companion];
		}
	}
}

function hasCompanion(relation: WorkItemRelation): boolean {
	return relationCompanion(relation, relation.url) !== undefined;
}

function relationCompanion(
	relation: WorkItemRelation,
	url: string,
): WorkItemRelation | undefined {
	const rel =
		relation.rel === "System.LinkTypes.Related"
			? relation.rel
			: relation.rel === "System.LinkTypes.Dependency-Reverse"
				? "System.LinkTypes.Dependency-Forward"
				: relation.rel === "System.LinkTypes.Dependency-Forward"
					? "System.LinkTypes.Dependency-Reverse"
					: undefined;
	return rel ? { ...structuredClone(relation), rel, url } : undefined;
}

function sameRelation(a: WorkItemRelation, b: WorkItemRelation): boolean {
	return (
		a.rel === b.rel &&
		a.url === b.url &&
		JSON.stringify(a.attributes ?? {}) === JSON.stringify(b.attributes ?? {})
	);
}

function workItemId(url: string): number {
	const match = /\/workItems\/(\d+)(?:\?.*)?$/i.exec(url);
	return match ? Number(match[1]) : -1;
}

function applyPatch(item: WorkItem, patch: JsonPatchOp[]): void {
	const parentCount =
		(item.relations ?? []).filter(
			(relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse",
		).length +
		patch.filter(
			(op) =>
				op.path === "/relations/-" &&
				(op.value as WorkItemRelation | undefined)?.rel ===
					"System.LinkTypes.Hierarchy-Reverse",
		).length;
	if (parentCount > 1) {
		throw new AxiError(
			"Azure DevOps work items can have only one parent",
			"VALIDATION_ERROR",
		);
	}
	for (const op of patch) {
		if (op.op === "test") {
			if (op.path === "/rev" && op.value !== item.rev) {
				throw new AxiError("work item revision mismatch", "CONFLICT");
			}
			continue;
		}
		if (op.path === "/relations/-") {
			item.relations = [
				...(item.relations ?? []),
				op.value as WorkItemRelation,
			];
			continue;
		}
		const relationIndex = /^\/relations\/(\d+)$/.exec(op.path);
		if (relationIndex) {
			const index = Number(relationIndex[1]);
			const relations = [...(item.relations ?? [])];
			if (op.op !== "remove") throw new AxiError("unsupported op", "UNKNOWN");
			relations.splice(index, 1);
			item.relations = relations;
			continue;
		}
		const field = /^\/fields\/(.+)$/.exec(op.path);
		if (!field) throw new AxiError(`unsupported path ${op.path}`, "UNKNOWN");
		if (op.op === "remove") delete item.fields[field[1]];
		else item.fields[field[1]] = op.value;
	}
}

function clone(item: WorkItem): WorkItem {
	return structuredClone(item);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
