import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  requireId,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderMutation, taskToJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import {
  blockedIds,
  publicFollowupsByDeliveryState,
  readyPublicFollowups,
} from "../derive.js";
import { AxiError, notFound } from "../errors.js";
import { formatCountLine } from "../format.js";
import type { Task } from "../model.js";
import {
  DELIVERY_STATES,
  PUBLIC_FOLLOWUP_KIND,
  PUBLIC_FOLLOWUP_PURPOSES,
  canonicalEqual,
  clonePublicFollowup,
  isPublicFollowupReady,
  parseDeliveryError,
  parseExpectedFinal,
  parsePayloadHash,
  parsePostedReceipt,
  parseRequestContext,
  parseWorkEvent,
  parseWorkRelationInput,
  validateRfc3339,
  validateWorkEventContract,
  type AcceptedWorkEvent,
  type PublicFollowup,
  type PublicFollowupDeliveryState,
  type WorkEvent,
  type WorkRelation,
  type WorkRelationInput,
} from "../public-followup.js";
import type { Store } from "../store.js";
import { withSuggestionGlobals } from "../suggestions.js";
import { field, renderDetail, renderHelp, renderOutput } from "../toon.js";
import { renderTaskList } from "../view.js";

export const PUBLIC_FOLLOWUP_HELP = `usage: tasks-axi public-followup <command> [args] [flags]
commands:
  add <id> --request-context-file <file> --purpose <type> --expected-final-file <file> --expires-at <rfc3339>
  bind-work <id> --relation-file <file>
  supersede-work <id> --relation <relation-id> --successor-file <file>
  work-event <id> --event-file <file>
  list [--delivery-state <state>] [--work-ref <home/task>]
  ready
  begin-delivery <id> --payload-hash <sha256>
  record-delivery <id> --receipt-file <file>
  record-error <id> --error-file <file>
  waive <id> --reason <text> --approved-by captain
flags:
  --json   machine-readable result with the complete typed obligation payload
file contracts:
  request context: request_id, platform, ctx1 binding, public_safe_summary, and RFC3339 expiries
  expected final: type, project, required_deliverables, completion_policy
  relation/successor: relation_id, work_ref, role, required, generation
  event: schema_version=1, stable ids/source/generation, typed outcome, safe deliverables, successor (null unless superseded)
  receipt: posted request/platform, attempt and chunk counts, posted_at, optional retain_until
  error: safe state/error_code, occurred_at, optional retry time and chunk counts
examples:
  tasks-axi public-followup add public-final-ab --request-context-file request.json --purpose promised-final --expected-final-file expected.json --expires-at 2026-10-01T00:00:00Z --json
  tasks-axi public-followup bind-work public-final-ab --relation-file relation.json --json
  tasks-axi public-followup work-event public-final-ab --event-file event.json --json
  tasks-axi public-followup ready --json
  tasks-axi public-followup record-delivery public-final-ab --receipt-file receipt.json --json`;

const SUBCOMMAND_HELP: Record<string, string> = {
  add: "usage: tasks-axi public-followup add <id> --request-context-file <file> --purpose <promised-final|correction|investigation-result|milestone> --expected-final-file <file> --expires-at <rfc3339> [--json]",
  "bind-work":
    "usage: tasks-axi public-followup bind-work <id> --relation-file <file> [--json]",
  "supersede-work":
    "usage: tasks-axi public-followup supersede-work <id> --relation <relation-id> --successor-file <file> [--json]",
  "work-event":
    "usage: tasks-axi public-followup work-event <id> --event-file <file> [--json]",
  list: "usage: tasks-axi public-followup list [--delivery-state <state>] [--work-ref <home/task>] [--json]",
  ready: "usage: tasks-axi public-followup ready [--json]",
  "begin-delivery":
    "usage: tasks-axi public-followup begin-delivery <id> --payload-hash <sha256> [--json]",
  "record-delivery":
    "usage: tasks-axi public-followup record-delivery <id> --receipt-file <file> [--json]",
  "record-error":
    "usage: tasks-axi public-followup record-error <id> --error-file <file> [--json]",
  waive:
    "usage: tasks-axi public-followup waive <id> --reason <text> --approved-by captain [--json]",
};

