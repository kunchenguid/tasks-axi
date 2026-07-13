#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
EVIDENCE="$ROOT/.no-mistakes/evidence/fm/tasks-public-followup-k4"
SOURCE="$EVIDENCE/source-backlog.md"
DESTINATION="$EVIDENCE/destination-backlog.md"
CLI=(pnpm --silent dev)

cp "$EVIDENCE/source-template.md" "$SOURCE"
cp "$EVIDENCE/destination-template.md" "$DESTINATION"
rm -f "$EVIDENCE/done-archive.md"

run() {
  printf '\n$ tasks-axi'
  printf ' %q' "$@"
  printf '\n'
  "${CLI[@]}" "$@"
}

reject() {
  printf '\n$ tasks-axi'
  printf ' %q' "$@"
  printf '\n'
  set +e
  "${CLI[@]}" "$@" 2>&1
  status=$?
  set -e
  printf '[exit %s, rejected as expected]\n' "$status"
  test "$status" -ne 0
}

run public-followup add public-final-ab \
  --request-context-file "$EVIDENCE/request.json" \
  --purpose promised-final \
  --expected-final-file "$EVIDENCE/expected.json" \
  --expires-at 2026-10-01T00:00:00Z \
  --file "$SOURCE" --json

run public-followup bind-work public-final-ab \
  --relation-file "$EVIDENCE/relation.json" \
  --file "$SOURCE" --json

run mv public-final-ab --to "$DESTINATION" --file "$SOURCE" --json

run public-followup list \
  --work-ref secondmate:demo/work-code-q1 \
  --file "$DESTINATION" --json

run public-followup work-event public-final-ab \
  --event-file "$EVIDENCE/event.json" \
  --file "$DESTINATION" --json

run public-followup work-event public-final-ab \
  --event-file "$EVIDENCE/event.json" \
  --file "$DESTINATION" --json

run block public-final-ab --by ordinary-q1 --file "$DESTINATION" --json
run public-followup ready --file "$DESTINATION" --json
reject public-followup begin-delivery public-final-ab \
  --payload-hash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --file "$DESTINATION" --json

run unblock public-final-ab --by ordinary-q1 --file "$DESTINATION" --json
run ready --file "$DESTINATION"
run public-followup ready --file "$DESTINATION" --json

reject start public-final-ab --file "$DESTINATION" --json
reject done public-final-ab --no-prune --file "$DESTINATION" --json
reject hold public-final-ab --reason unsafe-dispatch-hold --file "$DESTINATION" --json

run public-followup begin-delivery public-final-ab \
  --payload-hash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --file "$DESTINATION" --json

run public-followup record-delivery public-final-ab \
  --receipt-file "$EVIDENCE/receipt.json" \
  --file "$DESTINATION" --json

reject reopen public-final-ab --file "$DESTINATION" --json
run prune --state done --keep 0 --file "$DESTINATION" --json

printf '\n$ decode archived reserved metadata\n'
node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  const encoded = text.match(/tasks-axi:public-followup\/v1:([A-Za-z0-9_-]+)/)?.[1];
  if (!encoded) throw new Error("archived metadata missing");
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  console.log(JSON.stringify({
    schema_version: value.schema_version,
    revision: value.revision,
    delivery_state: value.delivery.state,
    receipt_state: value.delivery.receipt.state,
    request_id: value.delivery.receipt.request_id,
    accepted_event_ids: value.work_relations[0].accepted_event_ids
  }, null, 2));
' "$EVIDENCE/done-archive.md"
