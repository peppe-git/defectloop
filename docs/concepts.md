# Concepts

## Round

A **round** is one agent session, started fresh: no conversation carried over, no compaction, no
memory except what the supervisor writes into the round's context file. Rounds are numbered
`round-0001`, `round-0002`, … For each round the state directory keeps:

| file | written by | content |
|---|---|---|
| `rounds/round-NNNN.context.md` | supervisor | what the round was told (campaign, environment, budget, record) |
| `rounds/round-NNNN.jsonl` | supervisor | the full stream-json transcript |
| `rounds/round-NNNN.outcome.json` | agent | what the round reports ([schema](../schemas/outcome.schema.json)) |
| `rounds.jsonl` (one line per round) | supervisor | the round record ([schema](../schemas/round-record.schema.json)) |
| `findings.jsonl` | supervisor | every finding, normalised, with a fingerprint |
| `ledger.jsonl` | supervisor | the cost charged for every round |

A round ends in one of these **statuses** (`src/limits.mjs`):

| status | meaning | what the loop does next |
|---|---|---|
| `completed` | an outcome file was written | continue |
| `timeout` | `loop.maxRoundMinutes` reached, no outcome | continue (the technique counts as tried) |
| `round-budget-exhausted` | the session hit its own `--max-budget-usd` | continue |
| `stalled` | no event for `loop.maxSilenceMinutes` | back off; counts as a failure |
| `no-outcome` | the session ended without writing the outcome | back off; failure |
| `crashed` | no result event at all (binary missing, crash) | back off; failure |
| `overloaded` | API overloaded or network error | back off; failure; the campaign is resumed first |
| `rate-limited` | a structured rate limit with a reset time | wait until the reset (+2 min); resume the campaign |
| `rate-limited` (no reset) | a rate limit described only in text | back off; failure |
| `stopped` | kill switch | stop |
| `format-unrecognized` | stream-json not understood | **halt** |
| `auth-policy` | the agent is not using an API key (api-key mode) | **halt** |
| `auth-error` | invalid key or authentication failure | **halt** |

After `loop.maxConsecutiveFailures` failures in a row the loop **halts**. A halt is persisted in
`state.json`; the loop refuses to start again until `defectloop resume`.

## Technique and catalog

A **technique** is a way of looking for defects, written as instructions for the agent: "deep review
of one area", "behaviour no test pins down", "review of recent commits"… You provide them in a
**catalog** (`defectloop.catalog.json`, [schema](../schemas/catalog.schema.json),
[guide](guides/writing-a-catalog.md)). A technique can:

- `requires` capabilities (`docker`, `staging-db`…) that the supervisor probes before each round;
- work `perArea`: the round gets the least covered area of a kind (see below);
- have a `maxPerDay` cap;
- be `internal`: never chosen by the scheduler (the built-in `cleanup`).

## Area

An **area** is a part of the codebase a technique can focus on. `areas.discover` turns every
subdirectory of a directory into an area of a kind (`{ "dir": "src", "kind": "code" }` makes
`src/auth`, `src/billing`… areas of kind `code`); `areas.list` adds areas by hand. The supervisor
remembers, per technique, the last round that covered each area, and gives the next round the least
covered one; ties go to `areas.priority`, then to the listing order.

## Campaign

The **campaign** of a round is a technique, optionally an area, and the reason it was chosen. Rules,
in order (`pickCampaign` in `src/scheduler.mjs`):

1. **Leftovers first.** If an interrupted round left uncommitted changes (files that were not dirty
   when the loop started), the round is a `cleanup` campaign.
2. **Queue, one round in three.** Rounds can propose follow-ups (variants of a defect they just
   found). A queued item runs when `(round - 1) % scoring.queueEvery == 0`, so the queue cannot
   monopolise the loop. A **resumption** of a round interrupted by a rate limit or an overload always
   passes.
3. **Never run.** An eligible technique that never ran goes first, in catalog order.
4. **Highest score.**

The choice is deterministic: same state, same campaign.

## Score

```
score = yield + explorationWeight · sqrt( ln(N + 1) / (n + 1) ) + waitWeight · waiting

yield   = (weighted findings + 1) / (n + dismissedPenalty · dismissed + 2)
waiting = min(1, (current round − last round of the technique) / (2 · eligible techniques))
```

- `n` is the number of rounds the technique ran, `N` the total over all techniques.
- **Weighted findings**: `fixed` 1, `proposed` 0.7, `unverified` 0.2, `dismissed` 0.
- **Yield** is a Bayesian-smoothed mean per round (a Beta-like prior of one success in two rounds):
  a technique with no history starts at 0.5, and one that dries up sinks on its own because the
  yield is per round, not cumulative. False alarms (`dismissed`) weigh a little against it.
- **Exploration** is the UCB1 bonus shape: it grows slowly with the total number of rounds and
  shrinks with the technique's own, so no technique leaves the rotation for ever.
- **Waiting** rewards techniques that have not run for a while.

### Why "UCB-style" and not UCB1

UCB1 assumes rewards in [0, 1] drawn independently from a fixed distribution per arm, and gives a
regret bound under those assumptions. None of them holds here: a round can report several findings,
the codebase changes under the loop (yesterday's defects get fixed, so the distribution drifts), and
the waiting bonus is not part of UCB at all. The score keeps the useful shape — optimism in the face
of uncertainty, exploration that never reaches zero — without claiming the theorem. The defaults
(`0.5`, `0.3`, `0.15`, one queue round in three) come from the loop this tool was extracted from;
they have not been tuned on other projects. Change them in `scoring`.

## Outcome

The agent ends every round by writing an outcome file: a summary, findings (title, status, severity,
category, location, evidence, commit), follow-ups, optionally a proposed technique. The supervisor
**normalises** it (unknown fields dropped, invalid enum values repaired to `unverified` / `medium` /
`other`, strings truncated, at most 40 findings and 3 follow-ups) and never trusts it further.

Each finding gets a **fingerprint** (category + file + the significant words of the title, sorted),
so the same defect reported by two rounds is recorded as a duplicate unless it was fixed.

Proposed techniques are written by the agent, so they are treated as untrusted: they appear in the
report and are added to the catalog (`catalog-extra.json`) only when `loop.acceptProposedTechniques`
is true.

## Foreign files and commits

When the loop starts, every file already modified in the working tree is **foreign**: someone else's
work in progress. The context lists them and tells the agent not to touch them; the guard's
shared-working-tree rule blocks `git add -A`, `git commit -a` and commits without a pathspec while
files are being modified. Commits of a round carry the trailer `Defectloop-Round: round-NNNN`, which
is how the supervisor attributes them.

## Kill switch, pause, halt, wait

| | how | effect | cleared by |
|---|---|---|---|
| kill switch | `defectloop stop` (file `.defectloop/STOP`), `stop --global` (user-wide file), SIGTERM/SIGINT | the running session is stopped within `loop.watchdogMs`; the loop exits 0 and does not start again | `defectloop resume` |
| pause | `defectloop pause` | the current round finishes, then the loop waits | `defectloop resume` |
| halt | the supervisor, on something it does not understand or too many failures | the loop exits 0 and refuses to start | `defectloop resume` (after fixing the cause) |
| wait | rate limit, backoff, budget | the loop sleeps until a time, checking the kill switch | the time, or `defectloop resume` |
