# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Supervisor running one fresh headless agent session per round, with round time and silence limits,
  backoff, halts persisted across restarts, pause, and a project-wide and user-wide kill switch.
- Scheduler choosing a technique (and an area) per round: leftovers cleanup, queue one round in
  three, never-run techniques, then a Bayesian yield + UCB-style exploration + waiting score.
- User-supplied technique catalog with a JSON Schema and strict validation; generic example catalog
  and prompt template.
- Stream-json monitor that halts the loop on output it does not recognise.
- Spend accounting from the reported `total_cost_usd`, with mandatory per-round, daily and/or monthly
  caps; rounds without a reported cost are charged the per-round cap.
- API-key-only authentication: subscription and bearer tokens are removed from the session, and the
  authentication source reported by the agent is verified every round.
- `PreToolUse` guard with a shell tokenizer and configurable rules: publishing, destructive commands,
  network allow-list, read-only ssh, secrets, protected paths, tools, shared working tree.
- `claude-cli` adapter; experimental `agent-sdk` adapter.
- Outcome and round-record schemas, findings record with fingerprints, Markdown report, search.
- CLI: `init`, `check`, `run`, `status`, `report`, `search`, `pause`, `resume`, `stop`, `service`,
  `guard`.
