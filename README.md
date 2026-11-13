# defectloop

> Status: **0.1.0-SNAPSHOT**, not yet published on npm.

defectloop runs a coding agent **unattended**, one fresh session per **round**, and decides before
every round **which audit technique** to apply and where. Rounds hunt for real defects, fix the
contained ones in local commits with a test, and write a structured outcome. A deterministic guard
sits between the agent and your machine, a mandatory spend cap sits between the agent and your
bill, and anything the supervisor does not understand stops the loop instead of retrying for ever.

```
defectloop run ─► preflight ─► round 1 ─► round 2 ─► … ─► stop | halt | wait
                                 │
     scheduler picks a technique ─┤ (yield per round + exploration + waiting bonus)
     context.md + prompt ─────────┤
     claude -p --output-format stream-json (API key) ─► stream monitor ─► outcome.json
     PreToolUse guard on every tool call ─┘          cost → ledger, caps checked before each round
```

## What it solves

Running `claude -p` in a `while true` loop is easy. Running it for hours without supervision is not:
the same technique gets run over and over, sessions hang, rate limits turn into tight retry loops,
the output format changes under you, costs drift, and one careless command can push, delete or
leak. defectloop is the supervisor around that loop:

- a **catalog of techniques** you write (deep review, test gaps, failure paths, recent commits…), and
  a scheduler that runs the ones that pay off more often without ever dropping the others;
- a **queue** of follow-ups proposed by rounds, and resumption of interrupted rounds;
- a **guard** (Claude Code `PreToolUse` hook) with a shell tokenizer and prudent, configurable rules;
- **spend accounting** from the cost each session reports, with caps per round, day and month;
- **fail-safe** handling of the stream-json output: unknown shapes halt the loop;
- a **kill switch** (project and user-wide), pause, and a persistent halt that only you can clear;
- a structured **round record** and **findings record**, deduplicated, with a Markdown report.

## Quickstart

Requirements: Node 22+, git, the [Claude Code CLI](https://code.claude.com/docs/en/cli-reference),
an **Anthropic API key** (or Bedrock / Vertex / Foundry credentials). Subscription logins are not
supported: see [docs/costs.md](docs/costs.md).

```bash
cd your-repository
npx defectloop init            # writes defectloop.config.json and defectloop.catalog.json
echo ".defectloop/" >> .gitignore
export ANTHROPIC_API_KEY=...   # a key with a spend limit set in the Console
npx defectloop check           # offline: config, catalog, git, CLI flags, key, guard self-test
npx defectloop run --once      # one round in the foreground
npx defectloop run             # until stopped, halted or out of budget
```

(Not on npm yet: until it is, run `node path/to/defectloop/bin/defectloop.mjs`.)

Day to day:

```bash
defectloop status              # what it is doing now, spend, last rounds, alerts
defectloop report              # .defectloop/REPORT.md: findings by severity, yield per technique
defectloop search "word word"  # has this already been found?
defectloop pause | resume
defectloop stop                # kill switch: the session is stopped within seconds
defectloop stop --global       # every loop of this user
```

Review the loop's commits before publishing anything:
`git log --grep='Defectloop-Round:'`. Publishing stays your decision; the guard blocks the agent from
doing it.

## Guarantees

- The agent session never receives `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`; in `api-key`
  mode a session whose `system/init` event does not report an API key is stopped and the loop halts.
- No round starts unless a whole round (`budget.perRoundUsd`) still fits under the daily and monthly
  caps. A round that reports no cost is charged the per-round cap.
- An unrecognised stream (non-JSON output, missing `system/init`, `result` without a numeric
  `total_cost_usd`, a `rate_limit_event` of unknown shape) halts the loop. Halts persist across
  restarts until `defectloop resume`.
- After `loop.maxConsecutiveFailures` failed rounds in a row the loop halts.
- The kill switch is checked every `loop.watchdogMs` during a round and is not writable by the agent.
- The guard blocks what it recognises, by default: publishing, destructive git/file/system commands,
  network outside an allow-list, reading or writing secret files, writing outside the repository and
  temporary directories, touching the loop's own configuration and state.

## Non-guarantees

- **The guard is not a sandbox.** The agent runs with your user's permissions. A test suite, a build
  script, `node -e`, a Makefile target or any program can open sockets, delete files or read secrets
  without going through a command the guard recognises. Run the loop as a dedicated user, in a
  container or a VM, for anything you cannot afford to lose. See [docs/security.md](docs/security.md).
- **Costs are estimates.** `total_cost_usd` is computed by the client; `--max-budget-usd` can be
  overshot slightly. Set a spend limit on the API key itself.
- **Findings are the agent's claims.** The loop records them; it does not verify them.
- **The stream format is not stable.** defectloop stops when it does not recognise it, which means a
  CLI update can halt your loop until defectloop is updated.
- The Agent SDK adapter is **experimental** and has only been tested against a fake SDK. Windows is
  untested.

## Compared with

| | defectloop | `while true; claude -p` | Claude Code GitHub Action on a schedule | SWE-agent / OpenHands |
|---|---|---|---|---|
| Chooses what to audit next | yes (catalog + scheduler) | no | no (one prompt) | no (one issue) |
| Deterministic tool guard | yes (configurable) | whatever you write | CI sandbox + permissions | sandbox |
| Spend caps across runs | per round, day, month | no | per run | per run |
| Behaviour on unknown output | halts | loops | n/a | n/a |
| Runs where | your machine / server | your machine | GitHub runners | container |

Static analysers (Semgrep, CodeQL) are complementary: deterministic, not agentic; a technique in the
catalog can run them.

## Documentation

- [Concepts](docs/concepts.md): round, technique, campaign, score, UCB, queue, outcome.
- [Configuration](docs/configuration.md) and the JSON schemas in [schemas/](schemas/).
- [Security](docs/security.md): what the guard blocks and what it cannot block. [SECURITY.md](SECURITY.md).
- [Costs and authentication](docs/costs.md).
- Guides: [running as a service](docs/guides/running-as-a-service.md),
  [writing a catalog](docs/guides/writing-a-catalog.md).
- [Architecture decisions](docs/adr/).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). "Claude" and "Claude Code" are trademarks of
Anthropic; this project is not affiliated with or endorsed by Anthropic.
