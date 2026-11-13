# ADR 0004 — A deterministic, UCB-style score instead of a textbook bandit

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

The loop must spend most rounds on techniques that find defects, without ever abandoning the others:
codebases change, and a technique that found nothing last week can find something today.

## Decision

Keep the original score: Bayesian-smoothed yield per round + `c·sqrt(ln(N+1)/(n+1))` exploration +
a waiting bonus; never-run techniques first; the queue gets one round in `queueEvery`; resumptions
always pass. Pure and deterministic (no randomness): the same state gives the same choice, which
makes behaviour testable and explainable in the report. Weights are configurable.

Alternatives considered: Thompson sampling (randomised, harder to explain and test); textbook UCB1
(its assumptions — bounded i.i.d. rewards per arm — do not hold: several findings per round, drifting
distributions).

## Consequences

- No regret guarantee is claimed; docs call it "UCB-style".
- Defaults come from the original project and are not tuned elsewhere.
