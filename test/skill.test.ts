import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOP_HELP } from "../src/cli.js";
import {
  createSkillMarkdown,
  extractCommandsBlock,
  SKILL_DESCRIPTION,
} from "../src/skill.js";

describe("skill generation", () => {
  it("extracts the commands block from TOP_HELP", () => {
    const block = extractCommandsBlock();
    expect(block).toContain("commands[");
    expect(block).toContain("add, list, show");
    // the block is a slice of the canonical help, so it can never drift
    expect(TOP_HELP).toContain(block);
  });

  it("renders frontmatter and the shared guidance", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("name: tasks-axi");
    expect(md).toContain(JSON.stringify(SKILL_DESCRIPTION));
    expect(md).toContain("npx -y tasks-axi");
    expect(md).toContain("## Commands");
  });

  it("matches the committed skill file (guards against drift)", () => {
    const committed = readFileSync(
      new URL("../skills/tasks-axi/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown());
  });
});
