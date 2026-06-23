import { AxiError } from "./errors.js";

function flagEqualsPrefix(flag: string): string {
  return `${flag}=`;
}

export function requireFlagValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... if the value begins with --`,
    ]);
  }
  return value;
}

/** Get a flag's value from --flag value or --flag=value without modifying args. */
export function getFlag(args: string[], name: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(name);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      return requireFlagValue(args, i, name);
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length);
    }
  }
  return undefined;
}

/** Get a flag's value from --flag value or --flag=value and remove it from args. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(flag);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const val = requireFlagValue(args, i, flag);
      args.splice(i, 2);
      return val;
    }
    if (arg.startsWith(equalsPrefix)) {
      const val = arg.slice(equalsPrefix.length);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

/** Check if a boolean flag is present. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Check if a boolean flag is present and remove it from args. */
export function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Collect all values for a repeatable flag and remove every occurrence from args. */
export function takeAllFlags(args: string[], flag: string): string[] {
  const result: string[] = [];
  let value = takeFlag(args, flag);
  while (value !== undefined) {
    result.push(value);
    value = takeFlag(args, flag);
  }
  return result;
}

export function parseNonNegativeIntegerFlag(
  flag: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new AxiError(`${flag} must be a non-negative integer`, "VALIDATION_ERROR");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AxiError(`${flag} must be a non-negative integer`, "VALIDATION_ERROR");
  }
  return value;
}

/**
 * Get the first positional (non-flag) argument starting at startIndex.
 * A positional is any token that does not start with "-"; the token
 * immediately following a value-flag is skipped so it is not mistaken
 * for a positional.
 */
export function getPositional(
  args: string[],
  startIndex: number,
): string | undefined {
  for (let i = startIndex; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

/** Require a positional id argument, throwing a structured error if missing. */
export function requireId(raw: string | undefined, label = "id"): string {
  if (!raw || raw.trim() === "") {
    throw new AxiError(`Missing ${label}`, "VALIDATION_ERROR", [
      `Pass the task ${label}, e.g. \`tasks-axi show <id>\``,
    ]);
  }
  return raw;
}