export function publicFollowupSubcommandHelp(
  command: string | undefined,
): string | undefined {
  return command === undefined ? undefined : SUBCOMMAND_HELP[command];
}

export async function publicFollowupCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const [command, ...args] = rawArgs;
  switch (command) {
    case "add":
      return publicFollowupAdd(args, context);
    case "bind-work":
      return bindWork(args, context);
    case "supersede-work":
      return supersedeWork(args, context);
    case "work-event":
      return workEvent(args, context);
    case "list":
      return publicFollowupList(args, context);
    case "ready":
      return publicFollowupReady(args, context);
    case "begin-delivery":
      return beginDelivery(args, context);
    case "record-delivery":
      return recordDelivery(args, context);
    case "record-error":
      return recordError(args, context);
    case "waive":
      return waive(args, context);
    default:
      throw new AxiError(
        command
          ? `Unknown public-followup command: ${command}`
          : "Missing public-followup command",
        "VALIDATION_ERROR",
        [PUBLIC_FOLLOWUP_HELP.split("\n")[0]],
      );
  }
}

function readJsonFile(args: string[], flag: string): unknown {
  const path = requireNonEmptySingleLineFlagValue(flag, takeFlag(args, flag));
  if (path === undefined) {
    throw new AxiError(`${flag} <file> is required`, "VALIDATION_ERROR", [
      `Pass ${flag}=<file>`,
    ]);
  }
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new AxiError(
      `Could not read ${flag} path: ${path}`,
      "VALIDATION_ERROR",
    );
  }
  if (Buffer.byteLength(source, "utf8") > 1_000_000) {
    throw new AxiError(`${flag} is too large`, "VALIDATION_ERROR");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new AxiError(`${flag} must contain valid JSON`, "VALIDATION_ERROR");
  }
}

function requireFlag(
  args: string[],
  flag: string,
  suggestion?: string,
): string {
  const value = requireNonEmptySingleLineFlagValue(flag, takeFlag(args, flag));
  if (value === undefined) {
    throw new AxiError(`${flag} <value> is required`, "VALIDATION_ERROR", [
      suggestion ?? `Pass ${flag}=<value>`,
    ]);
  }
  return value;
}

