import { AxiError } from "./errors.js";

export const PUBLIC_FOLLOWUP_KIND = "public-followup";
export const PUBLIC_FOLLOWUP_SCHEMA_VERSION = 1 as const;

export const PUBLIC_FOLLOWUP_PURPOSES = [
  "promised-final",
  "correction",
  "investigation-result",
  "milestone",
] as const;
export type PublicFollowupPurpose = (typeof PUBLIC_FOLLOWUP_PURPOSES)[number];

export const EXPECTED_FINAL_TYPES = [
  "pr-merged",
  "report-ready",
  "local-main",
  "failure-outcome",
  "explicit-answer",
] as const;
export type ExpectedFinalType = (typeof EXPECTED_FINAL_TYPES)[number];

export const COMPLETION_POLICIES = ["all-required", "any-required"] as const;
export type CompletionPolicy = (typeof COMPLETION_POLICIES)[number];

export const DELIVERY_STATES = [
  "intent",
  "pending-work",
  "ready",
  "preflight-matched",
  "delivery-registered",
  "delivery-posting",
  "context-blocked",
  "retry-due",
  "unknown",
  "partial",
  "posted",
  "expired-action-required",
  "waived",
] as const;
export type PublicFollowupDeliveryState = (typeof DELIVERY_STATES)[number];

export const WORK_ROLES = ["fulfills", "contributes"] as const;
export type WorkRole = (typeof WORK_ROLES)[number];

export const WORK_RELATION_STATES = [
  "bound",
  "landed",
  "failed",
  "superseded",
] as const;
export type WorkRelationState = (typeof WORK_RELATION_STATES)[number];

export const WORK_OUTCOME_TYPES = [
  "pr-merged",
  "report-ready",
  "local-main",
  "failed",
  "superseded",
] as const;
export type WorkOutcomeType = (typeof WORK_OUTCOME_TYPES)[number];

export type PublicPlatform = "x" | "discord";

export interface PublicFollowupRequest {
  request_id: string;
  platform: PublicPlatform;
  context_binding: {
    version: "ctx1";
    value: string;
  };
  public_safe_summary: string;
  received_at: string;
  followup_expires_at: string;
  reservation_expires_at: string;
}

export interface ExpectedFinal {
  type: ExpectedFinalType;
  project: string | null;
  required_deliverables: string[];
  completion_policy: CompletionPolicy;
}

export interface WorkRef {
  home_id: string;
  task_id: string;
}

export interface WorkRelationInput {
  relation_id: string;
  work_ref: WorkRef;
  role: WorkRole;
  required: boolean;
  generation: number;
}

export interface AcceptedWorkEvent {
  schema_version: 1;
  event_id: string;
  obligation_id: string;
  relation_id: string;
  generation: number;
  source_home_id: string;
  work_id: string;
  outcome_type: WorkOutcomeType;
  deliverables: Record<string, string>;
  public_safe_outcome: string;
  occurred_at: string;
}

export interface WorkRelation extends WorkRelationInput {
  state: WorkRelationState;
  successor_relation_id: string | null;
  accepted_event_ids: string[];
  /** Safe terminal evidence retained after the destination outbox is acknowledged. */
  accepted_events: AcceptedWorkEvent[];
}

export interface WorkEvent extends AcceptedWorkEvent {
  successor: WorkRelationInput | null;
}

export interface PostedReceipt {
  schema_version: 1;
  state: "posted";
  request_id: string;
  platform: PublicPlatform;
  attempt_count: number;
  total_chunks: number;
  posted_chunks: number;
  posted_at: string;
  retain_until: string | null;
}

export const DELIVERY_ERROR_STATES = [
  "context-blocked",
  "retry-due",
  "unknown",
  "partial",
  "expired-action-required",
] as const;
export type DeliveryErrorState = (typeof DELIVERY_ERROR_STATES)[number];

export interface DeliveryError {
  schema_version: 1;
  state: DeliveryErrorState;
  error_code: string;
  occurred_at: string;
  next_attempt_at: string | null;
  total_chunks: number | null;
  posted_chunks: number | null;
}

export interface PublicFollowupWaiver {
  approved_by: "captain";
  reason: string;
  waived_at: string;
}

export interface PublicFollowupDelivery {
  state: PublicFollowupDeliveryState;
  delivery_key: string;
  payload_digest: string | null;
  attempt_count: number;
  last_error_code: string | null;
  next_attempt_at: string | null;
  receipt: PostedReceipt | null;
  last_error: DeliveryError | null;
  waiver: PublicFollowupWaiver | null;
}

export interface PublicFollowup {
  schema_version: 1;
  /** Monotonic revision for cross-home acknowledgements and stale-write checks. */
  revision: number;
  request: PublicFollowupRequest;
  purpose: PublicFollowupPurpose;
  expected_final: ExpectedFinal;
  obligation_expires_at: string;
  delivery: PublicFollowupDelivery;
  work_relations: WorkRelation[];
  lineage: {
    predecessor_obligation_id: string | null;
    successor_obligation_id: string | null;
  };
}

