import { describe, expect, it } from "vitest";
import { adoError } from "../../src/backends/ado-client.js";
import { AdoStore } from "../../src/backends/ado.js";
import { AxiError } from "../../src/errors.js";
import type { PublicFollowup } from "../../src/public-followup.js";
import type { Store } from "../../src/store.js";
import { FakeAdoClient } from "./fake-ado.js";

const ID_FIELD = "Custom.TasksAxiId";
const META_FIELD = "Custom.TasksAxiMeta";
const FOLLOWUP_FIELD = "Custom.TasksAxiPublicFollowup";

function makeStore(): { store: AdoStore; client: FakeAdoClient } {
	const client = new FakeAdoClient(ID_FIELD);
	const store = new AdoStore({
		client,
		project: "Internal",
		area: "Internal\\Firstmate\\main",
		workItemType: "Task",
		idField: ID_FIELD,
		metaField: META_FIELD,
		followupField: FOLLOWUP_FIELD,
		states: {
			queued: ["New", "To Do"],
			in_flight: ["Active"],
			done: ["Closed", "Done"],
		},
		now: () => "2026-06-22",
	});
	return { store, client };
}

function intent(): PublicFollowup {
	return {
		schema_version: 1,
		revision: 1,
		request: {
			request_id: "req-public-demo",
			platform: "discord",
			context_binding: { version: "ctx1", value: "ctx1_opaque_demo" },
			public_safe_summary: "Follow up when the public-safe fix ships",
			received_at: "2026-07-13T12:00:00Z",
			followup_expires_at: "2026-08-13T12:00:00Z",
			reservation_expires_at: "2026-09-13T12:00:00Z",
		},
		purpose: "promised-final",
		expected_final: {
			type: "pr-merged",
			project: "demo",
			required_deliverables: ["pr_url"],
			completion_policy: "all-required",
		},
		obligation_expires_at: "2026-10-01T00:00:00Z",
		delivery: {
			state: "intent",
			delivery_key: "fd1_demo_key",
			payload_digest: null,
			attempt_count: 0,
			last_error_code: null,
			next_attempt_at: null,
			receipt: null,
			last_error: null,
			waiver: null,
		},
		work_relations: [],
		lineage: {
			predecessor_obligation_id: null,
			successor_obligation_id: null,
		},
	};
}

