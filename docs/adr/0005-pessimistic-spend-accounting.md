# ADR 0005 — Spend from the agent's reported cost, with mandatory caps and pessimistic charging

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

The original loop measured the spend of the product's own AI features in the product's database.
That is specific to one product; what any user of this tool pays is the agent's own consumption.

## Decision

- The ledger records `total_cost_usd` from each session's `result` event.
- `budget.perRoundUsd` and at least one of `dailyUsd` / `monthlyUsd` are required; no defaults.
- `perRoundUsd` is passed as `--max-budget-usd`.
- A round starts only if `spent + perRoundUsd` fits under every cap.
- A round without a reported cost is charged `perRoundUsd`; an unreadable ledger line is charged the
  same.

## Consequences

- The ledger can overstate spend (killed rounds); it should never understate it, within the limits of
  a client-side estimate. Users are told to set a spend limit on the key itself.
