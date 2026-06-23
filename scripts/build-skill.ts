// Generates skills/tasks-axi/SKILL.md from the shared CLI guidance so the
// installable skill never drifts from what `tasks-axi` prints.
//
//   pnpm run build:skill            # write the file
//   pnpm run build:skill -- --check # fail (exit 1) if the committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSkillMarkdown } from "../src/skill.js";

const target = new URL("../skills/tasks-axi/SKILL.md", import.meta.url);
const expected = createSkillMarkdown();
const check = process.argv.includes("--check");

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

if (check) {
  let actual: string | null = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file falls through to the mismatch branch below
  }
  if (actual === null || normalizeLineEndings(actual) !== expected) {
    console.error(
      "skills/tasks-axi/SKILL.md is out of date. Run `pnpm run build:skill` and commit the result.",
    );
    process.exit(1);
  }
  console.log("skills/tasks-axi/SKILL.md is up to date.");
} else {
  await mkdir(new URL("../skills/tasks-axi/", import.meta.url), {
    recursive: true,
  });
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
