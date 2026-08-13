import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `bin/tasks-axi.ts` answers a bare version flag through
 * `axi-sdk-js/fast-path` + the leaf `src/version.ts`, and only dynamically
 * imports `src/cli.ts` for everything else. These guards are deterministic:
 * they assert the module graph actually loaded, not wall-clock time.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "tasks-axi.ts");
const REGISTER = new URL(
  "../fixtures/module-trace-register.mjs",
  import.meta.url,
).href;

const { version: PKG_VERSION } = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { version: string };

let traceDir: string;
let nextTrace = 0;

beforeAll(() => {
  traceDir = mkdtempSync(join(tmpdir(), "tasks-axi-trace-"));
});

afterAll(() => {
  rmSync(traceDir, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  status: number | null;
  loaded: string[];
}

function run(args: string[]): Run {
  const tracePath = join(traceDir, `trace-${nextTrace++}.txt`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", REGISTER, BIN, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, AXI_MODULE_TRACE: tracePath },
    },
  );

  const trace = readFileSync(tracePath, "utf8");
  return {
    stdout: result.stdout,
    status: result.status,
    loaded: trace.split("\n").filter((line) => line.length > 0),
  };
}

const loadedHeavyGraph = (loaded: string[]): boolean =>
  loaded.some((url) => url.endsWith("/src/cli.ts"));

describe("version fast path", () => {
  it.each(["-v", "-V", "--version"])(
    "prints exactly the package version for %s and skips the command graph",
    (flag) => {
      const { stdout, status, loaded } = run([flag]);

      expect(stdout).toBe(`${PKG_VERSION}\n`);
      expect(status).toBe(0);

      // Only the bin, the SDK fast path, and the leaf version module load.
      expect(loadedHeavyGraph(loaded)).toBe(false);
      expect(
        loaded.filter((url) => url.includes("/@toon-format/")),
      ).toHaveLength(0);
      expect(
        loaded.filter((url) => url.endsWith("/axi-sdk-js/dist/index.js")),
      ).toHaveLength(0);
      expect(loaded.some((url) => url.endsWith("/src/version.ts"))).toBe(true);
      expect(loaded.some((url) => url.endsWith("/fast-path.js"))).toBe(true);
    },
  );

  // Negative control: the probe above is only meaningful if it would notice
  // the heavy graph being loaded. These argv shapes deliberately fall through
  // to `runAxiCli`, and the trace must show it.
  it.each([["--help"], ["list", "--help"], ["list", "--version"]])(
    "still loads the command graph for %s",
    (...args: string[]) => {
      const { loaded } = run(args);

      expect(loadedHeavyGraph(loaded)).toBe(true);
    },
  );

  it("leaves a trailing version flag to the full CLI, unchanged", () => {
    // Pre-change behaviour: `runAxiCli` owns the general case and rejects a
    // version flag in a command position. The fast path must not swallow it.
    const { stdout, status } = run(["list", "--version"]);

    expect(stdout).toContain('error: "Unknown flag: --version"');
    expect(status).not.toBe(0);
  });
});
