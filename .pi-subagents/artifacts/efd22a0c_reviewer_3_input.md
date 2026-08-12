# Task for reviewer

[Read from: /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/plan.md, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/progress.md]

Perform an independent full diff review relative to base 9a86c7c86a4617a5a4f00f28dcb9588b03897f8f. Read commit history and all changed files as needed, but do NOT run tests or modify files. Evaluate source correctness/spec scope/security/performance/error handling/simplification and test quality. User wants only ADO-related additive changes, no Pi ambient/project parts, markdown default unaffected. Prior rounds accepted and documented ADO cross-item race containments and explicitly chose not to align markdown public-followup strictness; do not re-report. Prior PI-SCOPE-HISTORY was ignored; do not re-report. Continue full pass, concrete reachable defects only, changed-line anchors, severity/action/review_scope.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```