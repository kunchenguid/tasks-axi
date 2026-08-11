import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTasksContext } from "../src/context.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTasksContext", () => {
  it("defaults to the markdown backend", () => {
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    expect(ctx.store.capabilities().backend).toBe("markdown");
  });

  it("selects the ado backend from config", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      [
        'backend = "ado"',
        "[ado]",
        'org = "contoso"',
        'project = "Internal"',
        "",
      ].join("\n"),
    );
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    const caps = ctx.store.capabilities();
    expect(caps.backend).toBe("ado");
    expect(caps.prune).toBe(false);
  });

  it("uses the resolved environment for ADO authentication", async () => {
    const previousPat = process.env.TASKS_AXI_ADO_PAT;
    process.env.TASKS_AXI_ADO_PAT = "ambient";
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from(":isolated").toString("base64")}`,
        );
        return new Response(JSON.stringify({ workItems: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const ctx = resolveTasksContext({
        backend: "ado",
        cwd: dir,
        home,
        env: {
          TASKS_AXI_ADO_ORG: "contoso",
          TASKS_AXI_ADO_PROJECT: "Internal",
          TASKS_AXI_ADO_PAT: "isolated",
        },
      });
      await ctx.store.list({});
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      if (previousPat === undefined) {
        Reflect.deleteProperty(process.env, "TASKS_AXI_ADO_PAT");
      } else {
        process.env.TASKS_AXI_ADO_PAT = previousPat;
      }
    }
  });

  it("refuses the ado backend without an [ado] table", () => {
    expect(() =>
      resolveTasksContext({ backend: "ado", cwd: dir, home, env: {} }),
    ).toThrow(/`\[ado\]` config table/);
  });

  it("still rejects an unknown backend", () => {
    expect(() =>
      resolveTasksContext({ backend: "sqlite", cwd: dir, home, env: {} }),
    ).toThrow(/Unsupported backend/);
  });
});
