import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill. Terse and
// outcome-focused so it fires on "manage the backlog / track tasks" intents.
export const SKILL_DESCRIPTION =
  "Manage a task backlog through the tasks-axi CLI - add, list, show, start, " +
  "and complete tasks; track blocked-by dependencies, structured holds, and a " +
  "ready queue; prune and normalize a hand-editable backlog.md. Use whenever a task touches " +
  "backlog or task state: filing or dispatching work, recording a PR or report " +
  "on completion, finding dispatchable or held work, or trimming the Done list.";

export const SKILL_AUTHOR = "Kun Chen (kunchenguid)";

// Extended frontmatter read by Nous Research's Hermes Agent harness; harnesses
// that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = ["tasks", "backlog", "planning", "dependencies"];
export const HERMES_CATEGORY = "productivity";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md as a minimal stub.
 *
 * Frontmatter is the skill's identity and discovery surface. The body only
 * says what tasks-axi is, when to reach for it, and where to get live
 * instructions: the CLI itself. Never bake CLI-owned commands, flags, or
 * workflow steps here - an installed skill goes stale when the npm package
 * is bumped, and `pnpm run build:skill` would re-inflate any such copy.
 */
export function createSkillMarkdown(): string {
  return `---
name: tasks-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# tasks-axi

${DESCRIPTION}

## When to use

Use tasks-axi whenever a task touches the backlog: filing or dispatching work, moving a task through queued -> in flight -> done, recording a PR url or report path on completion, tracking blocked-by dependencies, pausing dispatch with structured holds, finding dispatchable ready work or intentionally held work, or trimming the Done list.

Get every command, flag, and workflow from the live CLI - it is the single source of truth:

- \`npx -y tasks-axi\` - dashboard of the current backlog
- \`npx -y tasks-axi --help\` - global usage
- \`npx -y tasks-axi <command> --help\` - per-command usage

You do not need tasks-axi installed globally. If the CLI prints a follow-up starting with \`tasks-axi\`, run it as \`npx -y tasks-axi ...\` instead.
`;
}
