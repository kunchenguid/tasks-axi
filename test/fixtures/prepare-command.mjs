import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Synthetic, bounded stand-in for an external `mv --prepare` command.
//   node prepare-command.mjs <log> ok
//   node prepare-command.mjs <log> fail <exit-code>
//   node prepare-command.mjs <log> sleep <ms>
//   node prepare-command.mjs <log> edit <file>      (hand-edit a backlog, then succeed)
//   node prepare-command.mjs <log> cli <tasks-axi args...>
// Every run first appends `invoked <pid>` to <log>.
const [log, mode, ...rest] = process.argv.slice(2);
appendFileSync(log, `invoked ${process.pid}\n`);

if (mode === "fail") {
  process.exit(Number(rest[0]));
} else if (mode === "sleep") {
  setTimeout(() => process.exit(0), Number(rest[0]));
} else if (mode === "edit") {
  appendFileSync(rest[0], "\n- hand edit\n");
} else if (mode === "cli") {
  const bin = fileURLToPath(new URL("../../bin/tasks-axi.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", bin, ...rest],
    { encoding: "utf8" },
  );
  writeFileSync(`${log}.cli`, `${result.status}\n${result.stdout}`);
}
