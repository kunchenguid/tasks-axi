import { dirname } from "node:path";
import { BeadsStore } from "./backends/beads.js";
import { MarkdownStore } from "./backends/markdown.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so swapping in
 * sqlite/remote backends (P2/P3) never touches arg parsing or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);
  const store = createStore(config);
  return {
    store,
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

function createStore(config: ResolvedConfig): Store {
  if (config.backend === "markdown") {
    return new MarkdownStore({
      path: config.path,
      ...(config.archivePath ? { archivePath: config.archivePath } : {}),
    });
  }
  if (config.backend === "beads") {
    // `path` doubles as the canonical-markdown mirror the beads backend keeps.
    return new BeadsStore({
      mirrorPath: config.path,
      dir: config.beads?.dir ?? dirname(config.path),
      ...(config.beads?.bin ? { bin: config.beads.bin } : {}),
      ...(config.archivePath ? { archivePath: config.archivePath } : {}),
    });
  }
  throw new AxiError(
    `Unsupported backend "${config.backend}" — available backends: markdown, beads`,
    "UNSUPPORTED",
    [
      'Set `backend = "markdown"` or `backend = "beads"` in .tasks.toml, or omit --backend',
    ],
  );
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
