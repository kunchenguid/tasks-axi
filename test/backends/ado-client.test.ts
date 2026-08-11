import { describe, expect, it, vi } from "vitest";
import {
	ADO_RESOURCE,
	AdoRestClient,
	PAT_ENV_VARS,
	adoError,
	isDefinitiveAdoRejection,
	patFromEnv,
} from "../../src/backends/ado-client.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const PAT_ENV = { TASKS_AXI_ADO_PAT: "secret" } as NodeJS.ProcessEnv;

function client(
	fetchImpl: typeof fetch,
	env: NodeJS.ProcessEnv = PAT_ENV,
	timeoutMs?: number,
) {
	return new AdoRestClient({
		org: "AIMENTUM",
		project: "Internal",
		env,
		fetchImpl,
		timeoutMs,
	});
}

function reply(
	body: string,
	init: { status?: number; ok?: boolean } = {},
): Response {
	const status = init.status ?? 200;
	return {
		ok: init.ok ?? (status >= 200 && status < 300),
		status,
		text: () => Promise.resolve(body),
	} as Response;
}

describe("patFromEnv", () => {
	it("takes the first non-empty PAT var in order", () => {
		expect(patFromEnv({ [PAT_ENV_VARS[1]!]: " tok " })).toBe("tok");
		expect(
			patFromEnv({ [PAT_ENV_VARS[0]!]: "first", [PAT_ENV_VARS[1]!]: "second" }),
		).toBe("first");
		expect(patFromEnv({ [PAT_ENV_VARS[0]!]: "   " })).toBeUndefined();
		expect(patFromEnv({})).toBeUndefined();
	});
});