describe("AdoStore", () => {
	it("reports its capabilities without prune or render", () => {
		const store: Store = makeStore().store;
		const caps = store.capabilities();
		expect(caps.backend).toBe("ado");
		expect(caps.deps).toBe(true);
		expect(caps.prune).toBe(false);
		expect(caps.fileMoves).toBe(false);
		expect(store.prune).toBeUndefined();
		expect(store.render).toBeUndefined();
	});

	describe("create / get / list", () => {
		it("creates a queued work item and reads it back", async () => {
			const { store, client } = makeStore();
			const task = await store.create({
				id: "new-task-q1",
				title: "a brand new task",
				kind: "ship",
				repo: "demo",
				body: "notes",
				priority: 2,
			});
			expect(task.state).toBe("queued");
			expect(task.created).toBe("2026-06-22");

			const item = [...client.items.values()][0];
			expect(item.fields["System.State"]).toBe("New");
			expect(item.fields["System.Title"]).toBe("a brand new task");
			expect(item.fields["System.AreaPath"]).toBe("Internal\\Firstmate\\main");
			expect(item.fields["System.Description"]).toBe("notes");
			expect(item.fields["System.Tags"]).toBe("kind:ship; repo:demo");

			const got = await store.get("new-task-q1");
			expect(got?.title).toBe("a brand new task");
			expect(got?.kind).toBe("ship");
			expect(got?.repo).toBe("demo");
			expect(got?.priority).toBe(2);
			expect(got?.body).toBe("notes");
			expect(got?.meta?.ado_id).toBe(item.id);
		});

		it("round-trips multiline plain-text bodies through System.Description", async () => {
			const { store, client } = makeStore();
			const body = "Use <script> & \"quotes\".\nKeep 'apostrophes' literal.";
			const task = await store.create({
				id: "encoded-body-a1",
				title: "encoded body",
				body,
			});

			expect(task.body).toBe(body);
			const item = [...client.items.values()][0];
			expect(item.fields["System.Description"]).toBe(
				"Use &lt;script&gt; &amp; &quot;quotes&quot;.<br>Keep &#39;apostrophes&#39; literal.",
			);
			expect((await store.get("encoded-body-a1"))?.body).toBe(body);

			const updated = await store.update("encoded-body-a1", {
				body: `${body}\nUpdated > before`,
			});
			expect(updated.task.body).toBe(`${body}\nUpdated > before`);
			expect(item.fields["System.Description"]).toBe(
				"Use &lt;script&gt; &amp; &quot;quotes&quot;.<br>Keep &#39;apostrophes&#39; literal.<br>Updated &gt; before",
			);
		});

		it("preserves an omitted created date in valid metadata", async () => {
			const { store, client } = makeStore();
			const task = await store.create({
				id: "no-created-a1",
				title: "done without created date",
				state: "done",
				created: null,
			});

			expect(task.created).toBeUndefined();
			expect((await store.get("no-created-a1"))?.created).toBeUndefined();
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			delete item.fields[META_FIELD];
			expect((await store.get("no-created-a1"))?.created).toBe("2026-06-22");
		});

		it("creates in-flight work in the queued state before transitioning", async () => {
			const { store, client } = makeStore();
			const task = await store.create({
				id: "started-task-a1",
				title: "start after creation",
				state: "in_flight",
			});

			expect(task.state).toBe("in_flight");
			expect(
				client.calls[0]?.patch?.find((op) => op.path === "/fields/System.State")
					?.value,
			).toBe("New");
			expect(
				client.calls[1]?.patch?.find((op) => op.path === "/fields/System.State")
					?.value,
			).toBe("Active");
		});

		it("reports an unconfirmed outcome when the create response fails", async () => {
			const { store, client } = makeStore();
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				await create(type, patch);
				throw new AxiError("create response lost", "VALIDATION_ERROR");
			};

			await expect(
				store.create({
					id: "uncertain-create-a1",
					title: "inspect before retrying",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "uncertain-create-a1" creation has an unconfirmed outcome',
				),
				suggestions: [
					"Run `tasks-axi show uncertain-create-a1` before retrying creation",
				],
			});
			expect([...client.items.values()]).toHaveLength(1);
			expect(client.calls.some((call) => call.kind === "remove")).toBe(false);
		});

		it("points recovery at the numeric work item after an out-of-scope create", async () => {
			const { store, client } = makeStore();
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				const created = await create(type, patch);
				created.fields["System.AreaPath"] = "Internal\\Other";
				const persisted = client.items.get(created.id);
				if (!persisted) throw new Error("expected the created work item");
				persisted.fields["System.AreaPath"] = "Internal\\Other";
				return created;
			};

			await expect(
				store.create({
					id: "moved-create-a1",
					title: "find the persisted work item",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect(await store.get("moved-create-a1")).toBeNull();
		});

		it("preserves a definitive create rejection", async () => {
			const { store, client } = makeStore();
			client.create = async () => {
				throw adoError(
					403,
					JSON.stringify({ message: "PAT lacks Work Items write scope" }),
				);
			};

			await expect(
				store.create({
					id: "rejected-create-a1",
					title: "preserve the credential error",
				}),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: expect.stringContaining(
					"Azure DevOps rejected the credential (403)",
				),
				suggestions: expect.arrayContaining([
					"Or run `az login` for a bearer token",
				]),
			});
			expect(client.items.size).toBe(0);
		});

		it("reports a definitive post-create verification failure as unconfirmed", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "verified-blocker-a1", title: "blocker" });
			const get = client.get.bind(client);
			let reads = 0;
			client.get = async (id) => {
				reads += 1;
				if (reads === 2) {
					throw adoError(403, "credential expired after create");
				}
				return get(id);
			};

			await expect(
				store.create({
					id: "verified-dependent-a1",
					title: "dependent",
					deps: [{ type: "blocked-by", id: "verified-blocker-a1" }],
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(
					/^Task "verified-dependent-a1" post-create verification has an unconfirmed outcome.*; its existence and state could not be confirmed$/,
				),
				suggestions: [
					"Inspect Azure DevOps work item 2 directly before retrying",
				],
			});
			expect(
				[...client.items.values()].some(
					(item) => item.fields[ID_FIELD] === "verified-dependent-a1",
				),
			).toBe(true);
		});

		it("returns a created dependency without a second batch read", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "batch-blocker-a1", title: "blocker" });
			client.getMany = async () => {
				throw adoError(403, "credential expired before a redundant batch read");
			};

			const task = await store.create({
				id: "batch-dependent-a1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "batch-blocker-a1" }],
			});

			expect(task.deps).toEqual([
				{ type: "blocked-by", id: "batch-blocker-a1" },
			]);
		});

		it("reports a server-side create failure as unconfirmed", async () => {
			const { store, client } = makeStore();
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				await create(type, patch);
				throw adoError(500, "proxy failed after forwarding the request");
			};

			await expect(
				store.create({
					id: "server-failed-create-a1",
					title: "inspect after server failure",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "server-failed-create-a1" creation has an unconfirmed outcome',
				),
			});
			expect(client.items.size).toBe(1);
		});

		it("reports an unconfirmed outcome when a create transition response fails", async () => {
			const { store, client } = makeStore();
			const update = client.update.bind(client);
			client.update = async (id, patch) => {
				await update(id, patch);
				throw new AxiError("transition response lost", "VALIDATION_ERROR");
			};

			await expect(
				store.create({
					id: "failed-start-a1",
					title: "retry the start",
					state: "in_flight",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "failed-start-a1" transition to in_flight has an unconfirmed outcome',
				),
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect([...client.items.values()][0]?.fields["System.State"]).toBe(
				"Active",
			);
			expect(client.calls.some((call) => call.kind === "remove")).toBe(false);
		});

		it("keeps partial-create context after a definitive transition rejection", async () => {
			const { store, client } = makeStore();
			client.update = async () => {
				throw adoError(400, JSON.stringify({ message: "Active is not valid" }));
			};

			await expect(
				store.create({
					id: "rejected-start-a1",
					title: "retry the existing task",
					state: "in_flight",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringMatching(
					/^Task "rejected-start-a1" transition to in_flight has an unconfirmed outcome.*; its existence and state could not be confirmed$/,
				),
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect([...client.items.values()][0]?.fields["System.State"]).toBe("New");
		});

		it("reports an unconfirmed state after a concurrent transition rejection", async () => {
			const { store, client } = makeStore();
			client.update = async () => {
				throw adoError(412, "work item revision mismatch");
			};

			await expect(
				store.create({
					id: "conflicted-start-a1",
					title: "inspect the existing task",
					state: "in_flight",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					"its existence and state could not be confirmed",
				),
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect(client.items.size).toBe(1);
		});

		it("reports unconfirmed existence after a post-create not-found response", async () => {
			const { store, client } = makeStore();
			client.update = async () => {
				client.items.clear();
				throw adoError(404, "work item was recycled");
			};

			await expect(
				store.create({
					id: "missing-start-a1",
					title: "inspect the missing task",
					state: "in_flight",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					"its existence and state could not be confirmed",
				),
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect(client.items.size).toBe(0);
		});

		it("preserves a requested close date when a failed create transition is retried", async () => {
			const { store, client } = makeStore();
			const update = client.update.bind(client);
			let rejectTransition = true;
			client.update = async (id, patch) => {
				if (rejectTransition) {
					rejectTransition = false;
					throw new AxiError("state transition rejected", "VALIDATION_ERROR");
				}
				return update(id, patch);
			};

			await expect(
				store.create({
					id: "failed-done-a1",
					title: "retry done",
					state: "done",
					closed: "2026-05-17",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				suggestions: [
					"Inspect Azure DevOps work item 1 directly before retrying",
				],
			});
			expect((await store.get("failed-done-a1"))?.closed).toBeUndefined();

			const done = await store.transition("failed-done-a1", "done");
			expect(done.closed).toBe("2026-05-17");
		});

		it("retires a pending close date when work starts", async () => {
			const { store, client } = makeStore();
			const update = client.update.bind(client);
			let rejectTransition = true;
			client.update = async (id, patch) => {
				if (rejectTransition) {
					rejectTransition = false;
					throw new AxiError("state transition rejected", "VALIDATION_ERROR");
				}
				return update(id, patch);
			};

			await expect(
				store.create({
					id: "restarted-done-a1",
					title: "new work supersedes the close intent",
					state: "done",
					closed: "2026-05-17",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });

			await store.transition("restarted-done-a1", "in_flight");
			const done = await store.transition("restarted-done-a1", "done");
			expect(done.closed).toBe("2026-06-22");
		});

		it("does not reuse a pending close after native completion and reopen", async () => {
			const { store, client } = makeStore();
			const update = client.update.bind(client);
			let rejectTransition = true;
			client.update = async (id, patch) => {
				if (rejectTransition) {
					rejectTransition = false;
					throw new AxiError("state transition rejected", "VALIDATION_ERROR");
				}
				return update(id, patch);
			};

			await expect(
				store.create({
					id: "native-done-a1",
					title: "completed elsewhere",
					state: "done",
					closed: "2026-05-17",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields["System.State"] = "Closed";

			expect((await store.get("native-done-a1"))?.closed).toBe("2026-05-17");
			await store.transition("native-done-a1", "queued");
			const done = await store.transition("native-done-a1", "done");
			expect(done.closed).toBe("2026-06-22");
		});

		it("promotes a pending close when updating a natively completed task", async () => {
			const { store, client } = makeStore();
			const update = client.update.bind(client);
			let rejectTransition = true;
			client.update = async (id, patch) => {
				if (rejectTransition) {
					rejectTransition = false;
					throw new AxiError("state transition rejected", "VALIDATION_ERROR");
				}
				return update(id, patch);
			};

			await expect(
				store.create({
					id: "updated-native-done-a1",
					title: "completed elsewhere",
					state: "done",
					closed: "2026-05-17",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields["System.State"] = "Closed";

			await store.update("updated-native-done-a1", { title: "observed done" });
			let metadata: unknown;
			try {
				metadata = JSON.parse(String(item.fields[META_FIELD]));
			} catch {
				throw new Error("expected valid tasks-axi metadata");
			}
			expect(metadata).toMatchObject({ closed: "2026-05-17" });
			expect(metadata).not.toHaveProperty("pending_closed");

			item.fields["System.State"] = "New";
			const done = await store.transition("updated-native-done-a1", "done");
			expect(done.closed).toBe("2026-06-22");
		});

		it("rejects a duplicate id", async () => {
			const { store } = makeStore();
			await store.create({ id: "dup-a1", title: "first" });
			await expect(
				store.create({ id: "dup-a1", title: "second" }),
			).rejects.toThrow(/already exists/);
		});

		it("refuses invalid join keys on primary and linked work items", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "invalid-key-a1", title: "primary" });
			const primary = [...client.items.values()][0];
			if (!primary) throw new Error("expected the created work item");
			primary.fields[ID_FIELD] = "bad id";

			await expect(store.list({})).rejects.toThrow(
				`Work item ${primary.id} has invalid ${ID_FIELD} value`,
			);

			const { store: linkedStore, client: linkedClient } = makeStore();
			await linkedStore.create({ id: "invalid-key-a2", title: "linked" });
			await linkedStore.create({
				id: "dependent-a2",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "invalid-key-a2" }],
			});
			const linked = [...linkedClient.items.values()].find(
				(item) => item.fields[ID_FIELD] === "invalid-key-a2",
			);
			if (!linked) throw new Error("expected the linked work item");
			linked.fields[ID_FIELD] = "bad linked id";

			await expect(linkedStore.get("dependent-a2")).rejects.toThrow(
				`Work item ${linked.id} has invalid ${ID_FIELD} value`,
			);
		});

		it("fails closed when a supported linked work item has no join key", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "unmanaged-blocker-a1", title: "blocker" });
			await store.create({
				id: "unmanaged-dependent-a1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "unmanaged-blocker-a1" }],
			});
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "unmanaged-blocker-a1",
			);
			if (!blocker) throw new Error("expected the blocker work item");
			delete blocker.fields[ID_FIELD];

			await expect(store.get("unmanaged-dependent-a1")).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: `Work item ${blocker.id} has no ${ID_FIELD} value`,
			});
		});

		it("fails closed when the join key is ambiguous or changes during lookup", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "dup-key-a1", title: "first" });
			const first = [...client.items.values()][0];
			if (!first) throw new Error("expected the created work item");
			client.items.set(99, { ...structuredClone(first), id: 99 });

			await expect(store.list({})).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				store.update("dup-key-a1", { title: "changed" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(first.fields["System.Title"]).toBe("first");

			const { store: movedStore, client: movedClient } = makeStore();
			await movedStore.create({ id: "moving-key-a1", title: "first" });
			const get = movedClient.get.bind(movedClient);
			movedClient.get = async (workItemId) => {
				const item = await get(workItemId);
				if (item) item.fields[ID_FIELD] = "retargeted-a1";
				return item;
			};
			await expect(
				movedStore.update("moving-key-a1", { title: "changed" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("treats case-variant join keys as duplicates", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "Task-A", title: "first" });
			const first = [...client.items.values()][0];
			if (!first) throw new Error("expected the created work item");
			const duplicate = structuredClone(first);
			duplicate.id = 99;
			duplicate.fields[ID_FIELD] = "task-a";
			client.items.set(duplicate.id, duplicate);

			await expect(store.list({})).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("does not manage other Azure DevOps work item types", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "wrong-type-a1", title: "task" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields["System.WorkItemType"] = "Bug";

			expect(await store.get("wrong-type-a1")).toBeNull();
			expect((await store.list({})).total).toBe(0);
			await expect(store.remove("wrong-type-a1")).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(client.items.has(item.id)).toBe(true);
		});

		it("validates create and update responses before reporting success", async () => {
			const { store, client } = makeStore();
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				const item = await create(type, patch);
				item.fields[ID_FIELD] = "rewritten-a1";
				return item;
			};
			await expect(
				store.create({ id: "response-id-a1", title: "create" }),
			).rejects.toMatchObject({ code: "CONFLICT" });

			const { store: updateStore, client: updateClient } = makeStore();
			await updateStore.create({ id: "response-scope-a1", title: "before" });
			const update = updateClient.update.bind(updateClient);
			updateClient.update = async (id, patch) => {
				const item = await update(id, patch);
				item.fields["System.AreaPath"] = "Internal\\Other";
				return item;
			};
			await expect(
				updateStore.update("response-scope-a1", { title: "after" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("fails closed when ADO rewrites requested fields or relations", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "rewrite-field-a1", title: "before" });
			const update = client.update.bind(client);
			client.update = (id, patch) =>
				update(
					id,
					patch.map((op) =>
						op.path === "/fields/System.Title"
							? { ...op, value: "rewritten by ADO" }
							: op,
					),
				);
			await expect(
				store.update("rewrite-field-a1", { title: "requested" }),
			).rejects.toMatchObject({ code: "CONFLICT" });

			const { store: relationStore, client: relationClient } = makeStore();
			await relationStore.create({
				id: "rewrite-blocker-a1",
				title: "blocker",
			});
			await relationStore.create({
				id: "rewrite-dependent-a1",
				title: "dependent",
			});
			const relationUpdate = relationClient.update.bind(relationClient);
			relationClient.update = (id, patch) =>
				relationUpdate(
					id,
					patch.filter((op) => op.path !== "/relations/-"),
				);
			await expect(
				relationStore.addDep("rewrite-dependent-a1", {
					type: "blocked-by",
					id: "rewrite-blocker-a1",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("reports an unconfirmed dependency outcome when the append response is lost", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "lost-blocker-a1", title: "blocker" });
			await store.create({ id: "lost-dependent-a1", title: "dependent" });
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "lost-dependent-a1",
			);
			if (!dependent) throw new Error("expected the dependent work item");
			const update = client.update.bind(client);
			client.update = async (id, patch) => {
				await update(id, patch);
				throw new Error("append response lost");
			};

			await expect(
				store.addDep("lost-dependent-a1", {
					type: "blocked-by",
					id: "lost-blocker-a1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "lost-dependent-a1" dependency update has an unconfirmed outcome',
				),
				suggestions: [
					'Inspect task "lost-dependent-a1" in Azure DevOps and remove the appended blocked-by relation before retrying',
				],
			});
			expect(dependent.relations).toHaveLength(1);
		});

		it("propagates a definitive dependency append rejection", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "rejected-blocker-a1", title: "blocker" });
			await store.create({ id: "rejected-dependent-a1", title: "dependent" });
			client.update = async () => {
				throw adoError(412, "work item revision mismatch");
			};

			await expect(
				store.addDep("rejected-dependent-a1", {
					type: "blocked-by",
					id: "rejected-blocker-a1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "work item revision mismatch",
			});
		});

		it("rolls back a dependency when its target changes identity", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "raced-blocker-a1", title: "blocker" });
			await store.create({ id: "raced-dependent-a1", title: "dependent" });
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "raced-blocker-a1",
			);
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "raced-dependent-a1",
			);
			if (!blocker || !dependent) throw new Error("expected both work items");
			const update = client.update.bind(client);
			client.update = async (id, patch) => {
				const updated = await update(id, patch);
				blocker.fields[ID_FIELD] = "renamed-blocker-a1";
				return updated;
			};

			await expect(
				store.addDep("raced-dependent-a1", {
					type: "blocked-by",
					id: "raced-blocker-a1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Dependency "raced-blocker-a1" changed identity or scope',
				),
			});
			expect(dependent.relations).toEqual([]);
			expect(
				client.calls
					.filter((call) => call.kind === "update" && call.id === dependent.id)
					.at(-1)?.patch,
			).toEqual([
				{ op: "test", path: "/rev", value: 2 },
				{ op: "remove", path: "/relations/0" },
			]);
		});

		it("reports an unconfirmed dependency outcome when rollback fails", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "uncertain-blocker-a1", title: "blocker" });
			await store.create({ id: "uncertain-dependent-a1", title: "dependent" });
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "uncertain-blocker-a1",
			);
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "uncertain-dependent-a1",
			);
			if (!blocker || !dependent) throw new Error("expected both work items");
			const update = client.update.bind(client);
			let updates = 0;
			client.update = async (id, patch) => {
				updates += 1;
				if (updates === 2) throw new Error("rollback response lost");
				const updated = await update(id, patch);
				blocker.fields[ID_FIELD] = "renamed-blocker-a1";
				return updated;
			};

			await expect(
				store.addDep("uncertain-dependent-a1", {
					type: "blocked-by",
					id: "uncertain-blocker-a1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "uncertain-dependent-a1" dependency update has an unconfirmed outcome',
				),
				suggestions: [
					'Inspect task "uncertain-dependent-a1" in Azure DevOps and remove the appended blocked-by relation before retrying',
				],
			});
			expect(dependent.relations).toHaveLength(1);
		});

		it("rolls back created dependencies when a relation target leaves scope", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "raced-create-blocker-a1", title: "blocker" });
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "raced-create-blocker-a1",
			);
			if (!blocker) throw new Error("expected the blocker work item");
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				const created = await create(type, patch);
				blocker.fields["System.AreaPath"] = "Internal\\Other";
				return created;
			};

			await expect(
				store.create({
					id: "raced-create-dependent-a1",
					title: "dependent",
					deps: [{ type: "blocked-by", id: "raced-create-blocker-a1" }],
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "raced-create-dependent-a1" post-create verification has an unconfirmed outcome',
				),
			});
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "raced-create-dependent-a1",
			);
			expect(dependent?.relations).toEqual([]);
			expect(blocker.relations).toEqual([]);
			expect(
				client.calls
					.filter((call) => call.kind === "update" && call.id === dependent?.id)
					.at(-1)?.patch,
			).toEqual([
				{ op: "test", path: "/rev", value: 1 },
				{ op: "remove", path: "/relations/0" },
			]);
		});

		it("requires direct ADO inspection when created dependency rollback is unconfirmed", async () => {
			const { store, client } = makeStore();
			await store.create({
				id: "uncertain-create-blocker-a1",
				title: "blocker",
			});
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "uncertain-create-blocker-a1",
			);
			if (!blocker) throw new Error("expected the blocker work item");
			const create = client.create.bind(client);
			client.create = async (type, patch) => {
				const created = await create(type, patch);
				blocker.fields["System.AreaPath"] = "Internal\\Other";
				return created;
			};
			client.update = async () => {
				throw new Error("rollback response lost");
			};

			await expect(
				store.create({
					id: "uncertain-create-dependent-a1",
					title: "dependent",
					deps: [{ type: "blocked-by", id: "uncertain-create-blocker-a1" }],
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					"dependency rollback could not be confirmed",
				),
				suggestions: [
					expect.stringMatching(
						/^Inspect Azure DevOps work item \d+ directly and remove the appended dependency relations before retrying$/,
					),
				],
			});
		});

		it("returns null for an unknown id", async () => {
			const { store } = makeStore();
			expect(await store.get("nope-z9")).toBeNull();
		});

		it("filters and limits in list", async () => {
			const { store } = makeStore();
			await store.create({ id: "a-q1", title: "a", repo: "one", kind: "ship" });
			await store.create({ id: "b-q1", title: "b", repo: "two" });
			await store.create({ id: "c-q1", title: "c", repo: "one" });

			expect((await store.list({})).total).toBe(3);
			expect((await store.list({ repo: "one" })).total).toBe(2);
			expect(
				(await store.list({ kind: "ship" })).items.map((t) => t.id),
			).toEqual(["a-q1"]);
			const limited = await store.list({ limit: 1 });
			expect(limited.total).toBe(3);
			expect(limited.items).toHaveLength(1);
		});

		it("ignores work items outside the configured area", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "inside-q1", title: "inside" });
			client.items.set(99, {
				id: 99,
				rev: 1,
				fields: {
					[ID_FIELD]: "outside-q1",
					"System.Title": "outside",
					"System.State": "New",
					"System.AreaPath": "Internal\\Other",
				},
				relations: [],
			});
			expect((await store.list({})).items.map((t) => t.id)).toEqual([
				"inside-q1",
			]);
		});

		it("fails closed when a point or batch read leaves the configured area", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "moving-area-a1", title: "inside" });
			const get = client.get.bind(client);
			client.get = async (id) => {
				const item = await get(id);
				if (item) item.fields["System.AreaPath"] = "Internal\\Other";
				return item;
			};
			await expect(
				store.update("moving-area-a1", { title: "changed" }),
			).rejects.toMatchObject({ code: "CONFLICT" });

			const { store: listStore, client: listClient } = makeStore();
			await listStore.create({ id: "moving-area-a2", title: "inside" });
			const getMany = listClient.getMany.bind(listClient);
			listClient.getMany = async (ids) => {
				const items = await getMany(ids);
				if (items[0]) items[0].fields["System.AreaPath"] = "Internal\\Other";
				return items;
			};
			await expect(listStore.list({})).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});

		it("ignores unrelated links to work items outside the configured area", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "inside-links-a1", title: "inside" });
			const inside = [...client.items.values()][0];
			if (!inside) throw new Error("expected the created work item");
			client.items.set(99, {
				id: 99,
				rev: 1,
				fields: {
					"System.TeamProject": "Internal",
					"System.AreaPath": "Internal\\Other",
				},
				relations: [],
			});
			inside.relations = [
				{
					rel: "System.LinkTypes.Related",
					url: client.workItemUrl(99),
					attributes: { comment: "ordinary related link" },
				},
				{
					rel: "System.LinkTypes.Dependency-Forward",
					url: client.workItemUrl(99),
				},
			];

			await expect(store.get("inside-links-a1")).resolves.toMatchObject({
				deps: [],
			});
		});

		it("names an unmapped Azure DevOps state instead of guessing", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "weird-q1", title: "weird" });
			const item = [...client.items.values()][0];
			item.fields["System.State"] = "Triage";
			await expect(store.get("weird-q1")).rejects.toThrow(/not mapped/);
		});
	});

	describe("update", () => {
		it("reports only the fields that changed", async () => {
			const { store } = makeStore();
			await store.create({ id: "upd-a1", title: "before", repo: "one" });
			const first = await store.update("upd-a1", {
				title: "after",
				repo: "one",
			});
			expect(first.changed).toEqual(["title"]);
			expect(first.task.title).toBe("after");

			const second = await store.update("upd-a1", { title: "after" });
			expect(second.changed).toEqual([]);
		});

		it("ignores computed ADO metadata in updates", async () => {
			const { store, client } = makeStore();
			const task = await store.create({
				id: "computed-meta-a1",
				title: "task",
			});
			const result = await store.update("computed-meta-a1", {
				meta: { ado_id: 999, ado_area: "Internal\\Other" },
			});
			expect(result.changed).toEqual([]);
			expect(result.task.meta).toEqual(task.meta);
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});

		it("keeps foreign tags when rewriting kind and repo", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "tag-a1", title: "t", kind: "ship" });
			const item = [...client.items.values()][0];
			item.fields["System.Tags"] = "kind:ship; external";

			await store.update("tag-a1", { kind: "scout", repo: "demo" });
			expect(item.fields["System.Tags"]).toBe(
				"kind:scout; repo:demo; external",
			);
		});

		it.each(["kind", "repo"])(
			"fails closed on duplicate owned %s tags",
			async (prefix) => {
				const { store, client } = makeStore();
				await store.create({ id: `duplicate-${prefix}-a1`, title: "task" });
				const item = [...client.items.values()][0];
				if (!item) throw new Error("expected the created work item");
				item.fields["System.Tags"] = `${prefix}:one; ${prefix}:two`;

				await expect(store.get(`duplicate-${prefix}-a1`)).rejects.toThrow(
					`multiple ${prefix}: tags`,
				);
			},
		);

		it("adds links and holds into the metadata field", async () => {
			const { store } = makeStore();
			await store.create({ id: "meta-a1", title: "m" });
			const result = await store.update("meta-a1", {
				addLinks: [{ kind: "doc", url: "https://example.test/doc" }],
				hold: { reason: "waiting on captain", kind: "captain" },
			});
			expect(result.changed).toEqual(["hold", "links"]);
			const task = await store.get("meta-a1");
			expect(task?.hold).toEqual({
				reason: "waiting on captain",
				kind: "captain",
			});
			expect(task?.links).toEqual([
				{ kind: "doc", url: "https://example.test/doc" },
			]);
		});

		it("normalizes and deduplicates typed links at read and write boundaries", async () => {
			const { store, client } = makeStore();
			const task = await store.create({
				id: "links-a1",
				title: "links",
				links: [
					{ kind: "doc", url: " https://example.test/doc " },
					{ kind: "doc", url: "https://example.test/doc" },
				],
			});
			expect(task.links).toEqual([
				{ kind: "doc", url: "https://example.test/doc" },
			]);

			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields[META_FIELD] = JSON.stringify({
				v: 1,
				links: [
					{ kind: "doc", url: " https://example.test/remote " },
					{ kind: "doc", url: "https://example.test/remote" },
				],
			});
			expect((await store.get("links-a1"))?.links).toEqual([
				{ kind: "doc", url: "https://example.test/remote" },
			]);

			await expect(
				store.transition("links-a1", "done", { pr: "not-a-pr" }),
			).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
			expect(item.fields["System.State"]).toBe("New");
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});

		it("refuses unsupported metadata versions before mutation", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "meta-v2-a1", title: "before" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields[META_FIELD] = JSON.stringify({ v: 2, future_field: true });

			await expect(
				store.update("meta-v2-a1", { title: "after" }),
			).rejects.toThrow(/Unsupported tasks-axi metadata version/);
			expect(item.fields["System.Title"]).toBe("before");
		});

		it.each([
			["missing version", { priority: 2 }],
			["priority", { v: 1, priority: "2" }],
			["hold", { v: 1, hold: { reason: 2 } }],
			["links", { v: 1, links: "x" }],
			["link target", { v: 1, links: [{ kind: "pr", url: "not-a-pr" }] }],
			["created", { v: 1, created: "soon" }],
			["closed", { v: 1, closed: 2 }],
			["pending close", { v: 1, pending_closed: 2 }],
			["meta", { v: 1, meta: [] }],
			["unknown field", { v: 1, future_field: true }],
		])("refuses malformed v1 metadata: %s", async (_field, metadata) => {
			const { store, client } = makeStore();
			await store.create({ id: "meta-invalid-a1", title: "before" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields[META_FIELD] = JSON.stringify(metadata);

			await expect(store.list({})).rejects.toThrow(/metadata/);
		});

		it("refuses non-string metadata values", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "meta-type-a1", title: "before" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			item.fields[META_FIELD] = { v: 1 };

			await expect(store.list({})).rejects.toThrow(/metadata must be a string/);
		});

		it("refuses body archiving instead of faking parity", async () => {
			const { store } = makeStore();
			await store.create({ id: "arch-a1", title: "a", body: "old" });
			await expect(
				store.update("arch-a1", { body: "new", archiveBody: true }),
			).rejects.toMatchObject({ code: "UNSUPPORTED" });
		});

		it("sends an optimistic revision test with every write", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "rev-a1", title: "r" });
			await store.update("rev-a1", { title: "r2" });
			const update = client.calls.find((call) => call.kind === "update");
			expect(update?.patch?.[0]).toEqual({
				op: "test",
				path: "/rev",
				value: 1,
			});
		});

		it("reports an unconfirmed outcome when an update response is lost", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "uncertain-update-a1", title: "before" });
			const update = client.update.bind(client);
			client.update = async (id, patch) => {
				await update(id, patch);
				throw new Error("update response lost");
			};

			await expect(
				store.update("uncertain-update-a1", { title: "after" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					"Work item 1 update has an unconfirmed outcome",
				),
				suggestions: [
					'Inspect task "uncertain-update-a1" in Azure DevOps before retrying',
				],
			});
			expect([...client.items.values()][0]?.fields["System.Title"]).toBe(
				"after",
			);
		});

		it("preserves a definitive update rejection", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "rejected-update-a1", title: "before" });
			client.update = async () => {
				throw adoError(412, "work item revision mismatch");
			};

			await expect(
				store.update("rejected-update-a1", { title: "after" }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "work item revision mismatch",
			});
		});

		it("refuses an update when ADO omits the revision", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "rev-missing-a1", title: "r" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			delete item.rev;

			await expect(
				store.update("rev-missing-a1", { title: "r2" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});
	});

	describe("transition", () => {
		it("maps the three states onto System.State", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "st-a1", title: "s" });
			const item = [...client.items.values()][0];

			await store.transition("st-a1", "in_flight");
			expect(item.fields["System.State"]).toBe("Active");

			const done = await store.transition("st-a1", "done", {
				pr: "https://github.com/o/r/pull/7",
				date: "2026-06-25",
				note: "shipped",
			});
			expect(item.fields["System.State"]).toBe("Closed");
			expect(done.closed).toBe("2026-06-25");
			expect(done.links).toEqual([
				{ kind: "pr", url: "https://github.com/o/r/pull/7" },
			]);
			expect(done.body).toBe("shipped");

			const reopened = await store.transition("st-a1", "queued");
			expect(reopened.closed).toBeUndefined();
			expect(item.fields["System.State"]).toBe("New");
		});

		it("reads configured ADO state names case-insensitively", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "state-case-a1", title: "case" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the work item");
			item.fields["System.State"] = "new";

			expect((await store.get("state-case-a1"))?.state).toBe("queued");
		});

		it("does not reuse stale closed metadata after an ADO-side reopen", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "ui-reopen-a1", title: "reopened elsewhere" });
			await store.transition("ui-reopen-a1", "done", { date: "2026-06-25" });
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the work item");
			item.fields["System.State"] = "New";

			expect((await store.get("ui-reopen-a1"))?.closed).toBeUndefined();
			const redone = await store.transition("ui-reopen-a1", "done");
			expect(redone.closed).toBe("2026-06-22");
		});

		it("preserves the close date when completion wins a concurrent race", async () => {
			const { store } = makeStore();
			await store.create({ id: "concurrent-done-a1", title: "already done" });
			await store.transition("concurrent-done-a1", "done", {
				date: "2026-05-17",
			});

			const done = await store.transition("concurrent-done-a1", "done", {
				pr: "https://github.com/o/r/pull/42",
			});
			expect(done.closed).toBe("2026-05-17");
			expect(done.links).toContainEqual({
				kind: "pr",
				url: "https://github.com/o/r/pull/42",
			});
		});
	});

	describe("dependencies", () => {
		it.each([
			["blocked-by", "System.LinkTypes.Dependency-Reverse", undefined],
			[
				"parent",
				"System.LinkTypes.Hierarchy-Reverse",
				{ comment: "parent:malformed-relation-a1" },
			],
			[
				"discovered-from",
				"System.LinkTypes.Related",
				{ comment: "discovered-from:malformed-relation-a1" },
			],
		])(
			"fails closed on a malformed %s relation target",
			async (_type, rel, attributes) => {
				const { store, client } = makeStore();
				await store.create({ id: "malformed-relation-a1", title: "dependent" });
				const item = [...client.items.values()][0];
				if (!item) throw new Error("expected the work item");
				item.relations = [
					{
						rel,
						url: "https://dev.azure.com/org/_apis/wit/workItems/not-a-number",
						...(attributes ? { attributes } : {}),
					},
				];

				await expect(store.get("malformed-relation-a1")).rejects.toThrow(
					/malformed .* relation target/,
				);
			},
		);

		it("stores blocked-by as a predecessor link with its reason", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "blocker-a1", title: "blocker" });
			await store.create({ id: "dependent-a1", title: "dependent" });

			expect(
				await store.addDep("dependent-a1", {
					type: "blocked-by",
					id: "blocker-a1",
					reason: "waits on the refactor",
				}),
			).toBe(true);
			// Idempotent second add.
			expect(
				await store.addDep("dependent-a1", {
					type: "blocked-by",
					id: "blocker-a1",
				}),
			).toBe(false);

			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "dependent-a1",
			);
			expect(dependent?.relations?.[0].rel).toBe(
				"System.LinkTypes.Dependency-Reverse",
			);

			const task = await store.get("dependent-a1");
			expect(task?.deps).toEqual([
				{
					type: "blocked-by",
					id: "blocker-a1",
					reason: "waits on the refactor",
				},
			]);

			expect(
				await store.removeDep("dependent-a1", {
					type: "blocked-by",
					id: "blocker-a1",
				}),
			).toBe(true);
			expect((await store.get("dependent-a1"))?.deps).toEqual([]);
			expect(
				await store.removeDep("dependent-a1", {
					type: "blocked-by",
					id: "blocker-a1",
				}),
			).toBe(false);
		});

		it("deduplicates created dependencies and clears legacy duplicates", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "dedup-blocker-a1", title: "blocker" });
			await store.create({
				id: "dedup-dependent-a1",
				title: "dependent",
				deps: [
					{ type: "blocked-by", id: "dedup-blocker-a1" },
					{ type: "blocked-by", id: "dedup-blocker-a1" },
				],
			});
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "dedup-dependent-a1",
			);
			if (!dependent?.relations?.[0]) {
				throw new Error("expected the dependency relation");
			}
			expect(dependent.relations).toHaveLength(1);
			dependent.relations.push(structuredClone(dependent.relations[0]));

			expect(
				await store.removeDep("dedup-dependent-a1", {
					type: "blocked-by",
					id: "dedup-blocker-a1",
				}),
			).toBe(true);
			expect(dependent.relations).toEqual([]);
			expect((await store.get("dedup-dependent-a1"))?.deps).toEqual([]);
		});

		it("fails closed when a related target disappears from a batch read", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "missing-blocker-a1", title: "blocker" });
			await store.create({
				id: "missing-dependent-a1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "missing-blocker-a1" }],
			});
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "missing-blocker-a1",
			);
			if (!blocker) throw new Error("expected the blocker work item");
			client.items.delete(blocker.id);

			await expect(store.get("missing-dependent-a1")).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(String(blocker.id)),
			});
		});

		it("rejects a second parent before create or update", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "parent-one-a1", title: "first parent" });
			await store.create({ id: "parent-two-a1", title: "second parent" });

			await expect(
				store.create({
					id: "two-parents-a1",
					title: "invalid child",
					deps: [
						{ type: "parent", id: "parent-one-a1" },
						{ type: "parent", id: "parent-two-a1" },
					],
				}),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: 'Task "two-parents-a1" cannot have more than one parent',
			});
			expect(
				client.calls.filter((call) => call.kind === "create"),
			).toHaveLength(2);

			await store.create({
				id: "one-parent-a1",
				title: "valid child",
				deps: [{ type: "parent", id: "parent-one-a1" }],
			});
			expect(
				await store.addDep("one-parent-a1", {
					type: "parent",
					id: "parent-one-a1",
				}),
			).toBe(false);
			await expect(
				store.addDep("one-parent-a1", {
					type: "parent",
					id: "parent-two-a1",
				}),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: 'Task "one-parent-a1" cannot have more than one parent',
			});
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);

			const child = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "one-parent-a1",
			);
			const secondParent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "parent-two-a1",
			);
			if (!child || !secondParent)
				throw new Error("expected parent work items");
			await expect(
				client.update(child.id, [
					{ op: "test", path: "/rev", value: child.rev },
					{
						op: "add",
						path: "/relations/-",
						value: {
							rel: "System.LinkTypes.Hierarchy-Reverse",
							url: client.workItemUrl(secondParent.id),
						},
					},
				]),
			).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
			expect(child.relations).toHaveLength(1);
		});

		it("round-trips owned parent and symmetric discovered-from edges", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "parent-a1", title: "parent" });
			await store.create({ id: "source-a1", title: "source" });
			await store.create({
				id: "child-a1",
				title: "child",
				deps: [
					{ type: "parent", id: "parent-a1" },
					{
						type: "discovered-from",
						id: "source-a1",
						reason: "found while testing",
					},
				],
			});
			const task = await store.get("child-a1");
			expect(task?.deps).toEqual([
				{ type: "parent", id: "parent-a1" },
				{
					type: "discovered-from",
					id: "source-a1",
					reason: "found while testing",
				},
			]);

			const source = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "source-a1",
			);
			expect(source?.relations).toHaveLength(1);
			expect((await store.get("source-a1"))?.deps).toEqual([]);
			expect(
				await store.removeDep("source-a1", {
					type: "discovered-from",
					id: "child-a1",
				}),
			).toBe(false);
			expect(source?.relations).toHaveLength(1);
			expect((await store.get("child-a1"))?.deps).toEqual(task?.deps);

			expect(
				await store.removeDep("child-a1", {
					type: "discovered-from",
					id: "source-a1",
				}),
			).toBe(true);
			expect(source?.relations).toEqual([]);
		});

		it.each(["parent", "discovered-from"] as const)(
			"fails closed when an owned %s marker names neither renamed endpoint",
			async (type) => {
				const { store, client } = makeStore();
				await store.create({ id: "rename-target-a1", title: "target" });
				await store.create({
					id: "rename-child-a1",
					title: "child",
					deps: [{ type, id: "rename-target-a1" }],
				});
				const child = [...client.items.values()].find(
					(item) => item.fields[ID_FIELD] === "rename-child-a1",
				);
				if (!child) throw new Error("expected the child work item");
				child.fields[ID_FIELD] = "renamed-child-a1";

				await expect(store.get("renamed-child-a1")).rejects.toMatchObject({
					code: "CONFLICT",
					message: expect.stringContaining("rename-child-a1"),
				});
			},
		);

		it("ignores native ADO parents not owned by tasks-axi", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "native-parent-child-a1", title: "child" });
			const child = [...client.items.values()][0];
			if (!child) throw new Error("expected the child work item");
			client.items.set(99, {
				id: 99,
				rev: 1,
				fields: {
					"System.WorkItemType": "User Story",
					"System.TeamProject": "Internal",
					"System.AreaPath": "Internal\\Elsewhere",
				},
				relations: [],
			});
			child.relations = [
				{
					rel: "System.LinkTypes.Hierarchy-Reverse",
					url: client.workItemUrl(99),
				},
			];

			await expect(store.get("native-parent-child-a1")).resolves.toMatchObject({
				deps: [],
			});
		});

		it("ignores similarly prefixed Related relations", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "similar-source-a1", title: "source" });
			await store.create({ id: "similar-child-a1", title: "child" });
			const source = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "similar-source-a1",
			);
			const child = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "similar-child-a1",
			);
			if (!source || !child) throw new Error("expected both work items");
			child.relations = [
				{
					rel: "System.LinkTypes.Related",
					url: client.workItemUrl(source.id),
					attributes: { comment: "discovered-fromage" },
				},
			];

			expect((await store.get("similar-child-a1"))?.deps).toEqual([]);
			expect(
				await store.removeDep("similar-child-a1", {
					type: "discovered-from",
					id: "similar-source-a1",
				}),
			).toBe(false);
			expect(child.relations).toHaveLength(1);
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});

		it("rejects duplicate join keys among linked work items", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "linked-blocker-a1", title: "blocker" });
			await store.create({
				id: "linked-child-a1",
				title: "child",
				deps: [{ type: "blocked-by", id: "linked-blocker-a1" }],
			});
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "linked-blocker-a1",
			);
			const child = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "linked-child-a1",
			);
			if (!blocker || !child?.relations?.[0]) {
				throw new Error("expected linked work items");
			}
			client.items.set(99, { ...structuredClone(blocker), id: 99 });
			child.relations.push({
				...structuredClone(child.relations[0]),
				url: client.workItemUrl(99),
			});

			await expect(
				store.removeDep("linked-child-a1", {
					type: "blocked-by",
					id: "linked-blocker-a1",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(child.relations).toHaveLength(2);
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});

		it.each([
			["area", "System.AreaPath", "Internal\\Other"],
			["project", "System.TeamProject", "External"],
			["work item type", "System.WorkItemType", "Bug"],
		])(
			"fails closed when a linked blocker leaves the configured %s",
			async (_scope, field, value) => {
				const { store, client } = makeStore();
				await store.create({ id: "scope-blocker-a1", title: "blocker" });
				await store.create({
					id: "scope-dependent-a1",
					title: "dependent",
					deps: [{ type: "blocked-by", id: "scope-blocker-a1" }],
				});
				const blocker = [...client.items.values()].find(
					(item) => item.fields[ID_FIELD] === "scope-blocker-a1",
				);
				if (!blocker) throw new Error("expected the blocker work item");
				blocker.fields[field] = value;

				await expect(store.get("scope-dependent-a1")).rejects.toMatchObject({
					code: "CONFLICT",
				});
			},
		);

		it("rejects a missing blocker and a self-block", async () => {
			const { store } = makeStore();
			await store.create({ id: "solo-a1", title: "solo" });
			await expect(
				store.addDep("solo-a1", { type: "blocked-by", id: "ghost-a1" }),
			).rejects.toThrow(/blocker "ghost-a1" not found/);
			await expect(
				store.addDep("solo-a1", { type: "blocked-by", id: "solo-a1" }),
			).rejects.toThrow(/cannot depend on itself/);
		});

		it("rejects case-variant dependency identity on removal", async () => {
			const { store } = makeStore();
			await store.create({ id: "Task-A", title: "blocker" });
			await store.create({
				id: "case-remove-a1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "Task-A" }],
			});

			await expect(
				store.removeDep("case-remove-a1", {
					type: "blocked-by",
					id: "task-a",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect((await store.get("case-remove-a1"))?.deps).toEqual([
				{ type: "blocked-by", id: "Task-A" },
			]);
		});

		it("rejects case-variant dependency targets before mutation", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "Task-A", title: "blocker" });

			await expect(
				store.create({
					id: "case-child-a1",
					title: "child",
					deps: [{ type: "blocked-by", id: "task-a" }],
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await store.create({ id: "case-dependent-a1", title: "dependent" });
			await expect(
				store.addDep("case-dependent-a1", {
					type: "blocked-by",
					id: "task-a",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });

			expect(
				[...client.items.values()].some(
					(item) => item.fields[ID_FIELD] === "case-child-a1",
				),
			).toBe(false);
			expect(
				[...client.items.values()].find(
					(item) => item.fields[ID_FIELD] === "case-dependent-a1",
				)?.relations,
			).toEqual([]);
		});
	});

	describe("remove", () => {
		it("protects a task that still blocks active work", async () => {
			const { store } = makeStore();
			await store.create({ id: "blocker-b1", title: "blocker" });
			await store.create({
				id: "dependent-b1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "blocker-b1" }],
			});
			await expect(store.remove("blocker-b1")).rejects.toThrow(
				/still blocking active tasks: dependent-b1/,
			);
		});

		it("fails closed when an active dependent moves outside the area", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "moved-blocker-b1", title: "blocker" });
			await store.create({
				id: "moved-dependent-b1",
				title: "dependent",
				deps: [{ type: "blocked-by", id: "moved-blocker-b1" }],
			});
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "moved-dependent-b1",
			);
			if (!dependent) throw new Error("expected the dependent work item");
			dependent.fields["System.AreaPath"] = "Internal\\Other";

			await expect(store.remove("moved-blocker-b1")).rejects.toMatchObject({
				code: "CONFLICT",
			});
			expect(
				[...client.items.values()].some(
					(item) => item.fields[ID_FIELD] === "moved-blocker-b1",
				),
			).toBe(true);
		});

		it("sends a free task to the recycle bin", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "gone-b1", title: "gone" });
			const removed = await store.remove("gone-b1");
			expect(removed.id).toBe("gone-b1");
			expect(client.items.size).toBe(0);
			expect(await store.get("gone-b1")).toBeNull();
		});

		it("reports an unconfirmed outcome when a removal response is lost", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "uncertain-remove-b1", title: "gone" });
			const remove = client.remove.bind(client);
			client.remove = async (id) => {
				await remove(id);
				throw new Error("remove response lost");
			};

			await expect(store.remove("uncertain-remove-b1")).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "uncertain-remove-b1" removal has an unconfirmed outcome',
				),
				suggestions: [
					'Inspect task "uncertain-remove-b1" in the Azure DevOps recycle bin before retrying',
				],
			});
			expect(client.items.size).toBe(0);
		});
	});

	describe("moveTo (area path)", () => {
		it("moves a task across queues by rewriting the area path", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "move-a1", title: "move me" });
			const moved = await store.moveTo(
				"move-a1",
				"Internal\\Firstmate\\scribe",
			);
			expect(moved.meta?.ado_area).toBe("Internal\\Firstmate\\scribe");
			const item = [...client.items.values()][0];
			expect(item.fields["System.AreaPath"]).toBe(
				"Internal\\Firstmate\\scribe",
			);
		});

		it("refuses to move onto an existing destination slug", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "move-duplicate-a1", title: "source" });
			const source = [...client.items.values()][0];
			if (!source) throw new Error("expected the source work item");
			const duplicate = structuredClone(source);
			duplicate.id = 99;
			duplicate.fields["System.AreaPath"] = "Internal\\Other";
			client.items.set(duplicate.id, duplicate);

			await expect(
				store.moveTo("move-duplicate-a1", "Internal\\Other"),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(
					'Task "move-duplicate-a1" already exists in Azure DevOps area "Internal\\Other"',
				),
			});
			expect(source.fields["System.AreaPath"]).toBe(
				"Internal\\Firstmate\\main",
			);
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
		});

		it("rechecks relations immediately before moving outside the configured area", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "late-move-blocker-a1", title: "blocker" });
			await store.create({ id: "late-move-dependent-a1", title: "dependent" });
			const blocker = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "late-move-blocker-a1",
			);
			const dependent = [...client.items.values()].find(
				(item) => item.fields[ID_FIELD] === "late-move-dependent-a1",
			);
			if (!blocker || !dependent) throw new Error("expected both work items");
			const queryIds = client.queryIds.bind(client);
			let queries = 0;
			client.queryIds = async (wiql) => {
				queries += 1;
				const ids = await queryIds(wiql);
				if (queries === 2) {
					await store.addDep("late-move-dependent-a1", {
						type: "blocked-by",
						id: "late-move-blocker-a1",
					});
				}
				return ids;
			};

			await expect(
				store.moveTo("late-move-blocker-a1", "Internal\\Other"),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: expect.stringMatching(
					/late-move-blocker-a1.*late-move-dependent-a1|late-move-dependent-a1.*late-move-blocker-a1/,
				),
			});
			expect(blocker.fields["System.AreaPath"]).toBe(
				"Internal\\Firstmate\\main",
			);
			expect(
				client.calls.filter(
					(call) =>
						call.kind === "update" &&
						call.patch?.some((op) => op.path === "/fields/System.AreaPath"),
				),
			).toHaveLength(0);
		});

		it("rejects a move response with a changed work item type", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "move-type-a1", title: "move me" });
			const update = client.update.bind(client);
			client.update = async (id, patch) => {
				const moved = await update(id, patch);
				moved.fields["System.WorkItemType"] = "Bug";
				return moved;
			};

			await expect(
				store.moveTo("move-type-a1", "Internal\\Firstmate\\scribe"),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining('type "Bug", expected "Task"'),
			});
		});

		it.each(["split-blocker-a1", "split-dependent-a1"])(
			"refuses to move %s outside the scoped dependency graph",
			async (movedId) => {
				const { store, client } = makeStore();
				await store.create({ id: "split-blocker-a1", title: "blocker" });
				await store.create({
					id: "split-dependent-a1",
					title: "dependent",
					deps: [{ type: "blocked-by", id: "split-blocker-a1" }],
				});

				await expect(
					store.moveTo(movedId, "Internal\\Other"),
				).rejects.toMatchObject({
					code: "VALIDATION_ERROR",
					message: expect.stringMatching(
						/split-blocker-a1.*split-dependent-a1|split-dependent-a1.*split-blocker-a1/,
					),
				});
				const item = [...client.items.values()].find(
					(candidate) => candidate.fields[ID_FIELD] === movedId,
				);
				expect(item?.fields["System.AreaPath"]).toBe(
					"Internal\\Firstmate\\main",
				);
				expect(
					client.calls.filter((call) => call.kind === "update"),
				).toHaveLength(0);
			},
		);

		it("is idempotent and validates the target", async () => {
			const { store, client } = makeStore();
			await store.create({ id: "move-b1", title: "move me" });
			await store.moveTo("move-b1", "Internal\\Firstmate\\main");
			expect(
				client.calls.filter((call) => call.kind === "update"),
			).toHaveLength(0);
			await expect(store.moveTo("move-b1", "  ")).rejects.toThrow(/area path/);
		});
	});

	describe("public-followup", () => {
		it("stores the canonical payload in its own field and gates generic verbs", async () => {
			const { store, client } = makeStore();
			const followup = intent();
			const task = await store.create({
				id: "public-final-ab",
				title: followup.request.public_safe_summary,
				kind: "public-followup",
				public_followup: followup,
			});
			expect(task.public_followup?.revision).toBe(1);
			const item = [...client.items.values()][0];
			expect(typeof item.fields[FOLLOWUP_FIELD]).toBe("string");

			await expect(store.transition("public-final-ab", "done")).rejects.toThrow(
				/Public-followup state cannot change/,
			);
			await expect(store.remove("public-final-ab")).rejects.toThrow(
				/Active public-followup obligations cannot be removed/,
			);
			await expect(
				store.update("public-final-ab", { title: "new promise" }),
			).rejects.toThrow(/cannot change through generic update/);
		});

		it("fails closed when the public-followup kind, payload, or state drifts", async () => {
			const { store, client } = makeStore();
			const followup = intent();
			await store.create({
				id: "public-corrupt-a1",
				title: followup.request.public_safe_summary,
				kind: "public-followup",
				public_followup: followup,
			});
			const item = [...client.items.values()][0];
			if (!item) throw new Error("expected the created work item");
			const payload = item.fields[FOLLOWUP_FIELD];

			item.fields[FOLLOWUP_FIELD] = "";
			await expect(store.remove("public-corrupt-a1")).rejects.toThrow(
				/must be present together/,
			);
			expect(client.items.has(item.id)).toBe(true);

			delete item.fields[FOLLOWUP_FIELD];
			await expect(store.remove("public-corrupt-a1")).rejects.toThrow(
				/must be present together/,
			);
			expect(client.items.has(item.id)).toBe(true);

			item.fields[FOLLOWUP_FIELD] = payload;
			delete item.fields["System.Tags"];
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/must be present together/,
			);

			item.fields["System.Tags"] = "kind:public-followup";
			item.fields["System.State"] = "Closed";
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/active public-followup task cannot be Done/,
			);

			item.fields["System.State"] = "New";
			item.fields[META_FIELD] = JSON.stringify({
				v: 1,
				hold: { reason: "hide the obligation" },
			});
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/cannot use dispatch holds/,
			);

			item.fields[META_FIELD] = JSON.stringify({ v: 1 });
			item.fields["System.Title"] = "Changed public promise";
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/public-safe promise/,
			);

			item.fields["System.Title"] = followup.request.public_safe_summary;
			item.fields["System.Description"] = "private notes";
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/public-safe promise/,
			);

			delete item.fields["System.Description"];
			item.fields[META_FIELD] = JSON.stringify({
				v: 1,
				links: [{ kind: "doc", url: "https://example.test/private" }],
			});
			await expect(store.get("public-corrupt-a1")).rejects.toThrow(
				/public-safe promise/,
			);
		});

		it("applies a revision-checked mutation and refuses a stale one", async () => {
			const { store } = makeStore();
			const followup = intent();
			await store.create({
				id: "public-final-ac",
				title: followup.request.public_safe_summary,
				kind: "public-followup",
				public_followup: followup,
			});

			const next = structuredClone(followup);
			next.revision = 2;
			next.work_relations = [
				{
					relation_id: "rel-code",
					work_ref: { home_id: "secondmate:demo", task_id: "work-code-q1" },
					role: "fulfills",
					required: true,
					generation: 1,
					state: "bound",
					accepted_event_ids: [],
					accepted_events: [],
					successor_relation_id: null,
				},
			];
			next.delivery.state = "pending-work";

			const updated = await store.updatePublicFollowup("public-final-ac", {
				expectedRevision: 1,
				expectedPublicFollowup: followup,
				publicFollowup: next,
			});
			expect(updated.public_followup?.revision).toBe(2);
			expect(updated.state).toBe("queued");

			await expect(
				store.updatePublicFollowup("public-final-ac", {
					expectedRevision: 1,
					expectedPublicFollowup: followup,
					publicFollowup: next,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("rejects typed followup data without the public-followup kind", async () => {
			const { store } = makeStore();
			await expect(
				store.create({
					id: "wrong-kind-a1",
					title: "x",
					public_followup: intent(),
				}),
			).rejects.toThrow(/requires kind=public-followup/);
		});
	});

	it("wraps a missing task in a NOT_FOUND error", async () => {
		const { store } = makeStore();
		await expect(
			store.update("ghost-a1", { title: "x" }),
		).rejects.toBeInstanceOf(AxiError);
		await expect(
			store.update("ghost-a1", { title: "x" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
