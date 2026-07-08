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
  /**
   * The resulting state after a mutation. Lets hints stay state-aware so a
   * command never suggests an action it just performed (e.g. no "run start"
   * after `add --start`).
   */
  state?: string;
  globals?: SuggestionGlobals;
  filters?: SuggestionFilters;
}

export interface SuggestionGlobals {
  backend?: string;
  file?: string;
}

export interface SuggestionFilters {
  repo?: string;
  kind?: string;
  state?: string;
}

type Entry = {
  match: (c: SuggestionContext) => boolean;
  lines: (c: SuggestionContext) => string[];
};

type ScopedFlag = keyof SuggestionFilters;

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
    lines: (c) =>
      compact([
        suggestionLine('Run `tasks-axi add <id> "<title>"` to add a task', c, [
          "repo",
          "kind",
        ]),
        suggestionLine(
          "Run `tasks-axi list --state done` to see completed work",
          c,
          ["repo", "kind"],
        ),
      ]),
  },
  {
    match: (c) => c.action === "list",
    lines: (c) =>
      compact([
        "Run `tasks-axi show <id>` for full notes on a task",
        suggestionLine(
          "Run `tasks-axi ready` to see unblocked queued work",
          c,
          ["repo"],
        ),
      ]),
  },
  {
    match: (c) => c.action === "ready" && c.isEmpty === true,
    lines: (c) =>
      compact([
        suggestionLine(
          "Run `tasks-axi list --state queued` to see all queued work (incl. blocked)",
          c,
          ["repo"],
        ),
      ]),
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
    // `add --start` (or re-adding an in-flight task) already moved it, so the
    // genuinely useful next step is closing it, never "run start".
    match: (c) => c.action === "add" && c.state === "in_flight",
    lines: (c) => [
      `Run \`tasks-axi done ${c.id} --pr <url>\` when it ships`,
      `Run \`tasks-axi block ${c.id} --by <other>\` to record a dependency`,
    ],
  },
  {
    match: (c) => c.action === "add" && c.state === "done",
    lines: (c) => [
      `Run \`tasks-axi reopen ${c.id}\` to move it back to queued`,
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
    lines: (c) => [`Run \`tasks-axi done ${c.id} --pr <url>\` when it ships`],
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
    match: (c) => c.action === "hold",
    lines: (c) => [
      `Run \`tasks-axi unhold ${c.id}\` to resume dispatch`,
      "Run `tasks-axi ready --include-held` to review paused work",
    ],
  },
  {
    match: (c) => c.action === "unhold",
    lines: () => ["Run `tasks-axi ready` to see dispatchable work"],
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
    lines: () => [
      "Run `tasks-axi list --state done` to see retained Done items",
    ],
  },
  {
    match: (c) => c.action === "mv",
    lines: () => ["Run `tasks-axi list` to see remaining tasks"],
  },
  {
    match: (c) => c.action === "render",
    lines: () => ["Run `tasks-axi list` to see the normalized backlog"],
  },
];

export function getSuggestions(ctx: SuggestionContext): string[] {
  for (const entry of table) {
    if (entry.match(ctx)) {
      return withSuggestionGlobals(entry.lines(ctx), ctx.globals);
    }
  }
  return [];
}

export function withSuggestionGlobals(
  lines: string[],
  globals: SuggestionGlobals | undefined,
): string[] {
  const suffix = globalSuffix(globals);
  if (suffix === undefined) return [];
  if (!suffix) return lines;
  return lines.flatMap((line) => {
    const withSuffix = appendSuffixToCommand(line, suffix);
    return withSuffix ? [withSuffix] : [];
  });
}

function globalSuffix(
  globals: SuggestionGlobals | undefined,
): string | undefined {
  if (!globals) return "";
  const parts: string[] = [];
  if (globals.backend !== undefined) {
    const quoted = shellQuoteOneLine(globals.backend);
    if (!quoted) return undefined;
    parts.push(`--backend=${quoted}`);
  }
  if (globals.file !== undefined) {
    const quoted = shellQuoteOneLine(globals.file);
    if (!quoted) return undefined;
    parts.push(`--file=${quoted}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function appendSuffixToCommand(
  line: string,
  suffix: string,
): string | undefined {
  const first = line.indexOf("`");
  if (first === -1) return undefined;
  const second = line.indexOf("`", first + 1);
  if (second === -1) return undefined;

  const command = line.slice(first + 1, second);
  if (command !== "tasks-axi" && !command.startsWith("tasks-axi ")) {
    return undefined;
  }
  return `${line.slice(0, second)}${suffix}${line.slice(second)}`;
}

function shellQuoteOneLine(value: string): string | undefined {
  if (/[\0\r\n`]/.test(value)) return undefined;
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function suggestionLine(
  line: string,
  ctx: SuggestionContext,
  supportedFlags: ScopedFlag[],
): string | undefined {
  const suffix = filterSuffix(ctx.filters, supportedFlags);
  if (suffix === undefined) return undefined;
  if (!suffix) return line;
  return appendSuffixToCommand(line, suffix);
}

function filterSuffix(
  filters: SuggestionFilters | undefined,
  supportedFlags: ScopedFlag[],
): string | undefined {
  if (!filters) return "";
  const supported = new Set<ScopedFlag>(supportedFlags);
  for (const flag of Object.keys(filters) as ScopedFlag[]) {
    if (filters[flag] !== undefined && !supported.has(flag)) {
      return undefined;
    }
  }
  const parts: string[] = [];
  for (const flag of supportedFlags) {
    const value = filters[flag];
    if (value === undefined) continue;
    const quoted = shellQuoteOneLine(value);
    if (!quoted) return undefined;
    parts.push(`--${flag}=${quoted}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function compact<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => item !== undefined);
}
