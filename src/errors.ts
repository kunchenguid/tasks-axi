import { AxiError, exitCodeForError } from "axi-sdk-js";
import type { Dep } from "./model.js";
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
 * Moving `id` out of a collection would leave active dependents behind, still
 * blocked by a task that is no longer there. Raised by the markdown backend
 * (walking its locked document) and by the command-layer fallback (walking core
 * Store verbs) alike, so the detection may differ but the wording cannot.
 */
export function stillBlockingError(id: string, stranded: string[]): AxiError {
  return new AxiError(
    `Task "${id}" is still blocking active tasks: ${stranded.join(", ")}`,
    "VALIDATION_ERROR",
    [
      `Move them together, or unblock them first, e.g. \`tasks-axi unblock ${stranded[0]} --by ${id}\``,
    ],
  );
}

/** Moving `id` would leave one of its own edges pointing across collections. */
export function strandedDepError(id: string, dep: Dep): AxiError {
  const label = dep.type === "blocked-by" ? "blocker" : "dependency";
  return new AxiError(
    `Cannot move "${id}": its ${label} "${dep.id}" would be stranded (not in the moved set and absent from the destination)`,
    "VALIDATION_ERROR",
    [`Add "${dep.id}" to the same \`mv\`, or move it to the destination first`],
  );
}

/**
 * The one operator-facing contract for a move that copied a task into the
 * destination, then failed to remove the source AND failed to roll the copy
 * back. Both the atomic backend path and the command-layer fallback raise it,
 * so the wording an operator has to act on cannot drift between them.
 */
export function partialMoveError(
  id: string,
  originalError: unknown,
  rollbackError: unknown,
  destination?: string,
): AxiError {
  return new AxiError(
    `Move of "${id}" partially completed; task now exists in both backlogs`,
    "CONFLICT",
    [
      destination
        ? `Remove "${id}" from ${destination} manually before retrying`
        : "Remove the duplicate from the destination backlog manually before retrying",
      `Source removal failed: ${describeError(originalError)}`,
      `Destination rollback failed: ${describeError(rollbackError)}`,
    ],
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
