# Task for reviewer

[Read from: /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/backends/ado.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/store.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/public-followup.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/backends/ado.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/backends/fake-ado.ts]

Review ADO backend core changes relative to base 9a86c7c86a4617a5a4f00f28dcb9588b03897f8f. Focus src/backends/ado.ts plus src/store.ts, src/public-followup.ts and relevant tests/fake. Read current code and diff, inspect callers/invariants. Do NOT run tests or modify files. Prior rounds already accepted/documented residual cross-item races for remove, move, public-followup blocker gate; do not re-report those. Verify all prior fixes adversarially and identify any new concrete reachable bugs, security/performance/errors or meaningful simplifications. Anchor findings to changed lines, severity, action. Respect test-quality rule: source-content-only tests are findings. Return only substantiated findings plus short coverage summary.

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