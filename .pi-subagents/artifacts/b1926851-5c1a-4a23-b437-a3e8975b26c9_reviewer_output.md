## Review

- Correct: Backend/config precedence in `README.md:232` and `AGENTS.md:59` matches `src/config.ts:494-501`; ADO table merging and the env overrides for org/project/area match `src/config.ts:508-516` and `src/config.ts:338-356`.
- Correct: PAT order, `az` fallback, and 203/HTML credential handling in `README.md:279-281` and `.tasks.toml.example:57-60` match `src/backends/ado-client.ts:18-24`, `src/backends/ado-client.ts:117-159`, and `src/backends/ado-client.ts:211-230`.
- Correct: The custom-field requirements, unsupported ADO maintenance/move capabilities, documented delete/public-followup races, close-date retention, and public-followup content drift checks agree with `src/backends/ado.ts:577-590`, `src/backends/ado.ts:815-857`, `src/backends/ado.ts:1418-1431`, `src/backends/ado.ts:1514-1568`, and `src/backends/ado.ts:1725-1769`.
- Note: `README.md:299` gives stale post-create recovery advice: it says to retry `start`/`done` directly after an unconfirmed transition. Final recovery intentionally requires inspecting the returned numeric work item, or running a project-wide query on `id_field` when no numeric id was returned, before retrying (`src/backends/ado.ts:1176-1181`, `src/backends/ado.ts:1247-1269`). Minimal correction: replace the retry sentence with “If creation or its follow-up transition has an unconfirmed outcome, follow the emitted recovery instruction: inspect the named ADO work item, or query the project-wide join field, before retrying.”
- Note: `README.md:128` and `skills/tasks-axi/SKILL.md:51` claim all mutation reruns are safe. That is not true after an ADO unconfirmed create: the persisted item may be outside the configured scope, so a normal slug lookup cannot confirm it and a blind retry can create another item (`src/backends/ado.ts:1176-1181`, `src/backends/ado.ts:1212-1269`). Minimal correction: qualify both statements with “except after an ADO unconfirmed-outcome error; follow its inspection/query guidance before retrying.”
- Note: `README.md:250` and `AGENTS.md:8` say the CLI never knows which backend is active and only talks to `Store`. The CLI explicitly exposes ADO-specific help and gates moves through backend capabilities, including a `MarkdownStore` type check (`src/cli.ts:70-72`, `src/commands/state.ts:702-708`, `src/commands/state.ts:726-745`). Minimal correction: say “Most command logic uses the `Store` seam; capability checks gate backend-specific maintenance and move behavior.”
- Note: `AGENTS.md:66` says `done` always auto-prunes and archives. ADO has no `prune`, and `done` silently skips pruning when the method is absent (`src/backends/ado.ts:577-590`, `src/commands/state.ts:254-265`). Minimal correction: prefix this convention with “On the Markdown backend”.
- Blocker: none.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Performed a read-only documentation accuracy review limited to the requested revision range and files; no source or documentation files were edited."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding cites exact documentation and implementation lines and provides a minimal correction."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --short; git diff --stat/--name-only 9a86c7c..6972168",
      "result": "passed",
      "summary": "Confirmed the review range and that there were no staged files; only the existing untracked .pi-subagents directory was shown."
    },
    {
      "command": "git diff/git show plus numbered read-only inspection of the requested docs and implementation files",
      "result": "passed",
      "summary": "Compared final ADO client/store/config/context/CLI/state/public-followup behavior against README, example config, AGENTS, and generated skill."
    }
  ],
  "validationOutput": [
    "Four documentation contradictions found: stale ADO post-create retry guidance, unsafe universal rerun claim, overstated backend-agnostic CLI claim, and unqualified auto-prune behavior.",
    "No contradictions found in documented config precedence, auth order/203 handling, field provisioning, ADO capability exclusions, race disclosures, close-date retention, or public-followup drift checks."
  ],
  "residualRisks": [
    "Tests were not run, as explicitly required by the review task."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only review of documentation added/changed for the Azure DevOps backend; no repository implementation changes made.",
  "reviewFindings": [
    "note: README.md:299 - post-create recovery must inspect/query ADO before retrying",
    "note: README.md:128 and skills/tasks-axi/SKILL.md:51 - mutation reruns are not universally safe after unconfirmed ADO creates",
    "note: README.md:250 and AGENTS.md:8 - CLI contains backend-specific capability/type handling",
    "note: AGENTS.md:66 - done auto-pruning is Markdown-only",
    "no blockers"
  ],
  "manualNotes": "Review artifact only; source tree left unchanged."
}
```
