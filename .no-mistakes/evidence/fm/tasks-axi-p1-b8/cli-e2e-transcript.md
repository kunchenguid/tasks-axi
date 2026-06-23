# tasks-axi CLI E2E transcript

Scenario: exercise the markdown backend through the shipped CLI, including caller-supplied IDs, dependency validation, ready filtering, already-done metadata backfill, archive-on-prune, and preservation of free-form markdown lines.

```sh
$ pnpm exec tsx bin/tasks-axi.ts list --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md --state queued
count: 3
tasks[3]{id,state,kind,repo,title}:
  lease-adopt,queued,task,acme,adopt the durable lease in the spin-up path
  release-validation,queued,task,builder,"staged promote of builder v1.30.1 (target; cut as prerelease via #308 merge 2026\n... (truncated, 148 chars total - use show release-validation --full to see complete text)"
  cert-cleanup,queued,task,monorepo,"port the post-upload cert pruning to the release workflow. Keep newest 2, never \n... (truncated, 105 chars total - use show cert-cleanup --full to see complete text)"
help[1]:
  - Run `tasks-axi show <id> --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` for full notes on a task
exit: 0
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts block cert-cleanup --by missing-q1 --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
error: "blocker \"missing-q1\" not found"
code: VALIDATION_ERROR
help[1]: "Create the blocker task first, or choose an existing task id"
exit: 2
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts block cert-cleanup --by owns-widget-h7 --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
block:
  id: cert-cleanup
  blocked_by: owns-widget-h7
help[2]:
  - Run `tasks-axi unblock cert-cleanup --by <other> --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to clear it
  - Run `tasks-axi ready --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to see what is still dispatchable
exit: 0
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts add release-notes-q1 publish\ release\ notes --kind docs --repo acme --blocked-by owns-widget-h7 --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
task:
  id: release-notes-q1
  title: publish release notes
  state: queued
  blocked: yes
  blocked_by: owns-widget-h7
  kind: docs
  repo: acme
  priority: "-"
  created: 2026-06-23
  closed: "-"
  deps: "blocked-by:owns-widget-h7"
  links: none
  body: ""
help[2]:
  - Run `tasks-axi start release-notes-q1 --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to move it to in flight
  - Run `tasks-axi block release-notes-q1 --by <other> --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to record a dependency
exit: 0
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts ready --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
count: 2
ready[2]{id,state,kind,repo,title}:
  lease-adopt,queued,task,acme,adopt the durable lease in the spin-up path
  release-validation,queued,task,builder,"staged promote of builder v1.30.1 (target; cut as prerelease via #308 merge 2026\n... (truncated, 148 chars total - use show release-validation --full to see complete text)"
help[1]:
  - Run `tasks-axi start <id> --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to dispatch one of these
exit: 0
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts done lease-core-t4 --pr https://github.com/acme/builder/pull/77 --note backfilled\ review\ evidence --no-prune --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
already: true
done:
  id: lease-core-t4
  state: done
  pruned: 0
task:
  id: lease-core-t4
  title: "SHIP MERGED https://github.com/acme/builder/pull/35 (squash, 2026-06-22): durabl\n... (truncated, 189 chars total - use show lease-core-t4 --full to see complete text)"
  state: done
  blocked: no
  blocked_by: none
  kind: ship
  repo: "-"
  priority: "-"
  created: "-"
  closed: 2026-06-22
  deps: none
  links: "pr:https://github.com/acme/builder/pull/35,pr:https://github.com/acme/builder/pull/77"
  body: backfilled review evidence
exit: 0
```

```sh
$ pnpm exec tsx bin/tasks-axi.ts done cert-cleanup --pr https://github.com/acme/monorepo/pull/91 --keep 2 --file .no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md
done:
  id: cert-cleanup
  state: done
  pruned: 3
help[1]:
  - Run `tasks-axi ready --file=.no-mistakes/evidence/fm/tasks-axi-p1-b8/cli-e2e/backlog.md` to dispatch work unblocked by this
exit: 0
```

## Persisted backlog after CLI mutations

```md
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
```

## Archive created by done auto-prune

```md

## Archived 2026-06-23
- [x] lease-core-t4 - SHIP MERGED https://github.com/acme/builder/pull/35 (squash, 2026-06-22): durable worktree lease with persistent state independent of live processes. https://github.com/acme/builder/pull/77 (merged 2026-06-22)
  backfilled review evidence
- [x] fork-fix-k4 - SHIP (builder, PR https://github.com/acme/builder/pull/306, captain-merged, released v1.30.0): clean-slate fork-routing fix. Superseded contributor #296 (closed w/ link). Unblocks the fork-contribution flow. (merged 2026-06-21)
- [x] multi-line-w8 - SCOUT - data/multi-line-w8/report.md: isolated e2e of the feature.
  Follow-up note added later: the harness env-plumbing was the cause, not the feature.
  Second continuation line for good measure. (reported 2026-06-22)
```
