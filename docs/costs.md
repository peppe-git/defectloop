# Costs and authentication

## Authentication: API key or cloud provider, never a subscription login

defectloop runs agent sessions **only** with:

| `agent.auth` | requires | the agent reports (`system/init` `apiKeySource`) |
|---|---|---|
| `api-key` (default) | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` or `apiKeyHelper` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials | `none` |
| `vertex` | `CLAUDE_CODE_USE_VERTEX=1` + Google Cloud credentials | `none` |
| `foundry` | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials | `none` |

There is no option to use a Claude Pro/Max/Team subscription (`claude login`, `claude setup-token`,
`CLAUDE_CODE_OAUTH_TOKEN`), and the project will not add one. As of 2026-11-12:

- Anthropic's Agent SDK documentation says that, unless previously approved, third-party developers
  may not offer claude.ai login or subscription rate limits in their products, and should use API-key
  authentication instead ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
  [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). defectloop is a
  third-party tool built around the agent.
- The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) forbid automated access except
  through an API key or where Anthropic explicitly permits it, and subscription limits are designed
  around ordinary individual use. An unattended loop running for hours is not clearly within that.
- API keys are governed by the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms),
  under which automated use with your own key is the normal case.

How it is enforced: the supervisor removes `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` from
the session's environment; in `api-key` mode it removes the cloud provider flags too (they would take
precedence over the key); `check` and `run` refuse to start without the key; and on every round the
`apiKeySource` reported by the agent is checked — anything else stops the session and halts the loop.
`agent.verifyAuthSource: false` disables that last check; do not use it unless the agent stopped
reporting the field and you have verified authentication another way.

Re-check the terms yourself: they change.

## How spend is measured

Every session ends with a `result` event whose `total_cost_usd` is the agent's own estimate of what
the session cost. defectloop appends it to `.defectloop/ledger.jsonl`. That number is a
**client-side estimate** computed from token counts and the agent's price table; it is not your
invoice. Your invoice is in the Anthropic Console (or your cloud provider's billing).

When a session reports no cost — killed by the kill switch, the time limit or the silence limit,
crashed — the round is charged **`budget.perRoundUsd`**, the most it was allowed to spend. Accounting
errs on the expensive side.

## Caps

```json
"budget": { "perRoundUsd": 2, "dailyUsd": 10, "monthlyUsd": 100 }
```

- `perRoundUsd` is **required**. It is passed to the agent as `--max-budget-usd`, which stops the
  session when its estimate goes over. The check happens between turns, so a session can end slightly
  above the cap.
- At least one of `dailyUsd` / `monthlyUsd` is **required**. There are no defaults: the loop will not
  start without them.
- **Before every round** the supervisor checks that `spent + perRoundUsd` still fits under each cap.
  If not, it waits until the next day (local midnight) or the next month, or halts if
  `loop.onBudgetExhausted` is `"halt"`.
- Days and months follow the local clock of the machine running the loop.

So the worst case for a day is about `dailyUsd` plus the overshoot of one round. Set a hard spend
limit on the API key in the Console as well: it is the only cap enforced by the party that bills you.

## Rough numbers

A round is a full agentic session: reading code, running tests, editing, committing. Its cost depends
on the model, the size of the repository, the technique and `maxRoundMinutes`. Measure with
`defectloop run --once` and `defectloop status` before choosing the caps; `defectloop report` shows
the cost of each round.