describe("AdoRestClient", () => {
	it("uses the injected environment for az authentication", async () => {
		const env = {
			PATH: "/isolated/bin",
			AZURE_CONFIG_DIR: "/isolated/azure",
		};
		execFileMock.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error | null,
				result?: { stdout: string; stderr: string },
			) => void;
			const options = args[2] as
				| { env?: NodeJS.ProcessEnv; timeout?: number }
				| undefined;
			if (options?.env !== env || options.timeout !== 30_000) {
				callback(new Error("ambient environment or unbounded timeout used"));
				return;
			}
			callback(null, {
				stdout: JSON.stringify({ accessToken: "token" }),
				stderr: "",
			});
		});
		const fetchImpl = vi.fn(() =>
			Promise.resolve(reply(JSON.stringify({ workItems: [] }))),
		);

		await expect(
			client(fetchImpl as unknown as typeof fetch, env).queryIds(
				"SELECT [System.Id] FROM WorkItems",
			),
		).resolves.toEqual([]);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer token",
		);
		const [file, args, options] = execFileMock.mock.calls.at(-1)!;
		expect(file).toBe("az");
		expect(args).toEqual([
			"account",
			"get-access-token",
			"--resource",
			ADO_RESOURCE,
			"-o",
			"json",
		]);
		expect(options).toEqual({ env, timeout: 30_000 });
	});

	it("reports az credential command failures", async () => {
		execFileMock.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (error: Error | null) => void;
			callback(new Error("az executable unavailable"));
		});
		const fetchImpl = vi.fn();

		await expect(
			client(fetchImpl as unknown as typeof fetch, {}).queryIds(
				"SELECT [System.Id] FROM WorkItems",
			),
		).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
			message: expect.stringContaining(
				"No Azure DevOps credential: set TASKS_AXI_ADO_PAT or sign in with `az login` (az executable unavailable)",
			),
			suggestions: ["export TASKS_AXI_ADO_PAT=<pat>", "az login"],
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([null, {}, { accessToken: 7 }, { accessToken: " " }])(
		"rejects malformed az token output %#",
		async (body) => {
			execFileMock.mockImplementationOnce((...args: unknown[]) => {
				const callback = args.at(-1) as (
					error: Error | null,
					result?: { stdout: string; stderr: string },
				) => void;
				callback(null, { stdout: JSON.stringify(body), stderr: "" });
			});
			const fetchImpl = vi.fn();

			await expect(
				client(fetchImpl as unknown as typeof fetch, {}).queryIds(
					"SELECT [System.Id] FROM WorkItems",
				),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: "az returned no valid access token for Azure DevOps",
			});
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("sends PAT basic auth and the pinned api-version", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(reply(JSON.stringify({ workItems: [{ id: 7 }] }))),
		);
		const ids = await client(fetchImpl as unknown as typeof fetch).queryIds(
			"SELECT [System.Id] FROM WorkItems",
		);

		expect(ids).toEqual([7]);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toContain("https://dev.azure.com/AIMENTUM/");
		expect(url).toContain("api-version=7.1");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from(":secret").toString("base64")}`,
		);
	});

	it("bounds REST requests without making mutation timeouts definitive", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) throw new Error("expected an abort signal");
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		let error: unknown;
		try {
			await client(fetchImpl as unknown as typeof fetch, PAT_ENV, 10).create(
				"Task",
				[],
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({
			code: "UNKNOWN",
			message: "Azure DevOps request timed out after 10ms",
		});
		expect(isDefinitiveAdoRejection(error)).toBe(false);
	});

	it.each([
		{},
		{ workItems: {} },
		{ workItems: [{ id: "7" }] },
		{ workItems: [{ id: 0 }] },
		{ workItems: [{ id: 1.5 }] },
	])("fails closed on a malformed WIQL response %#", async (body) => {
		const fetchImpl = vi.fn(() => Promise.resolve(reply(JSON.stringify(body))));

		await expect(
			client(fetchImpl as unknown as typeof fetch).queryIds(
				"SELECT [System.Id] FROM WorkItems",
			),
		).rejects.toMatchObject({
			code: "UNKNOWN",
			message:
				"Azure DevOps WIQL response did not contain a valid workItems array",
		});
	});

	// ADO answers an unauthenticated REST call with 203 + an HTML sign-in page,
	// not a 401 — without this it surfaced as "response was not valid JSON".
	it("reads a sign-in page as a credential failure, not a parse error", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(
				reply("<html><body>Sign In</body></html>", { status: 203 }),
			),
		);

		await expect(
			client(fetchImpl as unknown as typeof fetch).get(7),
		).rejects.toThrow(/rejected the credential/);
	});

	it("reads an HTML body on a 200 the same way", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(reply("<!DOCTYPE html><html>...</html>")),
		);

		await expect(
			client(fetchImpl as unknown as typeof fetch).get(7),
		).rejects.toThrow(/rejected the credential/);
	});

	it.each([401, 403])(
		"reads HTTP %s as a credential failure",
		async (status) => {
			const fetchImpl = vi.fn(() =>
				Promise.resolve(reply("denied", { status })),
			);

			await expect(
				client(fetchImpl as unknown as typeof fetch).get(7),
			).rejects.toMatchObject({
				code: "VALIDATION_ERROR",
				message: expect.stringContaining("rejected the credential"),
			});
		},
	);

	it("requests relations in create and update responses", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(
				reply(JSON.stringify({ id: 7, fields: {}, relations: [] })),
			),
		);
		const api = client(fetchImpl as unknown as typeof fetch);

		await api.create("Task", []);
		await api.update(7, []);

		for (const [url] of fetchImpl.mock.calls as unknown as [
			string,
			RequestInit,
		][]) {
			const query = url.slice(url.indexOf("?") + 1);
			expect(new URLSearchParams(query).get("$expand")).toBe("Relations");
		}
	});

	it("fails closed on malformed work item responses", async () => {
		const invalidItem = () =>
			vi.fn(() =>
				Promise.resolve(reply(JSON.stringify({ id: 7, fields: [] }))),
			) as unknown as typeof fetch;
		const invalidBatch = vi.fn(() =>
			Promise.resolve(
				reply(JSON.stringify({ value: [{ id: 7, fields: [] }] })),
			),
		) as unknown as typeof fetch;

		await expect(client(invalidItem()).get(7)).rejects.toMatchObject({
			code: "UNKNOWN",
		});
		await expect(client(invalidBatch).getMany([7])).rejects.toMatchObject({
			code: "UNKNOWN",
		});
		await expect(
			client(invalidItem()).create("Task", []),
		).rejects.toMatchObject({
			code: "UNKNOWN",
		});
		await expect(client(invalidItem()).update(7, [])).rejects.toMatchObject({
			code: "UNKNOWN",
		});
	});

	it("rejects mismatched work item ids", async () => {
		const wrongItem = () =>
			vi.fn(() =>
				Promise.resolve(reply(JSON.stringify({ id: 8, fields: {} }))),
			) as unknown as typeof fetch;

		await expect(client(wrongItem()).get(7)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(client(wrongItem()).update(7, [])).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it.each([
		[
			"duplicate",
			[
				{ id: 7, fields: {} },
				{ id: 7, fields: {} },
			],
		],
		[
			"unrequested",
			[
				{ id: 7, fields: {} },
				{ id: 9, fields: {} },
			],
		],
	])("rejects %s ids in a batch response", async (_name, value) => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(reply(JSON.stringify({ value }))),
		);

		await expect(
			client(fetchImpl as unknown as typeof fetch).getMany([7, 8]),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("fails closed when a batch response omits a requested item", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(
				reply(JSON.stringify({ value: [{ id: 7, fields: {} }] })),
			),
		);
		const api = client(fetchImpl as unknown as typeof fetch);

		await expect(api.getMany([7, 8])).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("8"),
		});
		const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		const query = url.slice(url.indexOf("?") + 1);
		expect(new URLSearchParams(query).get("errorPolicy")).toBe("Fail");
	});

	// `get` owns the Store contract for a missing item; other verbs must not
	// swallow the same status.
	it("turns a 404 into null for get and into an error everywhere else", async () => {
		const notFound = () =>
			vi.fn(() =>
				Promise.resolve(
					reply(JSON.stringify({ message: "TF401232: item not found" }), {
						status: 404,
					}),
				),
			) as unknown as typeof fetch;

		await expect(client(notFound()).get(7)).resolves.toBeNull();
		await expect(client(notFound()).remove(7)).rejects.toThrow(
			"TF401232: item not found",
		);
	});

	it("still reports a server error with its status", async () => {
		const fetchImpl = vi.fn(() =>
			Promise.resolve(reply("upstream exploded", { status: 500 })),
		);

		await expect(
			client(fetchImpl as unknown as typeof fetch).get(7),
		).rejects.toThrow(/Azure DevOps request failed \(500\)/);
	});
});

describe("adoError", () => {
	it("maps ADO status codes onto AXI error codes", () => {
		expect(adoError(404, "{}").code).toBe("NOT_FOUND");
		expect(adoError(409, "{}").code).toBe("CONFLICT");
		expect(adoError(412, "{}").code).toBe("CONFLICT");
		expect(adoError(400, "{}").code).toBe("VALIDATION_ERROR");
		expect(adoError(401, "{}").code).toBe("VALIDATION_ERROR");
		expect(adoError(403, "{}").code).toBe("VALIDATION_ERROR");
		expect(adoError(500, "boom").code).toBe("UNKNOWN");
		expect(adoError(500, "boom").message).toContain("(500)");
	});

	it("prefers the ADO message field over the raw body", () => {
		expect(
			adoError(400, JSON.stringify({ message: "bad field" })).message,
		).toBe("bad field");
	});
});
