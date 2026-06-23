# tasks-axi — agent notes

Agent-ergonomic task/backlog CLI in the `*-axi` family, built on `axi-sdk-js` and mirroring `gh-axi`.
P1 ships only the markdown backend behind a `Store` seam; sqlite (P2) and remote trackers (P3) are deferred.

## Architecture

The CLI layer never knows which backend is active — it only talks to the `Store` interface.

- `src/cli.ts` — `runAxiCli` wiring: `DESCRIPTION`, `TOP_HELP`, the verb→handler map (with aliases create/view/edit/delete/close), the optional `task` noun prefix, and the global `--backend` / `--file` flags (stripped before handlers, parsed for `resolveContext`).
- `src/context.ts` — `resolveTasksContext` builds the backend `Store` + `ResolvedConfig`; every command receives this `TasksContext`.
- `src/store.ts` — the `Store` interface and `Capabilities`. Core contract: `create/get/update/remove/list/transition/addDep/removeDep`. `prune`/`render` are optional and capability-gated.
- `src/model.ts` — the `Task` data model (report §5).
- `src/derive.ts` — `blocked` / `ready` are derived in the CLI from `list` + the dep graph, never a Store method, so every backend gets them for free.
- `src/backends/markdown*.ts` — the only P1 backend.
- `src/commands/*` — one file per verb group; `src/view.ts` owns the TOON projection.
- Shared helpers copied from the family: `args.ts`, `body.ts`, `format.ts`, `fields.ts`, `toon.ts`, `suggestions.ts`, `skill.ts`.

## Markdown grammar invariants (the hard part — do not regress)

`src/backends/markdown-grammar.ts` is pure parse/render with no I/O; `markdown.ts` adds the lock + atomic write.

- **Byte-exact round-trip (D1).** `render(parse(src)) === src` on any file nobody has mutated. Each entry keeps its exact original `raw` lines and is emitted verbatim unless `dirty`. A mutated task is re-rendered from its structured fields; untouched entries stay byte-exact. `test/fixtures/backlog.md` exercises every grammar feature; a skipped-in-CI test also checks the real firstmate backlog when present.
- **Free-form lines (D7)** — any line whose first token is not a clean slug id followed by ` - ` — are preserved verbatim and never operated on by id. A task id is recognized only as `- **id** - …` (in flight), `- [ ] id - …` (queued), `- [x] id - …` (done), where the id is immediately followed by ` - `. This keeps annotated lines like `go-live (CAPTAIN-GATED) - …` and `PR #31 (contributor) - …` free-form (no false positives).
- **Trailing-tag extraction.** Canonical tags (`(repo: X)`, `(kind: X)`, `(since DATE)`, `(merged|reported|done DATE)`, `blocked-by:/parent:/discovered-from:`) are pulled only off the **trailing** tag-region of a line and re-appended in canonical order on render. This is what makes normalization idempotent: a mid-sentence parenthetical (e.g. `report.md (reported 2026-06-22): …`) or a non-date one (`(closed w/ link)`) is left in the prose and never duplicated or relocated. Date tags require an actual `YYYY-MM-DD`.
- **Links and leading-word kinds live in the prose**, not as managed tags, so they are never duplicated. `done --pr`/`--report` append the url/path to the title text; links are re-derived by scanning. `kind` comes from a `(kind:)` tag or a leading `SHIP`/`SCOUT`/`DOCS-ONLY`/`PERSISTENT SECONDMATE` word, and the tag is emitted only when the prose does not already lead with that word.
- **body** = indented (2-space) continuation lines under a bullet; `update --append` grows it. Blank lines inside a body are not preserved (avoid them).
- **Concurrency:** every mutation runs under `withLock` (advisory `<path>.lock`) and fails closed with a `LOCKED` error if another process holds the lock past the bounded timeout.
  If the lock looks stale, the error tells the user to remove `<path>.lock` only after confirming no `tasks-axi` process is running.
  Corruption-safety is guaranteed independently by atomic temp-file + rename writes, and a hand-edit landing between read and write is detected and refused.
  Reads do not lock.

## Conventions

- **Ids are caller-supplied join keys (D6)** validated by `ID_RE` (slug-shaped); `add --mint [--prefix]` generates a `slug-xx` id.
- **prune archives, never deletes (D4)** — surplus Done tasks are appended to `done-archive.md`. It keeps N *recognized* tasks; free-form Done lines are preserved and not counted.
- **`done` auto-prunes** to `config.doneKeep` (default 10) and archives, unless `--no-prune`.
- Idempotent mutations exit 0 with `already: true`; errors are `AxiError` with SDK exit codes (VALIDATION_ERROR→2, else 1).

## Build / test / ship

- `pnpm build` (tsc), `pnpm test` (vitest, `test/` mirrors `src/`), `pnpm lint` (eslint), `pnpm run build:skill -- --check` (the generated `skills/tasks-axi/SKILL.md` is built from `DESCRIPTION` + `TOP_HELP` and must not drift — CI runs the check).
- `skills/tasks-axi/SKILL.md` is generated — regenerate with `pnpm run build:skill` after changing the description or top-level help; never hand-edit it.
- This repo is no-mistakes-gated; ship through `/no-mistakes`.

## Follow-ups (out of P1 scope)

- Migrate firstmate's own `backlog.md` onto tasks-axi (a separate firstmate-repo change).
- sqlite backend (P2); github/jira/linear backends (P3) — slot in behind the existing `Store` seam.
- Optional: count free-form Done lines toward the prune keep, or recognize compound ids (`a / b`).
