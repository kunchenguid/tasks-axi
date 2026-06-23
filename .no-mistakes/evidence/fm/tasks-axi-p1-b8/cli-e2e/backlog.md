# Backlog

## In flight
- **owns-widget-h7** - PERSISTENT SECONDMATE (kind=secondmate, home ~/work/widget, harness claude). Owns the widget end to end including the release cycle, CI, and the store review watch. Idle pane is healthy; supervised by status writes. (since 2026-06-22)
- **lease-adopt-l5** - SHIP (acme, builder): adopt durable lease in spin-up - acquire home via `builder get --lease` and release on retirement. (since 2026-06-22). **pipeline running.**
- Release domain (owned by owns-widget-h7): 1.0.4 IN REVIEW; next release held. Full detail in the secondmate home.
- (status) Mobile ladder: 0.0.4 confirmed good on-device 2026-06-21. More rough edges to flag later.

## Queued
- [ ] lease-adopt - adopt the durable lease in the spin-up path blocked-by: lease-core-t4 (repo: acme)
- [ ] release-validation - staged promote of builder v1.30.1 (target; cut as prerelease via #308 merge 2026-06-21 - carries fork-fix). REMAINING: validate then flip to latest. (local + repo: builder)
- [ ] go-live (CAPTAIN-GATED) - full launch checklist is the SINGLE SOURCE OF TRUTH at data/go-live.md. Discrete tasks spawn from there.
- [ ] (later roadmap, data/pivot-plan.md) Phase 6 hardening remainder, multi-bot concurrency.

- [ ] release-notes-q1 - publish release notes blocked-by: owns-widget-h7 (repo: acme) (kind: docs) (since 2026-06-23)
## Done (10 most recent)
- [x] cert-cleanup - port the post-upload cert pruning to the release workflow. Keep newest 2, never touch distribution certs. https://github.com/acme/monorepo/pull/91 blocked-by: owns-widget-h7 (repo: monorepo) (merged 2026-06-23)
- [x] design-scout-d4 - SCOUT - data/design-scout-d4/report.md (reported 2026-06-22): design assessment for a backlog CLI. VERDICT BUILD-MVP-FIRST: own repo, markdown backend owning backlog.md in place. (reported 2026-06-22)
- [x] PR #31 (contributor) - SHIP MERGED https://github.com/acme/builder/pull/31 (squash, 2026-06-22): teardown treats work as landed when HEAD is on any remote. Reviewed MERGE AS-IS, contributor thanked. (merged 2026-06-22)
