# tasks-axi — agent notes

Agent-ergonomic task/backlog CLI in the `*-axi` family, built on `axi-sdk-js` and mirroring `gh-axi`.
Two backends ship behind the `Store` seam: markdown (P1) and beads; sqlite (P2) and remote trackers (P3) are deferred.

## Architecture

The CLI layer never knows which backend is active — it only talks to the `Store` interface.

- `src/cli.ts` — `runAxiCli` wiring: `DESCRIPTION`, `TOP_HELP`, the verb→handler map (with aliases create/view/edit/delete/close), the optional `task` noun prefix, and the global `--backend` / `--file` flags (stripped before handlers, parsed for `resolveContext`).
- `src/context.ts` — `resolveTasksContext` builds the backend `Store` + `ResolvedConfig`; every command receives this `TasksContext`.
- `src/store.ts` - the `Store` interface and `Capabilities`. Core contract: `create/get/update/remove/list/transition/addDep/removeDep/updatePublicFollowup`. `prune`/`render` are optional and capability-gated.
- `src/model.ts` — the `Task` data model (report §5).
- `src/pr-url.ts` — `isPrUrl`, the one canonical PR-URL seam (GitHub `/pull/<n>` on github.com, Forgejo `/pulls/<n>` on any lowercase DNS host) shared by prose link derivation, `--pr` validation, and public-followup `pr_url`; near-misses derive as `doc` links, never `pr`.
- `src/derive.ts` - worker `blocked` / `ready` / active `held` and public delivery readiness are derived in the CLI from `list` + the dep graph + hold date gates, never Store methods, so every backend gets them for free.
- `src/backends/markdown*.ts` — the P1 backend; `src/backends/normalize.ts` holds the backend-independent Task validation both backends share.
- `src/backends/beads.ts` — the beads backend: `bd --json` subprocesses over a per-invocation list cache, `tasks_axi` metadata for fields beads lacks, and a canonical-markdown mirror rewritten after every mutation (see "The beads backend" in README.md). Real-bd tests in `test/backends/beads.test.ts` skip when `bd` is not installed.
- `src/public-followup.ts` - authoritative versioned schema, strict privacy-safe validation, canonical encoding, immutable-field checks, relation/event readiness, and terminal-state invariants for `kind=public-followup`; `src/commands/public-followup.ts` owns its dedicated CLI state machine.
- `src/commands/*` — one file per verb group; `src/view.ts` owns the read-side TOON projection; `src/confirm.ts` owns the write-side output (the `ok:` confirmation line, the `--json` payload, and `renderMutation`, which assembles both).
- Shared helpers copied from the family: `args.ts`, `body.ts`, `format.ts`, `fields.ts`, `toon.ts`, `suggestions.ts`, `skill.ts` (minimal CLI-deferring stub generator).

## Markdown grammar invariants (the hard part — do not regress)

`src/backends/markdown-grammar.ts` is pure parse/render with no I/O; `markdown.ts` adds the lock + atomic write.

