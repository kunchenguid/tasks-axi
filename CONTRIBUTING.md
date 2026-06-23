# Contributing

tasks-axi is part of the `*-axi` family and ships through the no-mistakes pipeline.

## Workflow

1. Branch off `main`.
2. Make your change with tests (`test/` mirrors `src/`).
3. Run the full gate locally: `pnpm build && pnpm test && pnpm lint && pnpm run build:skill -- --check`.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …) — release-please reads them to cut releases.
5. Open a PR against `main`.

## Generated files

- `CHANGELOG.md` and `.release-please-manifest.json` are owned by release-please; do not hand-edit them.
- `skills/tasks-axi/SKILL.md` is generated from the CLI's own description and help — regenerate it with `pnpm run build:skill` and commit the result. CI fails if it is stale.

## Fork contributions

Push to your fork and open a PR to the parent repo.
The CI and no-mistakes checks run on the PR.

## License

By contributing you agree your contributions are licensed under the MIT License.
