import { AxiError, exitCodeForError } from "axi-sdk-js";
import type { Capabilities, Store } from "./store.js";
import {
  type SuggestionGlobals,
  withSuggestionGlobals,
} from "./suggestions.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "LOCKED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

interface NotFoundOptions {
  globals?: SuggestionGlobals;
  suggestions?: string[];
}

/** A task id was referenced that does not exist in the backlog. */
export function notFound(id: string, options: NotFoundOptions = {}): AxiError {
  const suggestions =
    options.suggestions ??
    withSuggestionGlobals(
      ["Run `tasks-axi list` to see existing tasks"],
      options.globals,
    );
  return new AxiError(
    `Task "${id}" not found in this backlog`,
    "NOT_FOUND",
    suggestions,
  );
}

/**
 * A capability the active backend does not support was requested. The
 * capability is named so the error is actionable rather than a raw failure
 * (AXI house style §6; report §8 graceful degradation).
 */
export function unsupported(capability: string, backend: string): AxiError {
  return new AxiError(
    `The ${backend} backend does not support ${capability}`,
    "UNSUPPORTED",
  );
}

/**
 * Enforce a declared `Capabilities` boolean before a command touches the
 * store: a backend that declares a capability false gets a structured
 * refusal naming the user-facing feature, never a raw backend error.
 */
export function requireCapability(
  store: Store,
  capability: Exclude<keyof Capabilities, "backend">,
  feature: string,
): void {
  const caps = store.capabilities();
  if (!caps[capability]) throw unsupported(feature, caps.backend);
}