- **Byte-exact round-trip (D1).** `render(parse(src)) === src` on any file nobody has mutated. Each entry keeps its exact original `raw` lines and is emitted verbatim unless `dirty`. A mutated task is re-rendered from its structured fields; untouched entries stay byte-exact. `test/fixtures/backlog.md` exercises every grammar feature; `test/fixtures/firstmate-backlog.md` mirrors firstmate's real `data/backlog.md` shape; a skipped-in-CI test also checks the real firstmate backlog when present.
- **The section header carries the state, not the bullet.** `## In flight`, `## Queued`, `## Done` decide the state. In-flight is recognized as BOTH the legacy `- **id** - …` and firstmate's GitHub-style `- [ ] id - …` checkbox; queued is `- [ ] id - …`; done is `- [x] id - …`. Render is unified on firstmate's real format: in-flight and queued both normalize to `- [ ] id - …` (done to `- [x] id - …`), so a legacy `- **id**` in-flight line normalizes to `- [ ]` when re-rendered and is **never** rewritten the other way — that keeps a tasks-axi-written file readable by firstmate (which assumes `- [ ]`). Byte-exact preservation still holds for untouched lines of either form.
- **Free-form lines (D7)** - any line whose first token is not a clean slug id followed by the delimiter `space-hyphen-space` is preserved verbatim and never operated on by id. The id must be immediately followed by `space-hyphen-space`. This keeps annotated lines like `go-live (CAPTAIN-GATED) - …` and `PR #31 (contributor) - …` free-form (no false positives).
- **Trailing-tag extraction.** Canonical tags (`(repo: X)`, `(kind: X)`, `(priority: 0-4)`, `(since DATE)`, `(merged|reported|done|closed DATE)`, `(hold: REASON)`, `(hold-kind: captain|external|load|parked|future)`, `(hold-until: DATE)`, `blocked-by:/parent:/discovered-from:`) are pulled only off the **trailing** tag-region of a line and re-appended in canonical order on render. This is what makes normalization idempotent: a mid-sentence parenthetical (e.g. `report.md (reported 2026-06-22): …`) or a non-date one (`(closed w/ link)`) is left in the prose and never duplicated or relocated. Date tags require an actual `YYYY-MM-DD`.
- **Dependency edges carry an optional free-text reason.** firstmate writes `blocked-by: <id> - <reason>` (e.g. `blocked-by: fix-login-k3 - waits on the login refactor`); the id stops at the first space and the reason runs to end-of-line, captured into `Dep.reason` and preserved across a round-trip. A reason does **not** affect `blocked`/`ready` (the graph keys off the blocker id alone), but a blocked item still stays out of `ready`. **Render-order rule:** a bare edge sits right after the title (before the parentheticals), but an edge **with a reason renders last**, after all `( … )` tags — both to match firstmate's real `(repo: …) blocked-by: <id> - <reason>` form and so a re-parse strips the parentheticals first and the reason never swallows a trailing tag (the idempotency trap).
- **Links and leading-word kinds live in the prose**, not as managed tags, so they are never duplicated. `done --pr`/`--report` append the url/path to the title text; links are re-derived by scanning. `kind` comes from a `(kind:)` tag or a leading `SHIP`/`SCOUT`/`DOCS-ONLY`/`PERSISTENT SECONDMATE` word, and the tag is emitted only when the prose does not already lead with that word.
- **body** = the item block under a bullet: every following indented (2-space) OR blank line, up to the next item header or free-form column-0 content (column-0 `## ` section headings are split earlier). Blank separators between paragraphs and trailing blanks before the next item/section belong to the block and move with it (`mv`/`start`/`done`/etc.). Indented pseudo-headings (e.g. `  ## Intent`) are body, never section boundaries. Owned by `parseEntries` in `markdown-grammar.ts`.
  Note writes are inspect-then-update: `show <id> --full`, then `update --body` or `update --body-file` with a curated replacement.
  Add `--archive-body` when the superseded body should be preserved in `note-archive.md`.
- **Public-followup metadata** is one reserved `  <!-- tasks-axi:public-followup/v1:<base64url-canonical-json> -->` line immediately below a `kind=public-followup` bullet.
  The grammar validates it strictly on every read, excludes it from the human body, and re-emits it through render, move, transition, prune, and archive.
  Firstmate and other callers must use `tasks-axi public-followup` and `--json`, never parse or rewrite the comment.
  Generic worker readiness and lifecycle transitions cannot dispatch, complete, reopen, remove, or change the kind of an active obligation; only a posted receipt or Captain waiver completes it.
- **Concurrency:** every mutation runs under `withLock` (advisory `<path>.lock`) and fails closed with a `LOCKED` error if another process holds the lock past the bounded timeout.
  If the lock looks stale, the error tells the user to remove `<path>.lock` only after confirming no `tasks-axi` process is running.
  Corruption-safety is guaranteed independently by atomic temp-file + rename writes, and a hand-edit landing between read and write is detected and refused.
  Reads do not lock.

## Conventions

