import { AxiError, exitCodeForError } from "axi-sdk-js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "LOCKED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

/** A task id was referenced that does not exist in the backlog. */
export function notFound(id: string, suggestions: string[] = []): AxiError {
  return new AxiError(
    `Task "${id}" not found in this backlog`,
    "NOT_FOUND",
    suggestions.length > 0
      ? suggestions
      : ["Run `tasks-axi list` to see existing tasks"],
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
