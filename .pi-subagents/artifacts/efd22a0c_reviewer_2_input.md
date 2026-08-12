# Task for reviewer

[Read from: /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/config.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/context.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/cli.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/commands/state.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/backends/markdown-grammar.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/backends/markdown.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/src/skill.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/config.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/context.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/commands/state.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/test/backends/markdown.test.ts, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/README.md, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/.tasks.toml.example, /home/firstmate/.no-mistakes/worktrees/2dd39aaa8086/01KZSSSBJMZ8VSKS3QH5G6437V/skills/tasks-axi/SKILL.md]

Review backend selection/config/CLI/shared Markdown changes relative to base 9a86c7c86a4617a5a4f00f28dcb9588b03897f8f. Focus src/config.ts, src/context.ts, src/cli.ts, src/commands/state.ts, src/backends/markdown*.ts, src/skill.ts, docs/config and relevant tests. Do NOT run tests or modify files. Critical invariant: default markdown backend must remain behaviorally unaffected; ADO dry-run ignores invalid inactive markdown config and vice versa. Inspect for concrete behavior regressions, option parsing, env/TOML precedence/path guard, capability gating, source-content-only tests. Anchor findings to changed lines. Prior accepted difference: strict public-followup title/body content validation only on ADO reads, documented; do not re-report.

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