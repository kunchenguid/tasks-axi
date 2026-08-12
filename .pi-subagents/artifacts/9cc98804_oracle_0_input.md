# Task for oracle

Adjudicate candidate review findings for current ADO backend diff vs base 9a86c7c: (1) case-sensitive tag ownership in ado.ts tagValue/tagString; Microsoft Azure Boards tags are case-sensitive, so decide whether exact lowercase kind:/repo: handling is correct or buggy. (2) resolveAdo returns undefined when only TASKS_AXI_ADO_AREA is set, yielding context message that an [ado] table is needed rather than specifically missing org/project; decide materiality. (3) explicit --file is ignored when selected backend is ado; docs define --file as Markdown path and prior requirement says validate only active backend; decide if this warrants finding. Also independently inspect relevant source for one concrete missed defect, without running tests or modifying. Prior accepted residual cross-item races and PI history must not be re-reported. Return concise adjudication with concrete line anchors only for real findings.

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