export interface PublicFollowupMutation {
  expectedRevision: number;
  /** Full pre-mutation payload so same-revision hand edits cannot be overwritten. */
  expectedPublicFollowup: PublicFollowup;
  publicFollowup: PublicFollowup;
  /** The dedicated receipt or waiver path is atomically completing the task. */
  complete?: boolean;
  /** Recheck same-backlog blockers under the write lock before delivery starts. */
  requireUnblocked?: boolean;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_ID_RE = /^req-[A-Za-z0-9._-]+$/;
const RELATION_ID_RE = /^rel-[A-Za-z0-9._-]+$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HOME_ID_RE = /^(?:main|secondmate:[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const DELIVERY_KEY_RE = /^fd1_[A-Za-z0-9_-]+$/;
const BINDING_RE = /^ctx1_[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DELIVERABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const PR_URL_RE = /^https:\/\/[^?#\s]+\/pull\/\d+$/;
const REPORT_PATH_RE = /^data\/[A-Za-z0-9][A-Za-z0-9._-]*\/report\.md$/;
const COMMIT_SHA_RE = /^[a-f0-9]{7,64}$/;
const EXPECTED_DELIVERABLES: Record<ExpectedFinalType, readonly string[]> = {
  "pr-merged": ["pr_url"],
  "report-ready": ["report_path"],
  "local-main": ["commit_sha"],
  "failure-outcome": ["error_code"],
  "explicit-answer": [],
};
const DELIVERY_TRANSITIONS: Record<
  PublicFollowupDeliveryState,
  readonly PublicFollowupDeliveryState[]
> = {
  intent: ["intent", "pending-work", "waived"],
  "pending-work": ["pending-work", "ready", "waived"],
  ready: [
    "ready",
    "pending-work",
    "preflight-matched",
    "delivery-registered",
    "delivery-posting",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  "preflight-matched": [
    "preflight-matched",
    "delivery-registered",
    "delivery-posting",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  "delivery-registered": [
    "delivery-registered",
    "delivery-posting",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  "delivery-posting": [
    "delivery-posting",
    "posted",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  "context-blocked": [
    "context-blocked",
    "ready",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  "retry-due": [
    "retry-due",
    "delivery-posting",
    "posted",
    ...DELIVERY_ERROR_STATES,
    "waived",
  ],
  unknown: ["unknown", "posted", ...DELIVERY_ERROR_STATES, "waived"],
  partial: ["partial", "posted", ...DELIVERY_ERROR_STATES, "waived"],
  posted: ["posted"],
  "expired-action-required": [
    "expired-action-required",
    "context-blocked",
    "waived",
  ],
  waived: ["waived"],
};
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function validation(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [
    "Repair the typed public-followup data before retrying",
  ]);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return validation(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  path: string,
): void {
  for (const key of required) {
    if (!(key in value)) validation(`${path}.${key} is required`);
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) validation(`${path}.${unknown} is not allowed`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") validation(`${path} must be a string`);
  return value;
}

function hasUnsafeSingleLineControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    const loneSurrogate =
      character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    return code === 0x7f || code < 0x20 || loneSurrogate;
  });
}

function safeText(
  value: unknown,
  path: string,
  max: number,
  options: { allowEmpty?: boolean } = {},
): string {
  const text = stringValue(value, path);
  if (!options.allowEmpty && text.trim() === "") {
    validation(`${path} must not be empty`);
  }
  if (text !== text.trim()) {
    validation(`${path} must not have leading or trailing whitespace`);
  }
  if (text.length > max)
    validation(`${path} must be at most ${max} characters`);
  if (hasUnsafeSingleLineControl(text)) {
    validation(`${path} must be safe single-line text`);
  }
  return text;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    validation(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function boolValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") validation(`${path} must be a boolean`);
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    validation(`${path} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

export function validateRfc3339(value: unknown, path: string): string {
  const text = stringValue(value, path);
  const match = text.match(RFC3339_RE);
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const daysInMonth =
    year >= 1 && month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    !match ||
    day < 1 ||
    day > daysInMonth ||
    !Number.isFinite(Date.parse(text))
  ) {
    validation(`${path} must be RFC3339`);
  }
  return text;
}

function taskId(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!TASK_ID_RE.test(text)) validation(`${path} must be a task id`);
  return text;
}

function requestId(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!REQUEST_ID_RE.test(text)) validation(`${path} must start with req-`);
  return text;
}

function relationId(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!RELATION_ID_RE.test(text)) validation(`${path} must start with rel-`);
  return text;
}

function eventId(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!EVENT_ID_RE.test(text) || text.length > 160) {
    validation(`${path} must be a stable event id`);
  }
  return text;
}

function homeId(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!HOME_ID_RE.test(text)) {
    validation(`${path} must be main or secondmate:<stable-id>`);
  }
  return text;
}

export function parseRequestContext(
  value: unknown,
  path = "request",
): PublicFollowupRequest {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "request_id",
      "platform",
      "context_binding",
      "public_safe_summary",
      "received_at",
      "followup_expires_at",
      "reservation_expires_at",
    ],
    [],
    path,
  );
  const binding = record(input.context_binding, `${path}.context_binding`);
  exactKeys(binding, ["version", "value"], [], `${path}.context_binding`);
  if (binding.version !== "ctx1") {
    validation(`${path}.context_binding.version must be ctx1`);
  }
  const bindingValue = stringValue(
    binding.value,
    `${path}.context_binding.value`,
  );
  if (!BINDING_RE.test(bindingValue)) {
    validation(`${path}.context_binding.value must start with ctx1_`);
  }
  return {
    request_id: requestId(input.request_id, `${path}.request_id`),
    platform: enumValue(
      input.platform,
      ["x", "discord"] as const,
      `${path}.platform`,
    ),
    context_binding: { version: "ctx1", value: bindingValue },
    public_safe_summary: safeText(
      input.public_safe_summary,
      `${path}.public_safe_summary`,
      240,
    ),
    received_at: validateRfc3339(input.received_at, `${path}.received_at`),
    followup_expires_at: validateRfc3339(
      input.followup_expires_at,
      `${path}.followup_expires_at`,
    ),
    reservation_expires_at: validateRfc3339(
      input.reservation_expires_at,
      `${path}.reservation_expires_at`,
    ),
  };
}

export function parseExpectedFinal(
  value: unknown,
  path = "expected_final",
): ExpectedFinal {
  const input = record(value, path);
  exactKeys(
    input,
    ["type", "project", "required_deliverables", "completion_policy"],
    [],
    path,
  );
  let project: string | null = null;
  if (input.project !== null) {
    project = stringValue(input.project, `${path}.project`);
    if (!PROJECT_RE.test(project)) validation(`${path}.project is invalid`);
  }
  if (!Array.isArray(input.required_deliverables)) {
    validation(`${path}.required_deliverables must be an array`);
  }
  const required = input.required_deliverables.map((item, index) => {
    const name = stringValue(item, `${path}.required_deliverables[${index}]`);
    if (!DELIVERABLE_NAME_RE.test(name)) {
      validation(`${path}.required_deliverables[${index}] is invalid`);
    }
    return name;
  });
  if (new Set(required).size !== required.length) {
    validation(`${path}.required_deliverables must not contain duplicates`);
  }
  const type = enumValue(input.type, EXPECTED_FINAL_TYPES, `${path}.type`);
  const allowedDeliverables = EXPECTED_DELIVERABLES[type];
  const unsupported = required.find(
    (deliverable) => !allowedDeliverables.includes(deliverable),
  );
  if (unsupported) {
    validation(`${path}.${unsupported} is not valid for expected type ${type}`);
  }
  return {
    type,
    project,
    required_deliverables: required,
    completion_policy: enumValue(
      input.completion_policy,
      COMPLETION_POLICIES,
      `${path}.completion_policy`,
    ),
  };
}

function parseWorkRef(value: unknown, path: string): WorkRef {
  const input = record(value, path);
  exactKeys(input, ["home_id", "task_id"], [], path);
  return {
    home_id: homeId(input.home_id, `${path}.home_id`),
    task_id: taskId(input.task_id, `${path}.task_id`),
  };
}

export function parseWorkRelationInput(
  value: unknown,
  path = "relation",
): WorkRelationInput {
  const input = record(value, path);
  exactKeys(
    input,
    ["relation_id", "work_ref", "role", "required", "generation"],
    [],
    path,
  );
  return {
    relation_id: relationId(input.relation_id, `${path}.relation_id`),
    work_ref: parseWorkRef(input.work_ref, `${path}.work_ref`),
    role: enumValue(input.role, WORK_ROLES, `${path}.role`),
    required: boolValue(input.required, `${path}.required`),
    generation: integer(input.generation, `${path}.generation`, 1),
  };
}

function parseDeliverables(
  value: unknown,
  path: string,
): Record<string, string> {
  const input = record(value, path);
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!DELIVERABLE_NAME_RE.test(key)) {
      validation(`${path}.${key} has an invalid deliverable name`);
    }
    output[key] = safeText(raw, `${path}.${key}`, 500);
  }
  return output;
}

function parseAcceptedWorkEvent(
  value: unknown,
  path: string,
): AcceptedWorkEvent {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "schema_version",
      "event_id",
      "obligation_id",
      "relation_id",
      "generation",
      "source_home_id",
      "work_id",
      "outcome_type",
      "deliverables",
      "public_safe_outcome",
      "occurred_at",
    ],
    [],
    path,
  );
  if (input.schema_version !== 1)
    validation(`${path}.schema_version must be 1`);
  return {
    schema_version: 1,
    event_id: eventId(input.event_id, `${path}.event_id`),
    obligation_id: taskId(input.obligation_id, `${path}.obligation_id`),
    relation_id: relationId(input.relation_id, `${path}.relation_id`),
    generation: integer(input.generation, `${path}.generation`, 1),
    source_home_id: homeId(input.source_home_id, `${path}.source_home_id`),
    work_id: taskId(input.work_id, `${path}.work_id`),
    outcome_type: enumValue(
      input.outcome_type,
      WORK_OUTCOME_TYPES,
      `${path}.outcome_type`,
    ),
    deliverables: parseDeliverables(input.deliverables, `${path}.deliverables`),
    public_safe_outcome: safeText(
      input.public_safe_outcome,
      `${path}.public_safe_outcome`,
      240,
    ),
    occurred_at: validateRfc3339(input.occurred_at, `${path}.occurred_at`),
  };
}

export function parseWorkEvent(value: unknown, path = "event"): WorkEvent {
  const input = record(value, path);
  const accepted = parseAcceptedWorkEvent(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "successor"),
    ),
    path,
  );
  if (!("successor" in input)) validation(`${path}.successor is required`);
  return {
    ...accepted,
    successor:
      input.successor === null
        ? null
        : parseWorkRelationInput(input.successor, `${path}.successor`),
  };
}

export function parsePostedReceipt(
  value: unknown,
  path = "receipt",
): PostedReceipt {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "state",
      "request_id",
      "platform",
      "attempt_count",
      "total_chunks",
      "posted_chunks",
      "posted_at",
    ],
    ["schema_version", "retain_until"],
    path,
  );
  if (input.schema_version !== undefined && input.schema_version !== 1) {
    validation(`${path}.schema_version must be 1`);
  }
  if (input.state !== "posted") validation(`${path}.state must be posted`);
  const total = integer(input.total_chunks, `${path}.total_chunks`, 1);
  const posted = integer(input.posted_chunks, `${path}.posted_chunks`, 1);
  if (posted !== total) {
    validation(`${path}.posted_chunks must equal total_chunks for posted`);
  }
  return {
    schema_version: 1,
    state: "posted",
    request_id: requestId(input.request_id, `${path}.request_id`),
    platform: enumValue(
      input.platform,
      ["x", "discord"] as const,
      `${path}.platform`,
    ),
    attempt_count: integer(input.attempt_count, `${path}.attempt_count`, 1),
    total_chunks: total,
    posted_chunks: posted,
    posted_at: validateRfc3339(input.posted_at, `${path}.posted_at`),
    retain_until:
      input.retain_until === undefined || input.retain_until === null
        ? null
        : validateRfc3339(input.retain_until, `${path}.retain_until`),
  };
}

export function parseDeliveryError(
  value: unknown,
  path = "error",
): DeliveryError {
  const input = record(value, path);
  exactKeys(
    input,
    ["state", "error_code", "occurred_at"],
    ["schema_version", "next_attempt_at", "total_chunks", "posted_chunks"],
    path,
  );
  if (input.schema_version !== undefined && input.schema_version !== 1) {
    validation(`${path}.schema_version must be 1`);
  }
  const errorCode = stringValue(input.error_code, `${path}.error_code`);
  if (!SAFE_CODE_RE.test(errorCode)) {
    validation(`${path}.error_code must be a safe error enum`);
  }
  const state = enumValue(input.state, DELIVERY_ERROR_STATES, `${path}.state`);
  const total =
    input.total_chunks === undefined || input.total_chunks === null
      ? null
      : integer(input.total_chunks, `${path}.total_chunks`);
  const posted =
    input.posted_chunks === undefined || input.posted_chunks === null
      ? null
      : integer(input.posted_chunks, `${path}.posted_chunks`);
  if ((total === null) !== (posted === null)) {
    validation(`${path} chunk counts must both be present or both be null`);
  }
  if (state === "partial") {
    if (
      total === null ||
      posted === null ||
      total < 2 ||
      posted < 1 ||
      posted >= total
    ) {
      validation(
        `${path} partial state requires 0 < posted_chunks < total_chunks`,
      );
    }
  }
  return {
    schema_version: 1,
    state,
    error_code: errorCode,
    occurred_at: validateRfc3339(input.occurred_at, `${path}.occurred_at`),
    next_attempt_at:
      input.next_attempt_at === undefined || input.next_attempt_at === null
        ? null
        : validateRfc3339(input.next_attempt_at, `${path}.next_attempt_at`),
    total_chunks: total,
    posted_chunks: posted,
  };
}

function parseWaiver(value: unknown, path: string): PublicFollowupWaiver {
  const input = record(value, path);
  exactKeys(input, ["approved_by", "reason", "waived_at"], [], path);
  if (input.approved_by !== "captain") {
    validation(`${path}.approved_by must be captain`);
  }
  return {
    approved_by: "captain",
    reason: safeText(input.reason, `${path}.reason`, 240),
    waived_at: validateRfc3339(input.waived_at, `${path}.waived_at`),
  };
}

function parseDelivery(value: unknown, path: string): PublicFollowupDelivery {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "state",
      "delivery_key",
      "payload_digest",
      "attempt_count",
      "last_error_code",
      "next_attempt_at",
      "receipt",
      "last_error",
      "waiver",
    ],
    [],
    path,
  );
  const key = stringValue(input.delivery_key, `${path}.delivery_key`);
  if (!DELIVERY_KEY_RE.test(key)) {
    validation(`${path}.delivery_key must start with fd1_`);
  }
  const digest = nullableString(input.payload_digest, `${path}.payload_digest`);
  if (digest !== null && !SHA256_RE.test(digest)) {
    validation(`${path}.payload_digest must be a lowercase SHA-256 hex digest`);
  }
  const lastErrorCode = nullableString(
    input.last_error_code,
    `${path}.last_error_code`,
  );
  if (lastErrorCode !== null && !SAFE_CODE_RE.test(lastErrorCode)) {
    validation(`${path}.last_error_code must be a safe error enum`);
  }
  return {
    state: enumValue(input.state, DELIVERY_STATES, `${path}.state`),
    delivery_key: key,
    payload_digest: digest,
    attempt_count: integer(input.attempt_count, `${path}.attempt_count`),
    last_error_code: lastErrorCode,
    next_attempt_at:
      input.next_attempt_at === null
        ? null
        : validateRfc3339(input.next_attempt_at, `${path}.next_attempt_at`),
    receipt:
      input.receipt === null
        ? null
        : parsePostedReceipt(input.receipt, `${path}.receipt`),
    last_error:
      input.last_error === null
        ? null
        : parseDeliveryError(input.last_error, `${path}.last_error`),
    waiver:
      input.waiver === null
        ? null
        : parseWaiver(input.waiver, `${path}.waiver`),
  };
}

function parseWorkRelation(value: unknown, path: string): WorkRelation {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "relation_id",
      "work_ref",
      "role",
      "required",
      "generation",
      "state",
      "successor_relation_id",
      "accepted_event_ids",
      "accepted_events",
    ],
    [],
    path,
  );
  const relation = parseWorkRelationInput(
    {
      relation_id: input.relation_id,
      work_ref: input.work_ref,
      role: input.role,
      required: input.required,
      generation: input.generation,
    },
    path,
  );
  if (!Array.isArray(input.accepted_event_ids)) {
    validation(`${path}.accepted_event_ids must be an array`);
  }
  const acceptedIds = input.accepted_event_ids.map((id, index) =>
    eventId(id, `${path}.accepted_event_ids[${index}]`),
  );
  if (new Set(acceptedIds).size !== acceptedIds.length) {
    validation(`${path}.accepted_event_ids must not contain duplicates`);
  }
  if (!Array.isArray(input.accepted_events)) {
    validation(`${path}.accepted_events must be an array`);
  }
  const events = input.accepted_events.map((event, index) =>
    parseAcceptedWorkEvent(event, `${path}.accepted_events[${index}]`),
  );
  if (events.length !== acceptedIds.length) {
    validation(`${path}.accepted_events must match accepted_event_ids`);
  }
  events.forEach((event, index) => {
    if (event.event_id !== acceptedIds[index]) {
      validation(`${path}.accepted_events must match accepted_event_ids order`);
    }
    if (
      event.relation_id !== relation.relation_id ||
      event.generation !== relation.generation ||
      event.source_home_id !== relation.work_ref.home_id ||
      event.work_id !== relation.work_ref.task_id
    ) {
      validation(
        `${path}.accepted_events contains mismatched relation evidence`,
      );
    }
  });
  return {
    ...relation,
    state: enumValue(input.state, WORK_RELATION_STATES, `${path}.state`),
    successor_relation_id:
      input.successor_relation_id === null
        ? null
        : relationId(
            input.successor_relation_id,
            `${path}.successor_relation_id`,
          ),
    accepted_event_ids: acceptedIds,
    accepted_events: events,
  };
}

export function normalizePublicFollowup(
  value: unknown,
  path = "public_followup",
): PublicFollowup {
  const input = record(value, path);
  exactKeys(
    input,
    [
      "schema_version",
      "revision",
      "request",
      "purpose",
      "expected_final",
      "obligation_expires_at",
      "delivery",
      "work_relations",
      "lineage",
    ],
    [],
    path,
  );
  if (input.schema_version !== 1)
    validation(`${path}.schema_version must be 1`);
  if (!Array.isArray(input.work_relations)) {
    validation(`${path}.work_relations must be an array`);
  }
  const relations = input.work_relations.map((relation, index) =>
    parseWorkRelation(relation, `${path}.work_relations[${index}]`),
  );
  const relationIds = relations.map((relation) => relation.relation_id);
  if (new Set(relationIds).size !== relationIds.length) {
    validation(`${path}.work_relations contains duplicate relation ids`);
  }
  const acceptedEventIds = relations.flatMap(
    (relation) => relation.accepted_event_ids,
  );
  if (new Set(acceptedEventIds).size !== acceptedEventIds.length) {
    validation(`${path}.work_relations contains duplicate accepted event ids`);
  }
  const lineageInput = record(input.lineage, `${path}.lineage`);
  exactKeys(
    lineageInput,
    ["predecessor_obligation_id", "successor_obligation_id"],
    [],
    `${path}.lineage`,
  );
  const delivery = parseDelivery(input.delivery, `${path}.delivery`);
  if (delivery.state === "posted" && delivery.receipt === null) {
    validation(`${path}.delivery.posted requires a receipt`);
  }
  if (delivery.state === "waived" && delivery.waiver === null) {
    validation(`${path}.delivery.waived requires a waiver`);
  }
  if (delivery.state !== "posted" && delivery.receipt !== null) {
    validation(`${path}.delivery.receipt is only valid in posted state`);
  }
  if (delivery.state !== "waived" && delivery.waiver !== null) {
    validation(`${path}.delivery.waiver is only valid in waived state`);
  }
  const normalized: PublicFollowup = {
    schema_version: 1,
    revision: integer(input.revision, `${path}.revision`, 1),
    request: parseRequestContext(input.request, `${path}.request`),
    purpose: enumValue(
      input.purpose,
      PUBLIC_FOLLOWUP_PURPOSES,
      `${path}.purpose`,
    ),
    expected_final: parseExpectedFinal(
      input.expected_final,
      `${path}.expected_final`,
    ),
    obligation_expires_at: validateRfc3339(
      input.obligation_expires_at,
      `${path}.obligation_expires_at`,
    ),
    delivery,
    work_relations: relations,
    lineage: {
      predecessor_obligation_id:
        lineageInput.predecessor_obligation_id === null
          ? null
          : taskId(
              lineageInput.predecessor_obligation_id,
              `${path}.lineage.predecessor_obligation_id`,
            ),
      successor_obligation_id:
        lineageInput.successor_obligation_id === null
          ? null
          : taskId(
              lineageInput.successor_obligation_id,
              `${path}.lineage.successor_obligation_id`,
            ),
    },
  };
  const normalizedDelivery = normalized.delivery;
  if (
    (normalizedDelivery.payload_digest === null) !==
    (normalizedDelivery.attempt_count === 0)
  ) {
    validation(`${path}.delivery digest and attempt_count are inconsistent`);
  }
  if (
    (DELIVERY_ERROR_STATES as readonly string[]).includes(
      normalizedDelivery.state,
    ) &&
    normalizedDelivery.last_error === null
  ) {
    validation(`${path}.delivery error state requires last_error`);
  }
  if (normalizedDelivery.last_error === null) {
    if (
      normalizedDelivery.last_error_code !== null ||
      normalizedDelivery.next_attempt_at !== null
    ) {
      validation(`${path}.delivery error fields require last_error`);
    }
  } else if (
    normalizedDelivery.state !== normalizedDelivery.last_error.state ||
    normalizedDelivery.last_error_code !==
      normalizedDelivery.last_error.error_code ||
    normalizedDelivery.next_attempt_at !==
      normalizedDelivery.last_error.next_attempt_at
  ) {
    validation(`${path}.delivery error fields are inconsistent`);
  }
  if (
    normalizedDelivery.receipt !== null &&
    (normalizedDelivery.receipt.request_id !== normalized.request.request_id ||
      normalizedDelivery.receipt.platform !== normalized.request.platform ||
      normalizedDelivery.receipt.attempt_count !==
        normalizedDelivery.attempt_count)
  ) {
    validation(`${path}.delivery receipt does not match the obligation`);
  }
  for (const relation of normalized.work_relations) {
    for (const event of relation.accepted_events) {
      if (event.outcome_type === "superseded") {
        if (Object.keys(event.deliverables).length > 0) {
          validation(`${path} superseded event cannot carry deliverables`);
        }
      } else if (
        event.outcome_type === "failed" &&
        normalized.expected_final.type !== "failure-outcome"
      ) {
        if (!failureDeliverablesAreSafe(event.deliverables)) {
          validation(`${path} failed event has unsafe deliverables`);
        }
      } else if (!eventMatchesExpected(event, normalized.expected_final)) {
        validation(`${path} accepted event violates expected-final contract`);
      }
    }
    const last = relation.accepted_events.at(-1);
    if (relation.state === "bound" && last !== undefined) {
      validation(`${path} bound relation cannot contain terminal events`);
    }
    if (
      relation.state === "landed" &&
      (last === undefined ||
        ["failed", "superseded"].includes(last.outcome_type))
    ) {
      validation(`${path} landed relation requires a landed event`);
    }
    if (
      relation.state === "failed" &&
      (last === undefined || last.outcome_type !== "failed")
    ) {
      validation(`${path} failed relation requires a failed event`);
    }
    if (
      relation.state === "superseded" &&
      relation.successor_relation_id === null
    ) {
      validation(`${path} superseded relation requires successor_relation_id`);
    }
    if (
      relation.state !== "superseded" &&
      relation.successor_relation_id !== null
    ) {
      validation(`${path} only a superseded relation may name a successor`);
    }
    if (relation.successor_relation_id !== null) {
      const successor = normalized.work_relations.find(
        (candidate) => candidate.relation_id === relation.successor_relation_id,
      );
      if (!successor || successor.generation !== relation.generation + 1) {
        validation(`${path} relation successor lineage is stale or missing`);
      }
    }
  }
  const successorReferences = normalized.work_relations.flatMap((relation) =>
    relation.successor_relation_id ? [relation.successor_relation_id] : [],
  );
  const successorIds = new Set(successorReferences);
  if (successorIds.size !== successorReferences.length) {
    validation(`${path} relation successor lineage cannot merge`);
  }
  if (
    normalized.work_relations.some(
      (relation) =>
        relation.generation > 1 && !successorIds.has(relation.relation_id),
    )
  ) {
    validation(`${path} relation generation is missing predecessor lineage`);
  }
  const derivedReady = isPublicFollowupReady(normalized);
  if (normalized.delivery.state === "ready" && !derivedReady) {
    validation(`${path}.delivery.state is stale: work is not ready`);
  }
  if (normalized.delivery.state === "pending-work" && derivedReady) {
    validation(`${path}.delivery.state is stale: work is ready`);
  }
  if (
    normalized.delivery.state === "intent" &&
    normalized.work_relations.length > 0
  ) {
    validation(`${path}.delivery.state is stale: bound work is pending`);
  }
  return normalized;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortCanonical(item)]),
    );
  }
  return value;
}

export function canonicalPublicFollowupJson(value: PublicFollowup): string {
  return JSON.stringify(sortCanonical(normalizePublicFollowup(value)));
}

export function encodePublicFollowup(value: PublicFollowup): string {
  return Buffer.from(canonicalPublicFollowupJson(value), "utf8").toString(
    "base64url",
  );
}

export function decodePublicFollowup(encoded: string): PublicFollowup {
  if (encoded.length > 1_000_000) {
    validation("public_followup metadata is too large");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    validation("public_followup metadata is not base64url");
  }
  let text: string;
  try {
    text = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return validation("public_followup metadata is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return validation("public_followup metadata does not contain valid JSON");
  }
  return normalizePublicFollowup(parsed);
}

export function clonePublicFollowup(value: PublicFollowup): PublicFollowup {
  return normalizePublicFollowup(
    JSON.parse(canonicalPublicFollowupJson(value)),
  );
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(sortCanonical(left)) === JSON.stringify(sortCanonical(right))
  );
}

function immutableRelation(relation: WorkRelation): Record<string, unknown> {
  return {
    relation_id: relation.relation_id,
    work_ref: relation.work_ref,
    role: relation.role,
    required: relation.required,
    generation: relation.generation,
  };
}

/** Enforce immutable promise identity and append-only relation evidence in the store. */
export function assertPublicFollowupMutation(
  previous: PublicFollowup,
  next: PublicFollowup,
): void {
  for (const [label, left, right] of [
    ["request", previous.request, next.request],
    ["purpose", previous.purpose, next.purpose],
    ["expected_final", previous.expected_final, next.expected_final],
    [
      "obligation_expires_at",
      previous.obligation_expires_at,
      next.obligation_expires_at,
    ],
    [
      "delivery_key",
      previous.delivery.delivery_key,
      next.delivery.delivery_key,
    ],
  ] as Array<[string, unknown, unknown]>) {
    if (!canonicalEqual(left, right)) {
      validation(`public_followup immutable ${label} cannot change`);
    }
  }
  if (next.revision !== previous.revision + 1) {
    validation("public_followup revision must increase by exactly one");
  }
  if (
    !DELIVERY_TRANSITIONS[previous.delivery.state].includes(next.delivery.state)
  ) {
    validation(
      `public_followup delivery cannot move from ${previous.delivery.state} to ${next.delivery.state}`,
    );
  }
  if (next.delivery.attempt_count < previous.delivery.attempt_count) {
    validation("public_followup delivery attempt_count cannot decrease");
  }
  if (
    previous.delivery.payload_digest !== null &&
    next.delivery.payload_digest !== previous.delivery.payload_digest
  ) {
    validation("public_followup delivery payload_digest cannot change");
  }
  for (const previousRelation of previous.work_relations) {
    const nextRelation = next.work_relations.find(
      (relation) => relation.relation_id === previousRelation.relation_id,
    );
    if (!nextRelation) {
      validation(
        `public_followup relation ${previousRelation.relation_id} cannot be removed`,
      );
    }
    if (
      !canonicalEqual(
        immutableRelation(previousRelation),
        immutableRelation(nextRelation),
      )
    ) {
      validation(
        `public_followup relation ${previousRelation.relation_id} identity cannot change`,
      );
    }
    const oldIds = previousRelation.accepted_event_ids;
    if (
      !oldIds.every(
        (event, index) => nextRelation.accepted_event_ids[index] === event,
      )
    ) {
      validation(
        `public_followup relation ${previousRelation.relation_id} events are append-only`,
      );
    }
    if (
      !previousRelation.accepted_events.every((event, index) =>
        canonicalEqual(event, nextRelation.accepted_events[index]),
      )
    ) {
      validation(
        `public_followup relation ${previousRelation.relation_id} event data cannot change`,
      );
    }
    if (
      previousRelation.state === "landed" &&
      (nextRelation.state !== "landed" ||
        nextRelation.accepted_event_ids.length !== oldIds.length)
    ) {
      validation(
        `public_followup landed relation ${previousRelation.relation_id} is immutable`,
      );
    }
    if (
      previousRelation.state === "superseded" &&
      (nextRelation.state !== "superseded" ||
        nextRelation.accepted_event_ids.length !== oldIds.length)
    ) {
      validation(
        `public_followup superseded relation ${previousRelation.relation_id} is immutable`,
      );
    }
    if (
      previousRelation.state === "failed" &&
      !["failed", "superseded"].includes(nextRelation.state)
    ) {
      validation(
        `public_followup failed relation ${previousRelation.relation_id} cannot regress`,
      );
    }
    if (
      previousRelation.successor_relation_id !== null &&
      nextRelation.successor_relation_id !==
        previousRelation.successor_relation_id
    ) {
      validation(
        `public_followup relation ${previousRelation.relation_id} successor cannot change`,
      );
    }
  }
  for (const key of [
    "predecessor_obligation_id",
    "successor_obligation_id",
  ] as const) {
    const oldValue = previous.lineage[key];
    if (oldValue !== null && next.lineage[key] !== oldValue) {
      validation(`public_followup lineage ${key} cannot change`);
    }
  }
}

export function isPublicFollowupTerminal(value: PublicFollowup): boolean {
  return value.delivery.state === "posted" || value.delivery.state === "waived";
}

export function assertPublicFollowupTaskState(
  state: "queued" | "in_flight" | "done",
  value: PublicFollowup,
  id?: string,
): void {
  const terminal = isPublicFollowupTerminal(value);
  if (state === "in_flight") {
    validation("public-followup tasks cannot be in flight");
  }
  if (state === "done" && !terminal) {
    validation("active public-followup task cannot be Done");
  }
  if (state !== "done" && terminal) {
    validation("posted or waived public-followup task must be Done");
  }
  if (id !== undefined) {
    if (
      value.work_relations.some((relation) =>
        relation.accepted_events.some((event) => event.obligation_id !== id),
      )
    ) {
      validation("public-followup accepted event names another obligation");
    }
    if (
      value.lineage.predecessor_obligation_id === id ||
      value.lineage.successor_obligation_id === id
    ) {
      validation("public-followup obligation cannot be its own successor");
    }
  }
}

export function isPublicFollowupTask(task: {
  kind?: string;
  public_followup?: PublicFollowup;
}): boolean {
  return task.kind === PUBLIC_FOLLOWUP_KIND;
}

function deliverablesAreSafeForExpected(
  deliverables: Record<string, string>,
  expected: ExpectedFinal,
): boolean {
  const allowed = EXPECTED_DELIVERABLES[expected.type];
  if (Object.keys(deliverables).some((name) => !allowed.includes(name))) {
    return false;
  }
  for (const [name, value] of Object.entries(deliverables)) {
    if (name === "pr_url") {
      if (!PR_URL_RE.test(value)) return false;
      try {
        const url = new URL(value);
        if (url.username !== "" || url.password !== "") return false;
      } catch {
        return false;
      }
    }
    if (name === "report_path" && !REPORT_PATH_RE.test(value)) return false;
    if (name === "commit_sha" && !COMMIT_SHA_RE.test(value)) return false;
    if (name === "error_code" && !SAFE_CODE_RE.test(value)) return false;
  }
  return true;
}

function failureDeliverablesAreSafe(
  deliverables: Record<string, string>,
): boolean {
  const entries = Object.entries(deliverables);
  return (
    entries.length <= 1 &&
    entries.every(
      ([name, value]) => name === "error_code" && SAFE_CODE_RE.test(value),
    )
  );
}

function eventMatchesExpected(
  event: AcceptedWorkEvent,
  expected: ExpectedFinal,
): boolean {
  const expectedOutcome: WorkOutcomeType =
    expected.type === "failure-outcome"
      ? "failed"
      : expected.type === "explicit-answer"
        ? "local-main"
        : expected.type;
  if (event.outcome_type !== expectedOutcome) return false;
  if (!deliverablesAreSafeForExpected(event.deliverables, expected)) {
    return false;
  }
  return expected.required_deliverables.every(
    (name) => typeof event.deliverables[name] === "string",
  );
}

export function validateWorkEventContract(
  event: WorkEvent,
  expected: ExpectedFinal,
): void {
  if (event.outcome_type === "superseded") {
    if (event.successor === null) {
      validation("superseded work event requires successor");
    }
    if (Object.keys(event.deliverables).length > 0) {
      validation("superseded work event cannot carry deliverables");
    }
    return;
  }
  if (event.successor !== null) {
    validation("only a superseded work event may carry successor");
  }
  if (event.outcome_type === "failed" && expected.type !== "failure-outcome") {
    if (!failureDeliverablesAreSafe(event.deliverables)) {
      validation("failed work event has unsafe deliverables");
    }
    return;
  }
  if (!eventMatchesExpected(event, expected)) {
    validation("work event does not satisfy expected outcome and deliverables");
  }
}

function relationLanded(
  relation: WorkRelation,
  expected: ExpectedFinal,
): boolean {
  const event = relation.accepted_events.at(-1);
  const terminalState =
    relation.state === "landed" ||
    (relation.state === "failed" && expected.type === "failure-outcome");
  return (
    terminalState &&
    event !== undefined &&
    eventMatchesExpected(event, expected)
  );
}

/** Derived public-delivery readiness, intentionally separate from worker dispatch readiness. */
export function isPublicFollowupReady(value: PublicFollowup): boolean {
  const active = value.work_relations.filter(
    (relation) => relation.state !== "superseded",
  );
  if (active.length === 0) return false;
  const fulfilling = active.filter((relation) => relation.role === "fulfills");
  if (fulfilling.length === 0) return false;
  if (value.expected_final.completion_policy === "any-required") {
    const required = active.filter((relation) => relation.required);
    if (
      required.some(
        (relation) => !relationLanded(relation, value.expected_final),
      )
    ) {
      return false;
    }
    return fulfilling.some((relation) =>
      relationLanded(relation, value.expected_final),
    );
  }
  const required = active.filter((relation) => relation.required);
  if (
    required.some((relation) => !relationLanded(relation, value.expected_final))
  ) {
    return false;
  }
  return fulfilling.some((relation) =>
    relationLanded(relation, value.expected_final),
  );
}

export function parsePayloadHash(value: string): string {
  if (!SHA256_RE.test(value)) {
    validation("--payload-hash must be a lowercase SHA-256 hex digest");
  }
  return value;
}
