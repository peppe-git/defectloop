# ADR 0002 — Halt when the stream-json output is not recognised

- Status: accepted (v0.1)
- Date: 2026-11-12

## Context

The supervisor depends on three things in the agent's stream-json output: the `system/init` event
(authentication source, session id), the final `result` event (cost, error) and `rate_limit_event`
(when to resume). Anthropic documents these shapes but gives no stability guarantee. The original
loop parsed rate-limit messages from free text ("resets 3pm"), which breaks silently when wording
changes; a broken parser in a loop means retrying every few minutes for hours, or never waiting.

## Decision

- New event types are tolerated and counted: the format grows additively.
- The events the supervisor depends on must have the known shape. Otherwise the stream monitor
  records a *problem*: a non-JSON line, an event without a string `type`, no `system/init` within the
  first 20 events, `system/init` without `session_id`, `result` without boolean `is_error` or numeric
  `total_cost_usd`, `rate_limit_event` without `rate_limit_info.status`, a rejected limit without a
  numeric `resetsAt`.
- Any problem stops the session and **halts** the loop (persisted; cleared only by `resume`).
- A rate-limit reset further away than `loop.maxWaitHours` is not trusted: halt.
- Text-only failures (429, overloaded) get a bounded exponential backoff and count towards
  `maxConsecutiveFailures`, after which the loop halts.
- `check` verifies offline that the installed CLI lists every flag the adapter uses.

## Consequences

- A CLI update that changes the format halts the loop until defectloop is updated. Preferred over a
  loop that keeps running on guesses.
- Fixtures in `test/fixtures/streams/` are synthetic, built from the documented shapes; a recorded,
  scrubbed session should be added when one is available.
