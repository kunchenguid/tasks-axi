import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Resolve the `mv --to` directory shorthand without opening a store. */
export function resolveBacklogTarget(to: string): string {
  const base = isAbsolute(to) ? to : resolve(process.cwd(), to);
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const candidate of ["data/backlog.md", "backlog.md"]) {
      const full = resolve(base, candidate);
      if (existsSync(full)) return full;
    }
    return resolve(base, "data/backlog.md");
  }
  return base;
}
