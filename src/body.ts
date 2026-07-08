/**
 * Shared truncation for long text fields (AXI house style §3).
 *
 * The whole token win of tasks-axi is that long task bodies never
 * appear in `list` and are truncated in `show` unless the agent asks for the
 * complete text with `--full`. Truncation always reveals the escape hatch and
 * the true size so the agent knows how much it is missing.
 */

import { readFileSync } from "node:fs";
import { AxiError } from "./errors.js";
import { takeFlag } from "./args.js";

export const DEFAULT_TRUNCATE = 500;

/**
 * Resolve a body from `--body <text>` or `--body-file <path>` (mutually
 * exclusive) and remove the flags from args. Returns undefined when neither
 * is present.
 */
export function takeBody(args: string[]): string | undefined {
  const inline = takeFlag(args, "--body");
  const file = takeFlag(args, "--body-file");
  if (inline !== undefined && file !== undefined) {
    throw new AxiError(
      "Use only one of --body or --body-file",
      "VALIDATION_ERROR",
    );
  }
  if (inline !== undefined) return inline;
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new AxiError(
        `Could not read --body-file path: ${file}`,
        "VALIDATION_ERROR",
      );
    }
  }
  return undefined;
}

/**
 * Truncate a text field for display. Returns the raw text when it fits within
 * maxLen; otherwise returns the first maxLen characters plus a sentinel naming
 * the total size and the `--full` escape hatch.
 */
export function truncate(
  text: unknown,
  maxLen = DEFAULT_TRUNCATE,
  hint = "use --full to see complete text",
): string {
  if (typeof text !== "string" || text === "") return "";
  if (text.length <= maxLen) return text;
  return (
    text.slice(0, maxLen) +
    `\n... (truncated, ${text.length} chars total - ${hint})`
  );
}
