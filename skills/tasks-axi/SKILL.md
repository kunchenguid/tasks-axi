---
name: tasks-axi
description: "Manage a task backlog through the tasks-axi CLI — add, list, show, start, and complete tasks; track blocked-by dependencies and a ready queue; prune and normalize a hand-editable backlog.md. Use whenever a task touches backlog or task state: filing or dispatching work, recording a PR or report on completion, finding unblocked work, or trimming the Done list."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [tasks, backlog, planning, dependencies]
    category: productivity
---

# tasks-axi

Agent ergonomic task & backlog manager for the current workspace. Prefer this over hand-editing backlog.md for task state changes.

You do not need tasks-axi installed globally - invoke it with `npx -y tasks-axi <command>`.
If tasks-axi output shows a follow-up command starting with `tasks-axi`, run it as `npx -y tasks-axi ...` instead.

tasks-axi operates on a hand-editable `backlog.md` in the current workspace (or the path set in `.tasks.toml`). It edits the file in place with a byte-exact round-trip, so the human-readable backlog stays the source of truth.

## When to use

Use tasks-axi whenever a task touches the backlog: filing or dispatching work, moving a task through queued -> in flight -> done, recording a PR url or report path on completion, tracking blocked-by dependencies, finding unblocked (ready) work, or trimming the Done list.

## Workflow

1. Run `npx -y tasks-axi` with no arguments for a dashboard of the current backlog - in flight work, queued work with blockers, and suggested next commands.
2. Drill in verb-first: `list`, `show <id>`, `ready`, then mutate with `add`, `start`, `done`, `block`/`unblock`, `update`.
3. The long notes never appear in `list`; run `show <id> --full` to read a task's complete body.
4. `add` takes a caller-supplied id (the join key), e.g. `tasks-axi add fm-x "title" --kind ship --repo firstmate --start`; or pass `--mint` to generate a slug-xx id from the title.
5. `done <id> --pr <url>` (or `--report <path>`) closes a task, records the link, and prunes the Done list (archived, never deleted). Then `ready` shows work it unblocked.
6. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[16]:
  (none)=dashboard, add, list, show, start, done, reopen, update, rm, block, unblock, ready, mv, prune, render, setup
```

Run `npx -y tasks-axi --help` for global flags, or `npx -y tasks-axi <command> --help` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; the long task body is truncated by default - the whole point is that `list` stays cheap. Use `--full` only when you need the complete notes.
- Mutations are idempotent and report what changed (`already: true` on a no-op); re-running a mutation is safe.
- `block <id> --by <other>` and `unblock` manage the dependency graph; `ready` lists only queued work with no unresolved blocker.
- Filter `list` with `--state`, `--repo`, `--kind`, `--blocked`, `--limit`, and add columns with `--fields a,b,c`.
- `update <id> --append "<note>"` adds to a task's body; `update <id> --body "<text>"` or `--body-file <path>` replaces it, and `--title "<text>"` replaces the title; `render` normalizes the file; `mv <id> --to <path>` moves a task to another backlog.
- Free-form (no-id) backlog lines are preserved verbatim and are never modified.
