/**
 * Leaf module: the package version, resolved from `package.json`.
 *
 * This file must import ONLY node builtins. `bin/tasks-axi.ts` imports it
 * eagerly so `--version` can be answered before the heavy command graph in
 * `cli.ts` is dynamically imported.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
      name?: unknown;
    };
    if (
      parsed.name === "tasks-axi" &&
      typeof parsed.version === "string" &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine tasks-axi package version");
}

export const VERSION = readPackageVersion();
