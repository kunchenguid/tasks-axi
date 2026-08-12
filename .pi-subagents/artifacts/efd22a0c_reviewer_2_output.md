## Review
- **Correct:** Backend precedence and inactive-config isolation are implemented in `src/config.ts:489-540`; tests cover both directions in `test/config.test.ts:175-245`.
- **Correct:** Markdown link normalization was moved without semantic change (`src/backends/markdown-grammar.ts:175-213`, `src/backends/markdown.ts:213-217`), and Markdown advertises file moves at `src/backends/markdown.ts:296-308`.
- **Correct:** ADO CLI moves fail before destination access through capability gating at `src/commands/state.ts:702-709`, covered by `test/commands/state.test.ts:802-850`.
- **Note (low):** With only `TASKS_AXI_ADO_AREA` set, `resolveAdo` returns `undefined` at `src/config.ts:393`, causing the misleading “needs an `[ado]` config table” error from `src/context.ts:54-61`. It should instead report missing `org` and `project`, consistent with other partial ADO configurations.
- **Blocker:** None.
- **Note:** Tests were not run, as requested. No source-content-only test guards `.tasks.toml.example:16` against accidentally changing the shipped default from Markdown.