- **Ids are caller-supplied join keys (D6)** validated by `ID_RE` (slug-shaped); `add --mint [--prefix]` generates a `slug-xx` id.
- **prune archives, never deletes (D4)** - surplus Done tasks are appended to `markdown.archive` or default `done-archive.md`. It keeps N _recognized_ tasks; free-form Done lines are preserved and not counted.
- **`done` auto-prunes** to `config.doneKeep` (default 10) and archives, unless `--no-prune`.
- **`done` on an already-Done task** stays idempotent but backfills supplied `--pr`, `--report`, and non-duplicate `--note` metadata without replacing the original closed date.
- **Dependency mutations validate targets.** `add --blocked-by` and `block --by` reject missing blockers and self-blocks. Parsed dangling blockers are still treated as resolved for legacy hand-edited files.
- **Blocking tasks are protected.** `rm` and single-id `mv` reject a task that still blocks active dependents; unblock or complete the dependents first.
- **`mv` is a multi-id atomic cross-file move.** `mv <id> [<id>...] --to <path>` moves a whole connected set in one transaction (`MarkdownStore.moveManyTo` under a two-file `withLocks`): all land or none do, no intermediate on-disk state that loses a link. Intra-set `blocked-by` edges (reason strings included) survive because both endpoints travel together; `requireNoSplitDeps` refuses and names any edge whose blocker/dependent would be stranded across the two files. Single-id `mv` is just N=1 (`moveTo` delegates to `moveManyTo`), so its byte output is unchanged. Moved items are re-rendered canonically, so trailing blank separators before the next item/section are dropped (a move-then-move-back is byte-exact only when the source had no such trailing blank).
- **Structured holds gate readiness.** `hold <id> --reason "<text>" [--until YYYY-MM-DD] [--kind captain|external|load|parked|future]` writes canonical hold tags; `unhold <id>` clears them.
  Hold reasons are single-line tag values without parentheses because parentheses delimit managed tags.
  Active holds keep queued tasks out of `ready`, while `ready --include-held` emits a separate `held` group.
  `hold-until` is inactive on and after that date.
  `list --state held` filters to active held tasks, and hold columns are available via `--fields held,hold_reason,hold_kind,hold_until`.
- **Hold migration mapping.** Future migration code should map prose markers to structured holds without bulk-rewriting by hand: `HELD` / `do not dispatch` / `CAPTAIN-DECISION` -> `kind: captain` unless the text points elsewhere; `PARKED` -> `kind: parked`; `DEFERRED` -> `kind: future`; load-clearing language such as `hold until <load clears>` -> `kind: load`; external dependency wording -> `kind: external`. Preserve the original prose as the hold reason unless a safer human-readable reason is explicitly supplied.
- Idempotent mutations exit 0 with `already: true`; errors are `AxiError` with SDK exit codes (VALIDATION_ERROR→2, else 1).
- **Write ops are confirmation-forward.** Every mutation (`add`/`start`/`done`/`reopen`/`update`/`rm`/`block`/`unblock`/`hold`/`unhold`/`public-followup`/`mv`/`prune`/`render`) leads with a terse `ok:` line (built in `confirm.ts`) confirming the write result.
  Task-state mutations include the resulting state (e.g. `ok: start <id> -> In flight`), while maintenance/removal commands confirm their own result shape (e.g. `ok: render -> normalized <n>`, `ok: removed <id>`).
  Optional structured detail follows (`add`/`update` keep the full `task:` record), then state-aware hints.
  The `ok:` line is a plain top-level TOON scalar (no `encode()` quoting) - confirmation messages are built from bounded values (ids, names, validated urls/paths, counts) so the combined output still decodes as TOON.
- **Hints are state-aware, never contradictory.** A command must not suggest an action it just performed.
  `add` branches its suggestion on the resulting state (`getSuggestions({action:"add", state})`): `--start`/in-flight → suggest `done`, queued → suggest `start`, done → suggest `reopen`.
  Idempotent paths emit the same state-aware hint as the fresh path.
- **`--json` is the machine-readable success signal.** Every mutation accepts `--json`, which replaces the TOON output with a single pretty-printed object `{ ok: true, action, [already], task|id|operation fields... }` (see `renderMutation` / `taskToJson`).
  This lets an agent confirm a write deterministically without a follow-up read.
  Errors still use structured-error output + non-zero exit (not JSON), so `exit 0` + `ok:true` = success.

## Entry point & the `--version` fast path

`bin/tasks-axi.ts` answers a bare `-v`/`-V`/`--version` through `axi-sdk-js/fast-path` and only then `await import`s `src/cli.js`, so the heavy command graph never loads for a version query (~31ms -> ~20ms, the node floor).
That makes `src/version.ts` a **leaf**: it may import node builtins and nothing else - importing anything from the command graph silently destroys the speedup. `cli.ts` re-imports `VERSION` from it, so there is still one source of the version string.
Any argv shape other than exactly one version flag falls through to `runAxiCli`, which remains the sole owner of the general case (e.g. `list --version` is still an unknown-flag error).
`test/bin/version-fast-path.test.ts` guards this deterministically with an ESM loader module trace (`test/fixtures/module-trace-*.mjs`) plus a negative control; do **not** add a wall-clock timing assertion to CI - it is flaky under runner contention.

