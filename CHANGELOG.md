# Changelog

## [0.2.3](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.2...tasks-axi-v0.2.3) (2026-07-13)


### Features

* add durable public follow-up obligations ([#16](https://github.com/kunchenguid/tasks-axi/issues/16)) ([d7845d3](https://github.com/kunchenguid/tasks-axi/commit/d7845d3b3dc1cbf084909e127c1a65f3abac2fce))

## [0.2.2](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.1...tasks-axi-v0.2.2) (2026-07-10)


### Features

* move linked task sets atomically ([#13](https://github.com/kunchenguid/tasks-axi/issues/13)) ([f75ebbd](https://github.com/kunchenguid/tasks-axi/commit/f75ebbd9faf92c1eb4cc8aa958ad5f37607ea677))

## [0.2.1](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.2.0...tasks-axi-v0.2.1) (2026-07-10)


### Bug Fixes

* **markdown:** preserve blank lines in task bodies ([#11](https://github.com/kunchenguid/tasks-axi/issues/11)) ([0229c56](https://github.com/kunchenguid/tasks-axi/commit/0229c5611b7ab23b8ff54cf08c7ca337b508f840))

## [0.2.0](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.2...tasks-axi-v0.2.0) (2026-07-08)


### ⚠ BREAKING CHANGES

* **commands:** tasks-axi update no longer accepts --append. Agents must inspect the current body and replace it with --body or --body-file, optionally passing --archive-body to preserve the superseded body in note-archive.md.

### Features

* add structured task holds ([#8](https://github.com/kunchenguid/tasks-axi/issues/8)) ([0f283ed](https://github.com/kunchenguid/tasks-axi/commit/0f283ed3d988a7ecd9cd12d325ac4b5f4f68007b))
* **commands:** replace append notes with body replacement archival ([#10](https://github.com/kunchenguid/tasks-axi/issues/10)) ([a7993d2](https://github.com/kunchenguid/tasks-axi/commit/a7993d2a8e8b56f1f66d125fd057de1587b62c80))

## [0.1.2](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.1...tasks-axi-v0.1.2) (2026-06-29)


### Features

* **cli:** add confirmation-forward mutation output ([#6](https://github.com/kunchenguid/tasks-axi/issues/6)) ([6d39143](https://github.com/kunchenguid/tasks-axi/commit/6d39143e14bfef6711a31371129343b23f97bf0e))

## [0.1.1](https://github.com/kunchenguid/tasks-axi/compare/tasks-axi-v0.1.0...tasks-axi-v0.1.1) (2026-06-23)


### Features

* add markdown-backed tasks-axi CLI ([#1](https://github.com/kunchenguid/tasks-axi/issues/1)) ([239b320](https://github.com/kunchenguid/tasks-axi/commit/239b32046222c1e176390e592f28232f2dc69684))
* **backends:** round-trip firstmate backlog format ([#4](https://github.com/kunchenguid/tasks-axi/issues/4)) ([891555c](https://github.com/kunchenguid/tasks-axi/commit/891555ccb7e694e359ab9b2c0f70f5f2af3c065d))
