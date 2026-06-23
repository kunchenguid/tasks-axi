import { randomBytes } from "node:crypto";
import { ID_RE } from "./backends/markdown-grammar.js";
import { AxiError } from "./errors.js";

/**
 * Id ownership (decision D6, report §2.2): the caller supplies the id - it is
 * the join key to state/<id>, data/<id>/report.md, and tmux windows - and
 * tasks-axi can optionally mint one in firstmate's `slug-xx` style.
 */

/** Validate a caller-supplied id round-trips through the markdown grammar. */
export function validateId(
  id: string,
  suggestions = [
    "Use a slug like `homemux-h7`, or pass --mint to generate one",
  ],
): string {
  if (!ID_RE.test(id)) {
    throw new AxiError(
      `Invalid id "${id}" - ids must be slug-shaped (letters, digits, "._-") with no spaces`,
      "VALIDATION_ERROR",
      suggestions,
    );
  }
  return id;
}

export function validateDependencyId(id: string): string {
  return validateId(id, [
    "Use an existing task slug like `treehouse-lease-t4`",
  ]);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** A short collision-avoidance suffix in firstmate's `-xx` style. */
function suffix(): string {
  return randomBytes(4).toString("hex").slice(0, 2);
}

export function mintIdForSuffix(
  title: string,
  suffixValue: string,
  prefix?: string,
): string {
  if (!/^[0-9a-f]{2}$/.test(suffixValue)) {
    throw new AxiError(
      "Minted id suffix must be two lowercase hex characters",
      "VALIDATION_ERROR",
    );
  }
  const base = slugify(title) || "task";
  const head = prefix ? `${slugify(prefix)}-${base}` : base;
  return validateId(`${head}-${suffixValue}`);
}

export const MINT_SUFFIXES = Array.from({ length: 256 }, (_, index) =>
  index.toString(16).padStart(2, "0"),
);

/** Mint a slug-xx id from a title, optionally namespaced with a prefix. */
export function mintId(title: string, prefix?: string): string {
  return mintIdForSuffix(title, suffix(), prefix);
}
