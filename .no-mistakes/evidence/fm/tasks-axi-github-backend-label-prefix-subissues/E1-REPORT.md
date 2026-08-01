# E1: block-survival across a real GitHub web edit + heal-on-write

Sandbox: private throwaway repo `karotkriss/tasks-axi-e1-sandbox`, issue #2 (captain-authorized; repo awaits captain deletion).

## Procedure

1. Issue body written via API carrying the exact shipped format: prose, a secondary
   single-line base64url comment probe in the prose, and the visible fenced managed
   block (`<!-- tasks-axi:v1 -->` tag line + `blocked-by:` line with reason +
   `<!-- /tasks-axi -->`). Baseline read back byte-identical (`e1-baseline-v2.txt`).
2. The captain edited the issue in the real GitHub web editor (appended one line
   after the end marker) and saved. Post-edit read: `e1-after-edit.txt`.
3. Heal-on-write ran the actual `github-body.ts` parse -> canonical re-render ->
   PATCH -> read-back (`e1-healed.body`, `e1-after-heal.txt`).

## Findings

- **Block survival: PASS, byte-for-byte.** The only diff after the web edit was the
  appended line ` web-edited 2026-07-31`. No CRLF conversion, no HTML-comment
  stripping, no whitespace trimming, no markdown normalization anywhere in the body
  (fenced block, base64url comment line, unicode prose all byte-identical). The
  file's missing trailing newline was also preserved.
- **Heal-on-write: PASS.** Parse recovered every managed field (id, in-flight tag,
  kind, repo, priority, since, hold reason/kind/until, blocked-by edge with its
  free-text reason). The appended after-marker prose rejoined above the block, the
  block re-rendered canonically at the foot (tag order normalized), the PATCH
  round-tripped byte-identically, and a re-parse + re-render of the healed body is
  a fixed point (idempotent).

## Verdict

PASS - the block-authoritative storage design (ruling 1) holds against real web
edits; the storage-layer gate lifts.

## Sub-issues API write-surface verification (directive 2)

Beyond live docs and read probes (GraphQL `databaseId` / `parent { number }` /
`subIssues`, REST GET sub_issues 200 / GET parent structured 404), one live
link/unlink probe ran between the two existing sandbox issues:

- `POST /repos/{o}/{r}/issues/2/sub_issues` with `sub_issue_id=5006108361`
  (issue #1's GLOBAL id, not its number) linked #1 under #2; GraphQL read-back:
  `issue(1).parent.number = 2`, `issue(2).subIssues.totalCount = 1`.
- `DELETE /repos/{o}/{r}/issues/2/sub_issue` with the same id unlinked it;
  read-back `parent: null`. Sandbox left unlinked.

This is exactly the shape `gh.ts` implements (`addSubIssue`/`removeSubIssue`).