function requirePurpose(raw: string): PublicFollowup["purpose"] {
  if (!(PUBLIC_FOLLOWUP_PURPOSES as readonly string[]).includes(raw)) {
    throw new AxiError(
      `--purpose must be one of ${PUBLIC_FOLLOWUP_PURPOSES.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  return raw as PublicFollowup["purpose"];
}

function deliveryKey(): string {
  return `fd1_${randomBytes(24).toString("base64url")}`;
}

async function publicFollowupAdd(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const request = parseRequestContext(
    readJsonFile(args, "--request-context-file"),
  );
  const expectedFinal = parseExpectedFinal(
    readJsonFile(args, "--expected-final-file"),
  );
  const purpose = requirePurpose(requireFlag(args, "--purpose"));
  const expiresAt = validateRfc3339(
    requireFlag(args, "--expires-at"),
    "--expires-at",
  );
  const positionals = requirePositionals(args, 1, 1, SUBCOMMAND_HELP.add);
  const id = requireId(positionals[0], "id");

  const existing = await store.get(id);
  if (existing) {
    if (existing.kind !== PUBLIC_FOLLOWUP_KIND || !existing.public_followup) {
      throw new AxiError(`Task "${id}" already exists`, "CONFLICT");
    }
    const current = existing.public_followup;
    if (
      !canonicalEqual(current.request, request) ||
      !canonicalEqual(current.expected_final, expectedFinal) ||
      current.purpose !== purpose ||
      current.obligation_expires_at !== expiresAt
    ) {
      throw new AxiError(
        `Public-followup "${id}" already exists with different immutable data`,
        "CONFLICT",
      );
    }
    return publicMutationOutput({
      json,
      action: "add",
      task: existing,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      context,
    });
  }

  const publicFollowup: PublicFollowup = {
    schema_version: 1,
    revision: 1,
    request,
    purpose,
    expected_final: expectedFinal,
    obligation_expires_at: expiresAt,
    delivery: {
      state: "intent",
      delivery_key: deliveryKey(),
      payload_digest: null,
      attempt_count: 0,
      last_error_code: null,
      next_attempt_at: null,
      receipt: null,
      last_error: null,
      waiver: null,
    },
    work_relations: [],
    lineage: {
      predecessor_obligation_id: null,
      successor_obligation_id: null,
    },
  };
  const task = await store.create({
    id,
    title: request.public_safe_summary,
    state: "queued",
    kind: PUBLIC_FOLLOWUP_KIND,
    public_followup: publicFollowup,
  });
  return publicMutationOutput({
    json,
    action: "add",
    task,
    all: (await store.list({})).items,
    changed: ["task", "public_followup"],
    context,
  });
}

async function requireObligation(
  store: Store,
  id: string,
  context?: TasksContext,
): Promise<Task & { public_followup: PublicFollowup }> {
  const task = await store.get(id);
  if (!task) throw notFound(id, { globals: context?.suggestionGlobals });
  if (task.kind !== PUBLIC_FOLLOWUP_KIND || !task.public_followup) {
    throw new AxiError(
      `Task "${id}" is not a public-followup obligation`,
      "VALIDATION_ERROR",
    );
  }
  return task as Task & { public_followup: PublicFollowup };
}

function relationIdentity(input: WorkRelationInput): Record<string, unknown> {
  return {
    relation_id: input.relation_id,
    work_ref: input.work_ref,
    role: input.role,
    required: input.required,
    generation: input.generation,
  };
}

function newRelation(input: WorkRelationInput): WorkRelation {
  return {
    ...input,
    work_ref: { ...input.work_ref },
    state: "bound",
    successor_relation_id: null,
    accepted_event_ids: [],
    accepted_events: [],
  };
}

function ensureWorkMutable(value: PublicFollowup): void {
  if (!["intent", "pending-work", "ready"].includes(value.delivery.state)) {
    throw new AxiError(
      `Work relations cannot change in delivery state ${value.delivery.state}`,
      "VALIDATION_ERROR",
    );
  }
}

function refreshWorkState(value: PublicFollowup): void {
  value.delivery.state = isPublicFollowupReady(value)
    ? "ready"
    : value.work_relations.length === 0
      ? "intent"
      : "pending-work";
  value.delivery.last_error_code = null;
  value.delivery.next_attempt_at = null;
  value.delivery.last_error = null;
}

function nextPayload(
  task: Task & { public_followup: PublicFollowup },
): PublicFollowup {
  const value = clonePublicFollowup(task.public_followup);
  value.revision += 1;
  return value;
}

async function persistPublicFollowup(
  store: Store,
  task: Task & { public_followup: PublicFollowup },
  next: PublicFollowup,
  options: { complete?: boolean; requireUnblocked?: boolean } = {},
): Promise<Task> {
  return store.updatePublicFollowup(task.id, {
    expectedRevision: task.public_followup.revision,
    expectedPublicFollowup: task.public_followup,
    publicFollowup: next,
    ...(options.complete ? { complete: true } : {}),
    ...(options.requireUnblocked ? { requireUnblocked: true } : {}),
  });
}

async function bindWork(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const relation = parseWorkRelationInput(
    readJsonFile(args, "--relation-file"),
  );
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["bind-work"],
  );
  const id = requireId(positionals[0], "id");
  if (relation.generation !== 1) {
    throw new AxiError(
      "A newly bound work relation must start at generation 1",
      "VALIDATION_ERROR",
    );
  }
  const task = await requireObligation(store, id, context);
  const existing = task.public_followup.work_relations.find(
    (item) => item.relation_id === relation.relation_id,
  );
  if (existing) {
    if (
      !canonicalEqual(relationIdentity(existing), relationIdentity(relation))
    ) {
      throw new AxiError(
        `Relation "${relation.relation_id}" already exists with different identity`,
        "CONFLICT",
      );
    }
    return publicMutationOutput({
      json,
      action: "bind-work",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      context,
    });
  }

  ensureWorkMutable(task.public_followup);
  const next = nextPayload(task);
  next.work_relations.push(newRelation(relation));
  refreshWorkState(next);
  const updated = await persistPublicFollowup(store, task, next);
  return publicMutationOutput({
    json,
    action: "bind-work",
    task: updated,
    all: (await store.list({})).items,
    changed: ["work_relations", "delivery.state"],
    context,
  });
}

function applySuccessor(
  value: PublicFollowup,
  previous: WorkRelation,
  successor: WorkRelationInput,
): void {
  if (successor.relation_id === previous.relation_id) {
    throw new AxiError(
      "Successor relation id must differ from its predecessor",
      "VALIDATION_ERROR",
    );
  }
  if (successor.generation !== previous.generation + 1) {
    throw new AxiError(
      `Successor generation must be ${previous.generation + 1}`,
      "VALIDATION_ERROR",
    );
  }
  if (
    value.work_relations.some(
      (item) => item.relation_id === successor.relation_id,
    )
  ) {
    throw new AxiError(
      `Successor relation "${successor.relation_id}" already exists`,
      "CONFLICT",
    );
  }
  previous.state = "superseded";
  previous.successor_relation_id = successor.relation_id;
  value.work_relations.push(newRelation(successor));
}

async function supersedeWork(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const relationId = requireFlag(args, "--relation");
  const successor = parseWorkRelationInput(
    readJsonFile(args, "--successor-file"),
  );
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["supersede-work"],
  );
  const id = requireId(positionals[0], "id");
  const task = await requireObligation(store, id, context);
  const previous = task.public_followup.work_relations.find(
    (relation) => relation.relation_id === relationId,
  );
  if (!previous) {
    throw new AxiError(
      `Relation "${relationId}" not found`,
      "VALIDATION_ERROR",
    );
  }
  if (previous.state === "superseded") {
    const existing = task.public_followup.work_relations.find(
      (relation) => relation.relation_id === previous.successor_relation_id,
    );
    if (
      existing &&
      canonicalEqual(relationIdentity(existing), relationIdentity(successor))
    ) {
      return publicMutationOutput({
        json,
        action: "supersede-work",
        task,
        all: (await store.list({})).items,
        already: true,
        changed: [],
        context,
      });
    }
    throw new AxiError(
      `Relation "${relationId}" already has a different successor`,
      "CONFLICT",
    );
  }
  if (previous.state === "landed") {
    throw new AxiError(
      `Landed relation "${relationId}" cannot be superseded`,
      "VALIDATION_ERROR",
    );
  }

  ensureWorkMutable(task.public_followup);
  const next = nextPayload(task);
  const nextPrevious = next.work_relations.find(
    (relation) => relation.relation_id === relationId,
  );
  if (!nextPrevious) throw new AxiError("relation disappeared", "CONFLICT");
  applySuccessor(next, nextPrevious, successor);
  refreshWorkState(next);
  const updated = await persistPublicFollowup(store, task, next);
  return publicMutationOutput({
    json,
    action: "supersede-work",
    task: updated,
    all: (await store.list({})).items,
    changed: ["work_relations", "delivery.state"],
    context,
  });
}

function acceptedEvent(event: WorkEvent): AcceptedWorkEvent {
  return {
    schema_version: 1,
    event_id: event.event_id,
    obligation_id: event.obligation_id,
    relation_id: event.relation_id,
    generation: event.generation,
    source_home_id: event.source_home_id,
    work_id: event.work_id,
    outcome_type: event.outcome_type,
    deliverables: { ...event.deliverables },
    public_safe_outcome: event.public_safe_outcome,
    occurred_at: event.occurred_at,
  };
}

async function workEvent(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const event = parseWorkEvent(readJsonFile(args, "--event-file"));
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["work-event"],
  );
  const id = requireId(positionals[0], "id");
  if (event.obligation_id !== id) {
    throw new AxiError(
      "Work event obligation_id does not match the command id",
      "VALIDATION_ERROR",
    );
  }
  const task = await requireObligation(store, id, context);
  const accepted = acceptedEvent(event);
  const priorEvent = task.public_followup.work_relations
    .flatMap((relation) => relation.accepted_events)
    .find((item) => item.event_id === event.event_id);
  if (priorEvent) {
    const priorRelation = task.public_followup.work_relations.find((relation) =>
      relation.accepted_event_ids.includes(event.event_id),
    );
    const priorSuccessor = priorRelation?.successor_relation_id
      ? task.public_followup.work_relations.find(
          (relation) =>
            relation.relation_id === priorRelation.successor_relation_id,
        )
      : undefined;
    const successorMatches =
      priorEvent.outcome_type === "superseded"
        ? event.successor !== null &&
          priorSuccessor !== undefined &&
          canonicalEqual(
            relationIdentity(priorSuccessor),
            relationIdentity(event.successor),
          )
        : event.successor === null;
    if (!canonicalEqual(priorEvent, accepted) || !successorMatches) {
      throw new AxiError(
        `Event id "${event.event_id}" was already accepted with different data`,
        "CONFLICT",
      );
    }
    return publicMutationOutput({
      json,
      action: "work-event",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      context,
    });
  }

  ensureWorkMutable(task.public_followup);
  const relation = task.public_followup.work_relations.find(
    (item) => item.relation_id === event.relation_id,
  );
  if (!relation) {
    throw new AxiError(
      `Unknown work relation "${event.relation_id}"`,
      "VALIDATION_ERROR",
    );
  }
  if (
    event.generation !== relation.generation ||
    relation.state === "superseded"
  ) {
    throw new AxiError(
      `Stale work event generation for relation "${event.relation_id}"`,
      "VALIDATION_ERROR",
    );
  }
  if (
    event.source_home_id !== relation.work_ref.home_id ||
    event.work_id !== relation.work_ref.task_id
  ) {
    throw new AxiError(
      "Work event source home or task does not match the relation",
      "VALIDATION_ERROR",
    );
  }
  if (relation.state !== "bound") {
    throw new AxiError(
      `Relation "${event.relation_id}" already has a terminal work event`,
      "CONFLICT",
    );
  }
  validateWorkEventContract(event, task.public_followup.expected_final);

  const next = nextPayload(task);
  const nextRelation = next.work_relations.find(
    (item) => item.relation_id === event.relation_id,
  );
  if (!nextRelation) throw new AxiError("relation disappeared", "CONFLICT");
  nextRelation.accepted_event_ids.push(event.event_id);
  nextRelation.accepted_events.push(accepted);
  if (event.outcome_type === "superseded") {
    if (!event.successor) {
      throw new AxiError(
        "Superseded event requires successor",
        "VALIDATION_ERROR",
      );
    }
    applySuccessor(next, nextRelation, event.successor);
  } else {
    nextRelation.state = event.outcome_type === "failed" ? "failed" : "landed";
  }
  refreshWorkState(next);
  const updated = await persistPublicFollowup(store, task, next);
  return publicMutationOutput({
    json,
    action: "work-event",
    task: updated,
    all: (await store.list({})).items,
    changed: ["work_relations", "delivery.state"],
    context,
  });
}

function parseDeliveryState(
  raw: string | undefined,
): PublicFollowupDeliveryState | undefined {
  if (raw === undefined) return undefined;
  if (!(DELIVERY_STATES as readonly string[]).includes(raw)) {
    throw new AxiError(
      `--delivery-state must be one of ${DELIVERY_STATES.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  return raw as PublicFollowupDeliveryState;
}

function parseWorkRefFilter(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = requireNonEmptySingleLineFlagValue("--work-ref", raw);
  if (
    !value ||
    !/^(?:main|secondmate:[A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
      value,
    )
  ) {
    throw new AxiError(
      "--work-ref must be <home-id>/<task-id>",
      "VALIDATION_ERROR",
    );
  }
  return value;
}

function matchesWorkRef(task: Task, filter: string): boolean {
  return (
    task.public_followup?.work_relations.some(
      (relation) =>
        `${relation.work_ref.home_id}/${relation.work_ref.task_id}` === filter,
    ) ?? false
  );
}

async function publicFollowupList(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const state = parseDeliveryState(takeFlag(args, "--delivery-state"));
  const workRef = parseWorkRefFilter(takeFlag(args, "--work-ref"));
  requirePositionals(args, 0, 0, SUBCOMMAND_HELP.list);
  const all = (await store.list({})).items;
  let items = publicFollowupsByDeliveryState(all, state);
  if (workRef) items = items.filter((task) => matchesWorkRef(task, workRef));
  if (json) {
    return JSON.stringify(
      {
        ok: true,
        action: "public-followup.list",
        count: items.length,
        public_followups: items.map((task) => taskToJson(task, all)),
      },
      null,
      2,
    );
  }
  const blocks = [formatCountLine({ count: items.length })];
  blocks.push(
    items.length > 0
      ? renderTaskList("public_followups", items, all, [
          field("delivery_state"),
        ])
      : "public_followups: 0 obligations found",
  );
  return renderOutput(blocks);
}

async function publicFollowupReady(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, SUBCOMMAND_HELP.ready);
  const all = (await store.list({})).items;
  const items = readyPublicFollowups(all);
  if (json) {
    return JSON.stringify(
      {
        ok: true,
        action: "public-followup.ready",
        count: items.length,
        ready_public_followups: items.map((task) => taskToJson(task, all)),
      },
      null,
      2,
    );
  }
  const blocks = [formatCountLine({ count: items.length })];
  blocks.push(
    items.length > 0
      ? renderTaskList("ready_public_followups", items, all, [
          field("delivery_state"),
        ])
      : "ready_public_followups: 0 delivery-ready obligations",
  );
  if (items.length > 0) {
    blocks.push(
      renderHelp(
        withSuggestionGlobals(
          [
            "Run `tasks-axi public-followup begin-delivery <id> --payload-hash <sha256>` after semantic preflight",
          ],
          context?.suggestionGlobals,
        ),
      ),
    );
  }
  return renderOutput(blocks);
}

async function beginDelivery(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const hash = parsePayloadHash(requireFlag(args, "--payload-hash"));
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["begin-delivery"],
  );
  const id = requireId(positionals[0], "id");
  const task = await requireObligation(store, id, context);
  const current = task.public_followup.delivery;
  if (current.payload_digest !== null && current.payload_digest !== hash) {
    throw new AxiError(
      "Delivery payload hash conflicts with the recorded digest",
      "CONFLICT",
    );
  }
  if (current.state === "delivery-posting" && current.payload_digest === hash) {
    return publicMutationOutput({
      json,
      action: "begin-delivery",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      context,
    });
  }
  const all = (await store.list({})).items;
  if (blockedIds(all).has(id)) {
    throw new AxiError(
      "Cannot begin delivery while the obligation has an active blocker",
      "VALIDATION_ERROR",
    );
  }
  if (
    ![
      "ready",
      "preflight-matched",
      "delivery-registered",
      "retry-due",
    ].includes(current.state)
  ) {
    throw new AxiError(
      `Cannot begin delivery from state ${current.state}`,
      "VALIDATION_ERROR",
    );
  }
  const next = nextPayload(task);
  next.delivery.payload_digest = hash;
  next.delivery.attempt_count += 1;
  next.delivery.state = "delivery-posting";
  next.delivery.last_error_code = null;
  next.delivery.next_attempt_at = null;
  next.delivery.last_error = null;
  const updated = await persistPublicFollowup(store, task, next, {
    requireUnblocked: true,
  });
  return publicMutationOutput({
    json,
    action: "begin-delivery",
    task: updated,
    all: (await store.list({})).items,
    changed: ["delivery"],
    context,
  });
}

async function pruneDone(store: Store, keep: number): Promise<number> {
  if (!store.prune) return 0;
  return (await store.prune({ state: "done", keep, archive: true })).archived;
}

async function recordDelivery(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const receipt = parsePostedReceipt(readJsonFile(args, "--receipt-file"));
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["record-delivery"],
  );
  const id = requireId(positionals[0], "id");
  const task = await requireObligation(store, id, context);
  if (
    receipt.request_id !== task.public_followup.request.request_id ||
    receipt.platform !== task.public_followup.request.platform
  ) {
    throw new AxiError(
      "Posted receipt request or platform does not match the obligation",
      "VALIDATION_ERROR",
    );
  }
  if (task.public_followup.delivery.state === "posted") {
    if (!canonicalEqual(task.public_followup.delivery.receipt, receipt)) {
      throw new AxiError(
        "Public-followup already has a different posted receipt",
        "CONFLICT",
      );
    }
    const pruned = await pruneDone(store, config.doneKeep);
    return publicMutationOutput({
      json,
      action: "record-delivery",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      pruned,
      context,
    });
  }
  if (
    task.state === "done" ||
    task.public_followup.delivery.state === "waived"
  ) {
    throw new AxiError(
      "Waived public-followup cannot accept a delivery receipt",
      "CONFLICT",
    );
  }
  if (
    task.public_followup.delivery.payload_digest === null ||
    task.public_followup.delivery.attempt_count < 1 ||
    receipt.attempt_count !== task.public_followup.delivery.attempt_count
  ) {
    throw new AxiError(
      "Posted receipt does not match a recorded delivery attempt",
      "VALIDATION_ERROR",
    );
  }
  if (
    !["delivery-posting", "retry-due", "unknown", "partial"].includes(
      task.public_followup.delivery.state,
    )
  ) {
    throw new AxiError(
      `Cannot record delivery from state ${task.public_followup.delivery.state}`,
      "VALIDATION_ERROR",
    );
  }
  const next = nextPayload(task);
  next.delivery.state = "posted";
  next.delivery.receipt = receipt;
  next.delivery.last_error_code = null;
  next.delivery.next_attempt_at = null;
  next.delivery.last_error = null;
  const updated = await persistPublicFollowup(store, task, next, {
    complete: true,
  });
  const pruned = await pruneDone(store, config.doneKeep);
  return publicMutationOutput({
    json,
    action: "record-delivery",
    task: updated,
    all: (await store.list({})).items,
    changed: ["delivery", "state"],
    pruned,
    context,
  });
}

async function recordError(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const error = parseDeliveryError(readJsonFile(args, "--error-file"));
  const positionals = requirePositionals(
    args,
    1,
    1,
    SUBCOMMAND_HELP["record-error"],
  );
  const id = requireId(positionals[0], "id");
  const task = await requireObligation(store, id, context);
  if (task.state === "done") {
    throw new AxiError(
      "Completed public-followup cannot record a delivery error",
      "VALIDATION_ERROR",
    );
  }
  if (
    task.public_followup.delivery.state === error.state &&
    canonicalEqual(task.public_followup.delivery.last_error, error)
  ) {
    return publicMutationOutput({
      json,
      action: "record-error",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      context,
    });
  }
  if (
    ["intent", "pending-work"].includes(task.public_followup.delivery.state)
  ) {
    throw new AxiError(
      "Delivery errors cannot be recorded before work is ready",
      "VALIDATION_ERROR",
    );
  }
  if (
    ["unknown", "partial"].includes(error.state) &&
    (task.public_followup.delivery.payload_digest === null ||
      task.public_followup.delivery.attempt_count < 1)
  ) {
    throw new AxiError(
      `${error.state} requires a recorded delivery attempt`,
      "VALIDATION_ERROR",
    );
  }
  const next = nextPayload(task);
  next.delivery.state = error.state;
  next.delivery.last_error_code = error.error_code;
  next.delivery.next_attempt_at = error.next_attempt_at;
  next.delivery.last_error = error;
  const updated = await persistPublicFollowup(store, task, next);
  return publicMutationOutput({
    json,
    action: "record-error",
    task: updated,
    all: (await store.list({})).items,
    changed: ["delivery"],
    context,
  });
}

function waiverReason(raw: string): string {
  const reason = raw.trim();
  const hasControl = [...reason].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (reason === "" || reason.length > 240 || hasControl) {
    throw new AxiError(
      "--reason must be safe single-line text up to 240 characters",
      "VALIDATION_ERROR",
    );
  }
  return reason;
}

async function waive(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const reason = waiverReason(requireFlag(args, "--reason"));
  const approvedBy = requireFlag(args, "--approved-by");
  if (approvedBy !== "captain") {
    throw new AxiError(
      "--approved-by must be exactly captain",
      "VALIDATION_ERROR",
    );
  }
  const positionals = requirePositionals(args, 1, 1, SUBCOMMAND_HELP.waive);
  const id = requireId(positionals[0], "id");
  const task = await requireObligation(store, id, context);
  const existing = task.public_followup.delivery.waiver;
  if (task.public_followup.delivery.state === "waived" && existing) {
    if (existing.reason !== reason || existing.approved_by !== "captain") {
      throw new AxiError(
        "Public-followup already has a different waiver",
        "CONFLICT",
      );
    }
    const pruned = await pruneDone(store, config.doneKeep);
    return publicMutationOutput({
      json,
      action: "waive",
      task,
      all: (await store.list({})).items,
      already: true,
      changed: [],
      pruned,
      context,
    });
  }
  if (
    task.state === "done" ||
    task.public_followup.delivery.state === "posted"
  ) {
    throw new AxiError("Posted public-followup cannot be waived", "CONFLICT");
  }
  const next = nextPayload(task);
  next.delivery.state = "waived";
  next.delivery.waiver = {
    approved_by: "captain",
    reason,
    waived_at: new Date().toISOString(),
  };
  next.delivery.last_error_code = null;
  next.delivery.next_attempt_at = null;
  next.delivery.last_error = null;
  const updated = await persistPublicFollowup(store, task, next, {
    complete: true,
  });
  const pruned = await pruneDone(store, config.doneKeep);
  return publicMutationOutput({
    json,
    action: "waive",
    task: updated,
    all: (await store.list({})).items,
    changed: ["delivery", "state"],
    pruned,
    context,
  });
}

interface PublicMutationOutputOptions {
  json: boolean;
  action: string;
  task: Task;
  all: Task[];
  already?: boolean;
  changed: string[];
  pruned?: number;
  context?: TasksContext;
}

function publicMutationOutput(options: PublicMutationOutputOptions): string {
  const value = options.task.public_followup;
  if (!value) throw new AxiError("Missing public-followup payload", "UNKNOWN");
  const suggestions = publicSuggestions(options.task, options.context);
  return renderMutation({
    json: options.json,
    confirm: `public-followup ${options.action} ${options.task.id}${
      options.already ? " already" : ""
    } -> ${value.delivery.state} (revision ${value.revision})${
      options.pruned ? `; pruned ${options.pruned}` : ""
    }`,
    already: options.already,
    jsonPayload: {
      ok: true,
      action: `public-followup.${options.action}`,
      ...(options.already ? { already: true } : {}),
      revision: value.revision,
      changed: options.changed,
      ...(options.pruned !== undefined ? { pruned: options.pruned } : {}),
      task: taskToJson(options.task, options.all),
    },
    detail: renderDetail(
      "public_followup",
      {
        id: options.task.id,
        state: options.task.state,
        delivery_state: value.delivery.state,
        revision: value.revision,
        relations: value.work_relations.length,
      },
      [
        field("id"),
        field("state"),
        field("delivery_state"),
        field("revision"),
        field("relations"),
      ],
    ),
    suggestions,
  });
}

function publicSuggestions(task: Task, context?: TasksContext): string[] {
  const state = task.public_followup?.delivery.state;
  const lines: string[] = [];
  if (state === "ready") {
    lines.push(
      `Run \`tasks-axi public-followup begin-delivery ${task.id} --payload-hash <sha256>\` after semantic preflight`,
    );
  } else if (
    state === "delivery-posting" ||
    state === "unknown" ||
    state === "partial"
  ) {
    lines.push(
      `Run \`tasks-axi public-followup record-delivery ${task.id} --receipt-file <file>\` after receipt reconciliation`,
    );
  } else if (state !== "posted" && state !== "waived") {
    lines.push(
      `Run \`tasks-axi public-followup list --work-ref <home/task>\` to reconcile related work`,
    );
  }
  return withSuggestionGlobals(lines, context?.suggestionGlobals);
}
