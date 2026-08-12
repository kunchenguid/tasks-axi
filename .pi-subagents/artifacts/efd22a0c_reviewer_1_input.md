# Task for reviewer

[Read from: /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/backends/ado-client.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/backends/ado-client.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/backends/ado.ts]

Review ADO REST client/auth changes relative to base 9a86c7c86a4617a5a4f00f28dcb9588b03897f8f. Focus src/backends/ado-client.ts and test/backends/ado-client.test.ts, plus any relevant callers in ado.ts. Do NOT run tests or modify files. Inspect correctness on HTTP/auth/error uncertainty, Windows launcher, URLs/API versions, malformed responses, response handling. Prior fixed finding was Windows selection via process.platform; verify current implementation. Identify concrete reachable issues only; line-anchor, severity/action. Flag source-content-only tests under supplied rule.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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