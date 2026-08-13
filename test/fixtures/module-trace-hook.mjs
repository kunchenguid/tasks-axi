// ESM loader hook: appends the URL of every module the process loads to the
// file named by the registration `data.out`. Used by
// `test/bin/version-fast-path.test.ts` to prove the heavy command graph is not
// loaded on the `--version` fast path.
import { appendFileSync } from "node:fs";

let out;

export function initialize(data) {
  out = data.out;
}

export async function load(url, context, next) {
  if (out) appendFileSync(out, `${url}\n`);
  return next(url, context);
}
