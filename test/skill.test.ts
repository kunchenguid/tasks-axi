import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESCRIPTION } from "../src/cli.js";
import { createSkillMarkdown, SKILL_DESCRIPTION } from "../src/skill.js";

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("skill generation", () => {
  it("keeps frontmatter identity and defers instructions to the CLI", () => {
    const md = createSkillMarkdown();
    expect(md.startsWith("---\nname: tasks-axi\n")).toBe(true);
    expect(md).toContain(JSON.stringify(SKILL_DESCRIPTION));
    expect(md).toContain("metadata:");
    expect(md).toContain(DESCRIPTION);
    expect(md).toContain("`npx -y tasks-axi`");
    expect(md).toContain("`npx -y tasks-axi --help`");
    expect(md).toContain("`npx -y tasks-axi <command> --help`");
  });

  it("does not bake CLI-owned command, flag, or workflow text", () => {
    const md = createSkillMarkdown();
    expect(md).not.toContain("## Commands");
    expect(md).not.toContain("## Tips");
    expect(md).not.toContain("## Workflow");
    expect(md).not.toMatch(/^commands\[\d+\]:/m);
  });

  it("matches the committed skill file (guards against drift)", () => {
    const committed = readFileSync(
      new URL("../skills/tasks-axi/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(normalizeLineEndings(committed)).toBe(createSkillMarkdown());
  });
});
