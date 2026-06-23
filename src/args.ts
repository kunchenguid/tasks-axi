import { AxiError } from "./errors.js";
import { STATES, type State } from "./model.js";

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

export function requireNonEmptyFlagValue(
  flag: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... with a non-empty value`,
    ]);
  }
  return value;
}

export function requireNonEmptySingleLineFlagValue(
  flag: string,
  value: string | undefined,
): string | undefined {
  const checked = requireNonEmptyFlagValue(flag, value);
  if (checked === undefined) return undefined;
  if (/[\r\n]/.test(checked)) {
    throw new AxiError(`${flag} must be a single line`, "VALIDATION_ERROR", [
      `Pass ${flag}=... without line breaks`,
    ]);
  }
  return checked;
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
  if (raw === undefined) return requireNonNegativeInteger(flag, fallback);
  return parseRequiredNonNegativeIntegerFlag(flag, raw);
}

export function parseOptionalNonNegativeIntegerFlag(
  flag: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  return parseRequiredNonNegativeIntegerFlag(flag, raw);
}

function parseRequiredNonNegativeIntegerFlag(
  flag: string,
  raw: string,
): number {
  if (!/^\d+$/.test(raw)) {
    throw new AxiError(
      `${flag} must be a non-negative integer`,
      "VALIDATION_ERROR",
    );
  }
  return requireNonNegativeInteger(flag, Number(raw));
}

function requireNonNegativeInteger(flag: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      `${flag} must be a non-negative integer`,
      "VALIDATION_ERROR",
    );
  }
  return value;
}

export function parseStateFlag(
  flag: string,
  raw: string | undefined,
): State | undefined;
export function parseStateFlag(
  flag: string,
  raw: string | undefined,
  fallback: State,
): State;
export function parseStateFlag(
  flag: string,
  raw: string | undefined,
  fallback?: State,
): State | undefined {
  if (raw === undefined) return fallback;
  if (!(STATES as readonly string[]).includes(raw)) {
    throw new AxiError(
      `${flag} must be one of queued, in_flight, done`,
      "VALIDATION_ERROR",
    );
  }
  return raw as State;
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

export function requireNoUnknownFlags(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (!unknown) return;
  throw new AxiError(`Unknown flag: ${unknown}`, "VALIDATION_ERROR", [
    "Run the command with --help to see supported flags",
  ]);
}

export function requirePositionals(
  args: string[],
  min: number,
  max: number,
  usage: string,
): string[] {
  requireNoUnknownFlags(args);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length >= min && positionals.length <= max) {
    return positionals;
  }

  const expected =
    min === max
      ? min === 0
        ? "no positional arguments"
        : `${min} positional argument${min === 1 ? "" : "s"}`
      : `${min}-${max} positional arguments`;
  throw new AxiError(
    `Expected ${expected}, got ${positionals.length}`,
    "VALIDATION_ERROR",
    [usage],
  );
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
