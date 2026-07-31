import { GithubStore } from "./backends/github.js";
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
 * another backend never touches arg parsing or rendering.
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
  return {
    store: createStore(config),
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
  if (config.backend === "github") {
    const github = config.github;
    if (!github?.repo) {
      throw new AxiError(
        "The github backend requires a repository",
        "VALIDATION_ERROR",
        ['Set `[github] repo = "owner/name"` in .tasks.toml'],
      );
    }
    return new GithubStore({
      repo: github.repo,
      labels: {
        inFlight: github.inFlightLabel,
        blocked: github.blockedLabel,
        held: github.heldLabel,
      },
    });
  }
  throw new AxiError(
    `Unsupported backend "${config.backend}" - supported backends: markdown, github`,
    "UNSUPPORTED",
    [
      'Set `backend = "markdown"` or `backend = "github"` in .tasks.toml, or omit --backend',
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
