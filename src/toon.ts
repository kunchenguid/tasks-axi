import { encode } from "@toon-format/toon";

/**
 * Field extractor definitions for projecting flat task records into TOON.
 * Internal logic stays on JSON; this is the conversion at the output boundary
 * (AXI house style §1). Rows are built as full flat records, so a simple
 * `field` projection plus an escape-hatch `custom` extractor is all we need.
 */
export type FieldDef =
  | { type: "field"; key: string; as?: string }
  | { type: "custom"; as: string; fn: (item: Record<string, unknown>) => unknown };

export function field(key: string, as?: string): FieldDef {
  return { type: "field", key, as };
}

export function custom(
  as: string,
  fn: (item: Record<string, unknown>) => unknown,
): FieldDef {
  return { type: "custom", as, fn };
}

function extract(
  item: Record<string, unknown>,
  schema: FieldDef[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of schema) {
    if (def.type === "field") {
      result[def.as ?? def.key] = item[def.key] ?? null;
    } else {
      result[def.as] = def.fn(item);
    }
  }
  return result;
}

/** Render a labeled list of records as TOON. */
export function renderList(
  label: string,
  items: Record<string, unknown>[],
  schema: FieldDef[],
): string {
  return encode({ [label]: items.map((item) => extract(item, schema)) });
}

/** Render a single labeled detail record as TOON. */
export function renderDetail(
  label: string,
  item: Record<string, unknown>,
  schema: FieldDef[],
): string {
  return encode({ [label]: extract(item, schema) });
}

/** Render help suggestions (manual formatting — encode() inlines primitive arrays). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

/** Combine multiple TOON blocks into a single output string. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}