## Build / test / ship

- `pnpm build` (tsc), `pnpm test` (vitest, `test/` mirrors `src/`), `pnpm lint` (eslint), `pnpm run build:skill -- --check` (CI fails if `skills/tasks-axi/SKILL.md` drifts from `src/skill.ts`).
- The shipped skill stays **minimal** and **defers to the CLI** for all actual guidance. Frontmatter (name/description/metadata) is the discovery surface; the body only says what tasks-axi is, when to reach for it, and pointers to `npx -y tasks-axi` (dashboard), `npx -y tasks-axi --help`, and `npx -y tasks-axi <command> --help`. tasks-axi CLI output is the single source of truth. Never re-duplicate CLI-owned commands, flags, or workflow steps into the skill - prefer a pointer. Never hand-edit `skills/tasks-axi/SKILL.md`; regenerate with `pnpm run build:skill`.
- This repo is no-mistakes-gated; ship through `/no-mistakes`.

### Release & packaging (mirrors the `*-axi` siblings)

- **Published to npm as a public package** via `release-please` → `npm publish --access public --provenance` on a release commit (`.github/workflows/release-please.yml`); the captain can also `npm publish` manually. Conventional commits drive the version bump; `release-please-config.json` + `.release-please-manifest.json` own versioning and `CHANGELOG.md`.
- Every `pull_request` workflow (`ci.yml`, `guard-generated-files.yml`, `no-mistakes-required.yml`) uses `paths-ignore` for the release-please output set (`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`) so release PRs create zero runs. Job-level bot `if`s stay as defense in depth. `test/release-ci-exclusions.test.ts` derives that set from `release-please-config.json` and fails if a workflow drifts; update the ignore lists when adding `extra-files` or changing `release-type`.
- **The tarball ships runtime JS only.** `package.json` `files` is `dist/**/*.js` (+ `skills/tasks-axi`, `LICENSE`, `README.md`), so the `.d.ts`/`.js.map` that `tsc` emits for local debugging are kept out of the package.
  `prepack` runs `npm run build`, so `npm pack`/`npm publish` always rebuild `dist` first.
  In a fresh clone, run `pnpm install --frozen-lockfile` before manual pack or publish.
  Verify with `npm pack --dry-run` (no source/test cruft; bin is `dist/bin/tasks-axi.js` with its shebang preserved by tsc).
- **CI is a 3-OS matrix** (ubuntu/macos/windows) running install → build → lint → test → `build:skill --check`. The `Require no-mistakes` and `Guard generated files` checks gate every PR to `main`.
- **The `Require no-mistakes` gate is a thin caller of a shared composite action.** `.github/workflows/no-mistakes-required.yml` delegates enforcement to `kunchenguid/no-mistakes/.github/actions/require-no-mistakes`, pinned to an immutable commit SHA and never `@main` (main is editable by the very PR the gate judges). Enforcement logic and its tests live upstream in the no-mistakes repo - change enforcement there rather than hand-copying a script between siblings, and bump this repo's pin in a deliberate separate PR. This repo still owns its `on:`, `paths-ignore`, `concurrency`, `permissions`, job name, and author-exemption `if:`.
- The shared action binds the attestation to the PR's current head, so a PR whose body no-mistakes did not rewrite for that head goes red. That is the attestation contract, not a flake: push through `git push no-mistakes` so the body is refreshed. `on.pull_request.types` deliberately omits `synchronize` - the verdict is a pure function of the PR body, and a push-triggered run pins a failure to a head whose body the same pipeline run is about to fix.

## Follow-ups (out of P1 scope)

- Migrate firstmate's own `backlog.md` onto tasks-axi (a separate firstmate-repo change).
- sqlite backend (P2); github/jira/linear backends (P3) — slot in behind the existing `Store` seam.
- Optional: count free-form Done lines toward the prune keep, or recognize compound ids (`a / b`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
