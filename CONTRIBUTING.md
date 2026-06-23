# Contributing

Thanks for wanting to contribute.
tasks-axi is part of the `*-axi` family.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review/test/lint pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check (`Require no-mistakes`) runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes.
The release and dependency bots are exempt so their automation keeps working, but regular contributor PRs without the signature will not be reviewed or merged.

## Workflow

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:kunchenguid/tasks-axi.git`).
2. Create a branch and make your change with tests (`test/` mirrors `src/`).
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/tasks-axi.git`.
4. Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...) - release-please reads them to cut releases.
5. Push through the gate instead of pushing to `origin`:

   ```sh
   git push no-mistakes
   ```

6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this parent repo for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Node 20+, ESM-only TypeScript compiled with `strict`.
- Run the full gate before pushing: `pnpm build && pnpm lint && pnpm test && pnpm run build:skill -- --check`.
- The CLI layer only talks to the `Store` interface; backends slot in behind it without touching command code.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` - release-please owns them.
- Do not hand-edit `skills/tasks-axi/SKILL.md` - it is generated from the CLI's own description and help by `pnpm run build:skill`. Regenerate and commit it after changing the description or top-level help; CI fails if it is stale.

## Release and Packaging

Releases are cut by release-please from Conventional Commits on `main`.
When a release is created, the release workflow installs dependencies, builds, lints, tests, checks generated skill drift, and publishes with `npm publish --access public --provenance`.

The npm package intentionally ships runtime JavaScript only.
Keep `package.json` `files` limited to `dist/**/*.js`, `skills/tasks-axi`, `LICENSE`, and `README.md`; TypeScript declarations and source maps stay local for development.

`prepack` runs `npm run build`, so `npm pack`, `npm publish`, and `npm publish --dry-run` rebuild `dist` first.
From a fresh clone, install dependencies with `pnpm install --frozen-lockfile` before any manual pack or publish, since that build step needs `node_modules` (this matches how CI and the release workflow install).
Then verify the package with `npm pack --dry-run` and keep the CLI bin as `dist/bin/tasks-axi.js` so npm preserves it without warnings.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
