<h1 align="center">tasks-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/tasks-axi"><img alt="npm" src="https://img.shields.io/npm/v/tasks-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/tasks-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/tasks-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/kunchenguid/tasks-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/tasks-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
</p>

Task and backlog manager for agents — designed with [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface).

tasks-axi makes a tiny structured change to a human-readable backlog at near-zero output-token cost.
It edits a hand-editable `backlog.md` in place with a byte-exact round-trip, so the markdown stays the source of truth while the long, accumulating notes never bloat a `list`.
It borrows the dependency-graph and ready-query model from [beads](https://github.com/gastownhall/beads) and the house style from its `*-axi` siblings — token-efficient TOON output, contextual next-step suggestions, idempotent mutations, and structured errors.

## Why

Every backlog mutation today regenerates markdown through the model, which is expensive output tokens and risks dropped, duplicated, or reordered items.
tasks-axi reduces that to the length of one short command plus a compact confirmation read back as cheap input.
The long status line that the model used to rewrite on every status change is now a `body`.
`update --append` adds to that body, while either `update --body` or `update --body-file` replaces it outright and `update --title` replaces the title.

## Quick Start

Install the tasks-axi skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/tasks-axi --skill tasks-axi -g
```

That is the entire setup — no npm install needed.
The skill teaches your agent to run tasks-axi through `npx -y tasks-axi`, so the CLI comes along on demand (Node 20+ required).

Just ask for anything that touches the backlog — filing or dispatching work, completing a task, finding unblocked work — and the agent loads the skill on its own when it recognizes the task.

`-g` installs the skill for all projects; drop it to install for the current project only.

## Other Ways to Install

The skill is the recommended path, but it is not the only one.

### Zero setup

tasks-axi is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Execute `npx -y tasks-axi` to manage the backlog.
```

### Session hook

Want the current backlog fed into every agent session as ambient context instead of loading on demand?
Install the CLI globally and opt into the hook:

```sh
npm install -g tasks-axi
tasks-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode** that surfaces the live backlog at the start of each session.
**Restart your agent session after running this** so the new hook takes effect.

## Usage

Run with no arguments for a content-first dashboard of the current backlog:

```
$ tasks-axi
bin: ~/.local/bin/tasks-axi
description: Agent ergonomic task & backlog manager for the current workspace...
in_flight[1]{id,title,kind,repo}:
  homemux-h7,PERSISTENT SECONDMATE - owns HomeMux end to end,secondmate,homemux
summary:
  queued: 14
  ready: 13
queued[10]{id,title,kind,blocked_by}:
  firstmate-lease-adopt,adopt the durable lease,ship,treehouse-lease-t4
  ...
done: 10 retained
help[2]:
  - Run `tasks-axi list --state queued` for all 14 queued tasks
  - Run `tasks-axi ready` to see only unblocked work
```

The common mutations are one short, low-token command:

```sh
# add a task (the id is the caller-supplied join key; --mint generates one)
tasks-axi add lavish-foo-q9 "fix summary toggle" --kind ship --repo lavish-axi --priority 2 --start

# move through the workflow
tasks-axi start firstmate-lease-adopt
tasks-axi done sm-idle-handoff-q8 --pr https://github.com/owner/repo/pull/42
tasks-axi reopen some-task

# dependencies and the ready queue
tasks-axi block firstmate-lease-adopt --by treehouse-lease-t4
tasks-axi ready

# edit the body and title: --append adds to the body, --body or --body-file replaces it, --title replaces the title
tasks-axi update nm-release-validation --append "step 3 in progress on lavish #87"
tasks-axi update nm-release-validation --body "rewritten notes"
tasks-axi update nm-release-validation --body-file notes.md
tasks-axi update nm-release-validation --title "clearer title"

# read the full notes on demand (truncated by default)
tasks-axi show homemux-h7 --full

# maintenance
tasks-axi prune --keep 10        # archives the surplus, never deletes
tasks-axi render                 # normalize the markdown in place
tasks-axi mv hibit-cert-cleanup --to ../homemux/data/backlog.md
```

Output is [TOON](https://toonformat.dev)-encoded and token-efficient.
The long task body is truncated by default — the whole point is that `list` stays cheap; use `--full` only when you need the complete notes.
Mutations are idempotent and report what changed (`already: true` on a no-op), so re-running one is safe.
Running `done` again on an already Done task can still backfill a new `--pr`, `--report`, or `--note` without changing the original close date.

Run `tasks-axi --help` for the command list, or `tasks-axi <command> --help` for per-command usage.

## The markdown backend

`backlog.md` stays the hand-editable source of truth.
tasks-axi parses it leniently into a model, mutates the targeted item, and re-renders **in place** with a byte-exact round-trip on a file nobody has changed — `render(parse(src)) === src`.
Targeted task mutations re-render only the affected task; every other line, including free-form (no-id) notes, is preserved verbatim.
Maintenance commands are explicit exceptions: `render` normalizes every recognized task, `prune` trims the chosen section into the archive, and `mv` writes both source and destination backlogs.

The read-modify-write window is guarded by an advisory lockfile, an atomic write (temp file + rename), and a fresh re-read on every invocation, so a hand-edit and a CLI-edit cannot clobber each other.

It gently formalizes the inline tags a backlog already uses as the canonical fields:

- `(repo: X)` — the repo a task belongs to
- `blocked-by: <id>` — a dependency edge (also `parent:` / `discovered-from:`)
- `(since <date>)` — when a task started; `(merged <date>)` / `(reported <date>)` when it closed
- `(kind: X)` — task kind, when not already implied by a leading `SHIP` / `SCOUT` / `DOCS-ONLY` / `PERSISTENT SECONDMATE` word
- `(priority: 0-4)` — optional priority, also accepted through `add` / `update --priority`
- PR urls, `data/<id>/report.md` paths, and other `http(s)` urls — typed links

`tasks-axi render` rewrites every id'd task into this canonical form; free-form lines are left untouched.
`add --blocked-by` and `block --by` require the referenced task to exist, and `rm` / `mv` refuse to remove a task that still blocks active work.

## Configuration

Backend and path are resolved in this order: `--backend` / `--file` flags passed after the command, then `TASKS_AXI_BACKEND` / `TASKS_AXI_FILE` env, then a project `.tasks.toml`, then `~/.tasks-axi/config.toml`, then the defaults.
Without an explicit path, tasks-axi uses `backlog.md` when present, then `data/backlog.md` when present, and otherwise targets `backlog.md` for future writes.

```toml
# .tasks.toml in the project root
backend = "markdown"

[markdown]
path = "data/backlog.md"
archive = "data/done-archive.md"
done_keep = 10
```

`archive` is optional; when omitted, pruned tasks are appended to `done-archive.md` next to the active backlog.

## Backends

P1 ships the **markdown** backend only, behind a narrow `Store` interface so additional backends slot in without touching the CLI layer.

| Backend                | Status  |
| ---------------------- | ------- |
| markdown               | shipped |
| sqlite                 | planned |
| github / jira / linear | planned |

## Development

```sh
pnpm install
pnpm build         # tsc -> dist/
pnpm test          # vitest
pnpm lint          # eslint
pnpm run build:skill -- --check   # fail if the generated skill is stale
```

The installable skill is generated from the same description and help the CLI prints, so it can never drift.

## Contributing

Contributions are welcome.
Human-authored PRs targeting `main` are raised through the [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) gate, which runs review/test/lint/CI before opening the PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and repo conventions.

## License

[MIT](LICENSE) © Kun Chen
