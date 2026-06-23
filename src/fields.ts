import { AxiError } from "./errors.js";
import type { FieldDef } from "./toon.js";

export interface ParseFieldsResult {
  extraDefs: FieldDef[];
}

/**
 * Parse a --fields value (comma-separated field names), validate against the
 * available allow-list, and return the extra FieldDefs to append to the schema.
 *
 * Returns an empty list when fieldsArg is undefined (no --fields passed).
 * Throws AxiError(VALIDATION_ERROR) for any unknown field names so the agent
 * learns the allow-list from the error (AXI house style §2, §6).
 */
export function parseFields(
  fieldsArg: string | undefined,
  available: Record<string, FieldDef>,
): ParseFieldsResult {
  if (fieldsArg === undefined) {
    return { extraDefs: [] };
  }

  const requested = [
    ...new Set(
      fieldsArg
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];

  const unknown = requested.filter((f) => !(f in available));
  if (unknown.length > 0) {
    const availableNames = Object.keys(available).sort().join(", ");
    throw new AxiError(
      `Unknown field(s): ${unknown.join(", ")}. Available: ${availableNames}`,
      "VALIDATION_ERROR",
    );
  }

  return { extraDefs: requested.map((name) => available[name]) };
}
