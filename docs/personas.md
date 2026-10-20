# Personas

tasks-axi is a CLI with no UI, so its personas are the two kinds of caller that drive it.
Each journey below names the tests that pin it through the public CLI commands or the markdown `Store`.

## Backlog owner (human at a terminal)

Keeps a hand-editable `backlog.md` and uses the CLI for the changes that are easy to get wrong by hand.

- **Track work.**
  Adds a task, lists and shows it, starts it, and marks it done.
  Pinned by `test/commands/crud.test.ts`, `test/commands/state.test.ts`, and `test/commands/home.test.ts`.
- **Edit by hand and by CLI without losing anything.**
  Untouched lines stay byte-exact, a hand-edit and a CLI edit cannot clobber each other, and a locked backlog fails with a clear error instead of hanging.
  Pinned by `test/backends/markdown-grammar.test.ts`, `test/backends/markdown.test.ts`, and `test/backends/lock.test.ts`.
- **Move work between backlogs.**
  Moves a task, or a whole blocker and dependent set, to another backlog file and is told when a move would strand a dependency.
  Pinned by the `mv` cases in `test/commands/state.test.ts` and `test/backends/markdown.test.ts`.

## Automation caller (script or agent)

Drives the same commands non-interactively and cannot ask follow-up questions.

- **Read state cheaply.**
  Parses the compact TOON output of `list`, `show`, and `ready`, where blocked and held work is derived from the dependency graph.
  Pinned by `test/derive.test.ts` and `test/commands/crud.test.ts`.
- **Confirm a write without a second read.**
  Relies on the leading `ok:` line, the `--json` result, exit codes, and idempotent re-runs.
  Pinned by `test/cli.test.ts` and `test/commands/state.test.ts`.
- **Hand work off with an external step.**
  Runs `mv --prepare <command>` so an external step happens only for a move that is valid, while both backlogs are locked, and the move commits only if that step succeeds.
  Pinned by `test/commands/mv-prepare.test.ts` and `test/bin/mv-prepare-process.test.ts`.
- **Track a public promise to completion.**
  Records a public follow-up obligation and completes it only with a posted receipt or a waiver.
  Pinned by `test/public-followup.test.ts` and `test/commands/public-followup.test.ts`.
