# Stream fixtures

Synthetic `claude -p --output-format stream-json --verbose` sessions. They are **not** recordings of a
real account: each line follows the shapes documented for the `system/init`, `assistant`, `user`,
`rate_limit_event` and `result` messages (Claude Code headless and Agent SDK TypeScript reference,
checked 2026-11-12). Ids, paths and costs are made up.

When a real recording is added, scrub it first (session ids, paths, prompts, file contents) and run
`npm run scrub-check`.
