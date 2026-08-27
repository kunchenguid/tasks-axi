import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";

export const REVISION_SCHEMA_VERSION = 1 as const;
const TOKEN_PREFIX = "tasks-axi:markdown:v";
const TOKEN_RE =
  /^tasks-axi:markdown:v([1-9]\d*):([a-f0-9]{64}):([a-f0-9]{64})$/;

export interface OwnerRevision {
  /** Canonical absolute path identifying the mutation owner. */
  owner: string;
  /** Opaque, owner-bound, versioned revision token. */
  revision: string;
}

export interface MoveRevisionSnapshot {
  schema_version: typeof REVISION_SCHEMA_VERSION;
  source: OwnerRevision;
  destination: OwnerRevision;
}

export interface MoveCasExpected {
  source?: string;
  destination?: string;
}

export type CasOwner = "source" | "destination" | "operation";
export type CasFailureReason =
  | "missing_revision"
  | "malformed_revision"
  | "unsupported_revision"
  | "owner_mismatch"
  | "stale_revision"
  | "same_owner"
  | "unsupported_backend";

export interface CasFailure {
  owner: CasOwner;
  reason: CasFailureReason;
}

interface ParsedRevision {
  version: number;
  ownerDigest: string;
  stateDigest: string;
}

/**
 * Hash an exact markdown owner state into an opaque v1 token.
 *
 * The owner digest binds a token to one canonical path, preventing source and
 * destination tokens from being swapped even when both files have identical
 * bytes. The state digest distinguishes a missing owner from an empty file.
 */
export function ownerRevision(
  owner: string,
  source: string | Uint8Array | undefined,
): OwnerRevision {
  const ownerDigest = sha256(`tasks-axi/markdown-owner/v1\0${owner}`);
  const state =
    source === undefined
      ? Buffer.from("tasks-axi/markdown-state/v1\0missing", "utf8")
      : Buffer.concat([
          Buffer.from("tasks-axi/markdown-state/v1\0present\0", "utf8"),
          typeof source === "string"
            ? Buffer.from(source, "utf8")
            : Buffer.from(source),
        ]);
  const stateDigest = createHash("sha256").update(state).digest("hex");
  return {
    owner,
    revision: `${TOKEN_PREFIX}${REVISION_SCHEMA_VERSION}:${ownerDigest}:${stateDigest}`,
  };
}

export function moveRevisionSnapshot(
  source: OwnerRevision,
  destination: OwnerRevision,
): MoveRevisionSnapshot {
  return {
    schema_version: REVISION_SCHEMA_VERSION,
    source,
    destination,
  };
}

/** Validate both expectations against evidence derived under the move locks. */
export function compareMoveRevisions(
  expected: MoveCasExpected,
  current: MoveRevisionSnapshot,
): CasFailure[] {
  const failures: CasFailure[] = [];
  compareOne("source", expected.source, current.source, failures);
  compareOne(
    "destination",
    expected.destination,
    current.destination,
    failures,
  );
  return failures;
}

function compareOne(
  owner: "source" | "destination",
  expected: string | undefined,
  current: OwnerRevision,
  failures: CasFailure[],
): void {
  if (expected === undefined) {
    failures.push({ owner, reason: "missing_revision" });
    return;
  }

  const parsed = parseRevision(expected);
  if (parsed === "malformed") {
    failures.push({ owner, reason: "malformed_revision" });
    return;
  }
  if (parsed === "unsupported") {
    failures.push({ owner, reason: "unsupported_revision" });
    return;
  }

  const currentParsed = parseRevision(current.revision);
  if (typeof currentParsed === "string") {
    throw new AxiError(
      "tasks-axi generated an invalid current revision",
      "UNKNOWN",
    );
  }
  if (parsed.ownerDigest !== currentParsed.ownerDigest) {
    failures.push({ owner, reason: "owner_mismatch" });
    return;
  }
  if (parsed.stateDigest !== currentParsed.stateDigest) {
    failures.push({ owner, reason: "stale_revision" });
  }
}

function parseRevision(
  revision: string,
): ParsedRevision | "malformed" | "unsupported" {
  const matched = TOKEN_RE.exec(revision);
  if (!matched) {
    const version = /^tasks-axi:markdown:v(\d+):/.exec(revision);
    return version && Number(version[1]) !== REVISION_SCHEMA_VERSION
      ? "unsupported"
      : "malformed";
  }
  const parsed: ParsedRevision = {
    version: Number(matched[1]),
    ownerDigest: matched[2],
    stateDigest: matched[3],
  };
  return matched[1] === String(REVISION_SCHEMA_VERSION)
    ? parsed
    : "unsupported";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A stable JSON refusal used by the opt-in CAS CLI boundary. */
export class CasRefusalError extends AxiError {
  readonly failures: CasFailure[];
  readonly current?: MoveRevisionSnapshot;

  constructor(
    failures: CasFailure[],
    current?: MoveRevisionSnapshot,
    message = "Compare-and-swap move refused",
  ) {
    super(message, "CAS_REFUSED");
    this.failures = failures;
    this.current = current;
  }

  toJson(): Record<string, unknown> {
    return {
      ok: false,
      action: "mv",
      error: this.message,
      code: this.code,
      cas: {
        schema_version: REVISION_SCHEMA_VERSION,
        failures: this.failures,
        ...(this.current ? { current: this.current } : {}),
      },
    };
  }
}
