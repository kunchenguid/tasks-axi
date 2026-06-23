/**
 * Contextual next-step suggestions (AXI house style §9). Each line is a
 * complete runnable command; placeholders like <id> are used for runtime
 * values rather than guessing concrete ones.
 */

export interface SuggestionContext {
  action: string;
  id?: string;
  isEmpty?: boolean;
  /** A blocked task suggests unblocking; an empty ready list suggests listing. */
  blocked?: boolean;
}

type Entry = {
  match: (c: SuggestionContext) => boolean;
  lines: (c: SuggestionContext) => string[];
};

const table: Entry[] = [
  {
    match: (c) => c.action === "home",
    lines: () => [
      "Run `tasks-axi list` for the full backlog",
      "Run `tasks-axi ready` to see unblocked queued work",
      'Run `tasks-axi add <id> "<title>" --start` to add and start a task',
    ],
  },
  {
    match: (c) => c.action === "list" && c.isEmpty === true,
    lines: () => [
      'Run `tasks-axi add <id> "<title>"` to add a task',
      "Run `tasks-axi list --state done` to see completed work",
    ],
  },
  {
    match: (c) => c.action === "list",
    lines: () => [
      "Run `tasks-axi show <id>` for full notes on a task",
      "Run `tasks-axi ready` to see unblocked queued work",
    ],
  },
  {
    match: (c) => c.action === "ready" && c.isEmpty === true,
    lines: () => [
      "Run `tasks-axi list --state queued` to see all queued work (incl. blocked)",
    ],
  },
  {
    match: (c) => c.action === "ready",
    lines: () => ["Run `tasks-axi start <id>` to dispatch one of these"],
  },
  {
    match: (c) => c.action === "show" && c.blocked === true,
    lines: (c) => [
      `Run \`tasks-axi unblock ${c.id} --by <other>\` to clear a blocker`,
      `Run \`tasks-axi start ${c.id}\` to move it to in flight`,
    ],
  },
  {
    match: (c) => c.action === "add",
    lines: (c) => [
      `Run \`tasks-axi start ${c.id}\` to move it to in flight`,
      `Run \`tasks-axi block ${c.id} --by <other>\` to record a dependency`,
    ],
  },
  {
    match: (c) => c.action === "start",
    lines: (c) => [
      `Run \`tasks-axi done ${c.id} --pr <url>\` when it ships`,
    ],
  },
  {
    match: (c) => c.action === "done",
    lines: () => ["Run `tasks-axi ready` to dispatch work unblocked by this"],
  },
  {
    match: (c) => c.action === "block",
    lines: (c) => [
      `Run \`tasks-axi unblock ${c.id} --by <other>\` to clear it`,
      "Run `tasks-axi ready` to see what is still dispatchable",
    ],
  },
  {
    match: (c) => c.action === "unblock",
    lines: () => ["Run `tasks-axi ready` to see newly unblocked work"],
  },
  {
    match: (c) => c.action === "update",
    lines: (c) => [`Run \`tasks-axi show ${c.id} --full\` to see the result`],
  },
  {
    match: (c) => c.action === "reopen",
    lines: (c) => [`Run \`tasks-axi start ${c.id}\` to move it to in flight`],
  },
  {
    match: (c) => c.action === "rm",
    lines: () => ["Run `tasks-axi list` to see remaining tasks"],
  },
  {
    match: (c) => c.action === "prune",
    lines: () => ["Run `tasks-axi list --state done` to see retained Done items"],
  },
];

export function getSuggestions(ctx: SuggestionContext): string[] {
  for (const entry of table) {
    if (entry.match(ctx)) return entry.lines(ctx);
  }
  return [];
}
