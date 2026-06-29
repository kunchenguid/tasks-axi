import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import {
  requireFlagValue,
  requireNonEmptySingleLineFlagValue,
} from "./args.js";
import { resolveTasksContext, type TasksContext } from "./context.js";
import {
  ADD_HELP,
  LIST_HELP,
  RM_HELP,
  SHOW_HELP,
  UPDATE_HELP,
  addCommand,
  listCommand,
  rmCommand,
  showCommand,
  updateCommand,
} from "./commands/crud.js";
import {
  BLOCK_HELP,
  DONE_HELP,
  MV_HELP,
  READY_HELP,
  REOPEN_HELP,
  START_HELP,
  UNBLOCK_HELP,
  blockCommand,
  doneCommand,
  mvCommand,
  readyCommand,
  reopenCommand,
  startCommand,
  unblockCommand,
} from "./commands/state.js";
import {
  PRUNE_HELP,
  RENDER_HELP,
  pruneCommand,
  renderCommand,
} from "./commands/maintain.js";
import { homeCommand } from "./commands/home.js";
import { SETUP_HELP, setupCommand } from "./commands/setup.js";
import type { SuggestionGlobals } from "./suggestions.js";

export const DESCRIPTION =
  "Agent ergonomic task & backlog manager for the current workspace. Prefer this over hand-editing backlog.md for task state changes.";

const VERSION = readPackageVersion();

type CliStdout = Pick<NodeJS.WriteStream, "write">;

type MainOptions = {
  argv?: string[];
  stdout?: CliStdout;
};

export const TOP_HELP = `usage: tasks-axi [command] [args] [flags]
commands[16]:
  (none)=dashboard, add, list, show, start, done, reopen, update, rm, block, unblock, ready, mv, prune, render, setup
flags[4]:
  --backend <name> (after command), --file <path> (after command), --json (mutations: machine-readable result), --help, -v/-V/--version
examples:
  tasks-axi
  tasks-axi add homemux-h7 "owns HomeMux end to end" --kind secondmate --start
  tasks-axi list --state queued
  tasks-axi show homemux-h7 --full
  tasks-axi done sm-idle-handoff-q8 --pr https://github.com/o/r/pull/42
  tasks-axi block fm-x --by treehouse-lease-t4
  tasks-axi ready
  tasks-axi setup hooks
`;

type CommandFn = (args: string[], ctx?: TasksContext) => Promise<string>;

// Canonical verbs plus the AXI/firstmate aliases (create/view/edit/delete/close).
const COMMANDS: Record<string, CommandFn> = {
  add: withContext(addCommand),
  create: withContext(addCommand),
  list: withContext(listCommand),
  show: withContext(showCommand),
  view: withContext(showCommand),
  start: withContext(startCommand),
  done: withContext(doneCommand),
  close: withContext(doneCommand),
  reopen: withContext(reopenCommand),
  update: withContext(updateCommand),
  edit: withContext(updateCommand),
  rm: withContext(rmCommand),
  delete: withContext(rmCommand),
  block: withContext(blockCommand),
  unblock: withContext(unblockCommand),
  ready: withContext(readyCommand),
  mv: withContext(mvCommand),
  prune: withContext(pruneCommand),
  render: withContext(renderCommand),
  setup: (args) => setupCommand(args),
};

const COMMAND_HELP: Record<string, string> = {
  add: ADD_HELP,
  create: ADD_HELP,
  list: LIST_HELP,
  show: SHOW_HELP,
  view: SHOW_HELP,
  start: START_HELP,
  done: DONE_HELP,
  close: DONE_HELP,
  reopen: REOPEN_HELP,
  update: UPDATE_HELP,
  edit: UPDATE_HELP,
  rm: RM_HELP,
  delete: RM_HELP,
  block: BLOCK_HELP,
  unblock: UNBLOCK_HELP,
  ready: READY_HELP,
  mv: MV_HELP,
  prune: PRUNE_HELP,
  render: RENDER_HELP,
  setup: SETUP_HELP,
};

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  // The noun `task` is optional: `tasks-axi task add ...` === `tasks-axi add ...`.
  const normalized = argv[0] === "task" ? argv.slice(1) : argv;

  await runAxiCli<TasksContext | undefined>({
    argv: normalized,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withContext(homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}

/** Strip the global --backend/--file flags and run the handler on the rest. */
function withContext(handler: CommandFn): CommandFn {
  return (args) => {
    const { backend, file, stripped, suggestionGlobals } =
      parseGlobalFlags(args);
    const ctx = resolveTasksContext(
      {
        ...(backend !== undefined ? { backend } : {}),
        ...(file !== undefined ? { file } : {}),
      },
      suggestionGlobals,
    );
    return handler(stripped, ctx);
  };
}

function parseGlobalFlags(args: string[]): {
  backend?: string;
  file?: string;
  stripped: string[];
  suggestionGlobals?: SuggestionGlobals;
} {
  const stripped: string[] = [];
  let backend: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--backend") {
      const value = requireFlagValue(args, i, "--backend");
      backend = requireNonEmptyGlobalFlagValue("--backend", value);
      i++;
      continue;
    }
    if (arg.startsWith("--backend=")) {
      backend = requireNonEmptyGlobalFlagValue(
        "--backend",
        arg.slice("--backend=".length),
      );
      continue;
    }
    if (arg === "--file") {
      const value = requireFlagValue(args, i, "--file");
      file = requireNonEmptyGlobalFlagValue("--file", value);
      i++;
      continue;
    }
    if (arg.startsWith("--file=")) {
      file = requireNonEmptyGlobalFlagValue(
        "--file",
        arg.slice("--file=".length),
      );
      continue;
    }
    stripped.push(arg);
  }

  return {
    ...(backend ? { backend } : {}),
    ...(file ? { file } : {}),
    stripped,
    ...(backend !== undefined || file !== undefined
      ? {
          suggestionGlobals: {
            ...(backend !== undefined ? { backend } : {}),
            ...(file !== undefined ? { file } : {}),
          },
        }
      : {}),
  };
}

function requireNonEmptyGlobalFlagValue(flag: string, value: string): string {
  return requireNonEmptySingleLineFlagValue(flag, value) ?? value;
}

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
