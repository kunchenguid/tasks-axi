import { AxiError, installSessionStartHooks } from "axi-sdk-js";
import { field, renderHelp, renderList, renderOutput } from "../toon.js";

export const SETUP_HELP = `usage: tasks-axi setup hooks
Install or repair agent SessionStart hooks so the backlog is injected as ambient
context at session start for Claude Code, Codex, and OpenCode.

examples:
  tasks-axi setup hooks
`;

export async function setupCommand(args: string[]): Promise<string> {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", [
      "Run `tasks-axi setup hooks`",
    ]);
  }

  const failures: string[] = [];
  installSessionStartHooks({
    onError: (message) => failures.push(message),
  });

  if (failures.length > 0) {
    return renderOutput([
      "hooks:\n  status: partial\n  integrations: Claude Code, Codex, OpenCode",
      renderList(
        "failures",
        failures.map((message) => ({ message })),
        [field("message")],
      ),
      renderHelp(["Fix the listed files and rerun `tasks-axi setup hooks`"]),
    ]);
  }

  return renderOutput([
    "hooks:\n  status: installed\n  integrations: Claude Code, Codex, OpenCode",
    renderHelp([
      "Restart your agent session to receive tasks-axi ambient context",
    ]),
  ]);
}
