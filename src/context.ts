import { AdoRestClient } from "./backends/ado-client.js";
import { AdoStore } from "./backends/ado.js";
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
  const env = overrides.env ?? process.env;
  const config = resolveConfig({ ...overrides, env });

  if (config.backend !== "markdown" && config.backend !== "ado") {
    throw new AxiError(
      `Unsupported backend "${config.backend}" — tasks-axi ships the markdown and ado backends`,
      "UNSUPPORTED",
      ['Set `backend = "markdown"` in .tasks.toml, or omit --backend'],
    );
  }

  return {
    store:
      config.backend === "ado" ? adoStore(config, env) : markdownStore(config),
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

function markdownStore(config: ResolvedConfig): Store {
  return new MarkdownStore({
    path: config.path,
    ...(config.archivePath ? { archivePath: config.archivePath } : {}),
  });
}

function adoStore(config: ResolvedConfig, env: NodeJS.ProcessEnv): Store {
  const ado = config.ado;
  if (!ado) {
    throw new AxiError(
      "The ado backend needs an `[ado]` config table",
      "VALIDATION_ERROR",
      ['Set `[ado] org = "contoso"` and `project = "Internal"` in .tasks.toml'],
    );
  }
  return new AdoStore({
    client: new AdoRestClient({ org: ado.org, project: ado.project, env }),
    project: ado.project,
    ...(ado.area ? { area: ado.area } : {}),
    workItemType: ado.workItemType,
    idField: ado.idField,
    metaField: ado.metaField,
    followupField: ado.followupField,
    states: ado.states,
  });
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
