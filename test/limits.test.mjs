// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffUntil, checkAuthSource, classifyRoundEnd, nextAction } from "../src/limits.mjs";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const okInit = { sessionId: "s", apiKeySource: "ANTHROPIC_API_KEY" };
const summary = (extra = {}) => ({ init: okInit, result: null, rateLimit: null, problems: [], counts: { json: 3, nonJson: 0 }, apiRetries: 0, ...extra });
const result = (extra = {}) => ({ subtype: "success", isError: false, text: "", costUsd: 0.1, numTurns: 3, ...extra });
const auth = { mode: "api-key", verify: true };
const end = (args) => classifyRoundEnd({ authPolicy: auth, now: NOW, maxWaitMs: 24 * 60 * MIN, exitCode: 0, killedReason: null, stderrTail: "", outcome: null, ...args });

test("auth source: api-key mode accepts only key-based sources", () => {
  assert.equal(checkAuthSource({ apiKeySource: "ANTHROPIC_API_KEY" }, auth), null);
  assert.equal(checkAuthSource({ apiKeySource: "apiKeyHelper" }, auth), null);
  assert.match(checkAuthSource({ apiKeySource: "/login managed key" }, auth), /subscription|login/i);
  assert.match(checkAuthSource({ apiKeySource: "none" }, auth), /none/);
  assert.match(checkAuthSource({}, auth), /missing|cannot verify/i);
  // cloud providers report "none" by design
  assert.equal(checkAuthSource({ apiKeySource: "none" }, { mode: "bedrock", verify: true }), null);
  assert.equal(checkAuthSource({ apiKeySource: "/login managed key" }, { mode: "bedrock", verify: true }) !== null, true);
  // verification can be switched off explicitly
  assert.equal(checkAuthSource({}, { mode: "api-key", verify: false }), null);
});

test("classification order: stop, format, auth, outcome", () => {
  assert.equal(end({ killedReason: "stop", outcome: { findings: [] } }).kind, "stopped");
  assert.equal(end({ summary: summary({ problems: ["bad"] }), outcome: { findings: [] } }).kind, "format-unrecognized");
  assert.equal(end({ summary: summary({ init: { sessionId: "s", apiKeySource: "none" } }), outcome: { findings: [] } }).kind, "auth-policy");
  assert.equal(end({ summary: summary({ result: result() }), outcome: { findings: [] } }).kind, "completed");
  assert.equal(end({ summary: summary({ result: result() }), killedReason: "timeout", outcome: { findings: [] } }).kind, "completed");
});

test("halting kinds", () => {
  for (const s of [summary({ problems: ["x"] }), summary({ init: { sessionId: "s", apiKeySource: "/login managed key" } })]) {
    const e = end({ summary: s });
    assert.equal(e.halt, true, e.kind);
    assert.equal(nextAction(e, { consecutiveFailures: 0, now: NOW }).action, "halt");
  }
  const badKey = end({ summary: summary({ result: result({ isError: true, text: "Invalid API key · Please run /login" }) }), exitCode: 1 });
  assert.equal(badKey.kind, "auth-error");
  assert.equal(nextAction(badKey, { consecutiveFailures: 0, now: NOW }).action, "halt");
});

test("timeouts and stalls without an outcome", () => {
  assert.equal(end({ summary: summary(), killedReason: "timeout" }).kind, "timeout");
  assert.equal(end({ summary: summary(), killedReason: "silence" }).kind, "stalled");
  assert.equal(nextAction(end({ summary: summary(), killedReason: "timeout" }), { consecutiveFailures: 0, now: NOW }).action, "continue");
});

test("structured rate limit: wait until the reset plus a margin", () => {
  const e = end({ summary: summary({ rateLimit: { status: "rejected", resetsAtMs: NOW + 60 * MIN }, result: result({ isError: true }) }), exitCode: 1 });
  assert.equal(e.kind, "rate-limited");
  assert.equal(e.resumeAt, NOW + 60 * MIN);
  const a = nextAction(e, { consecutiveFailures: 0, now: NOW });
  assert.deepEqual([a.action, a.until, a.countsAsFailure], ["wait", NOW + 62 * MIN, false]);
});

test("a reset too far in the future is not trusted: halt instead of sleeping for days", () => {
  const e = end({ summary: summary({ rateLimit: { status: "rejected", resetsAtMs: NOW + 30 * 24 * 60 * MIN } }) });
  assert.equal(e.halt, true);
  assert.equal(nextAction(e, { consecutiveFailures: 0, now: NOW }).action, "halt");
});

test("a reset in the past falls back to backoff", () => {
  const e = end({ summary: summary({ rateLimit: { status: "rejected", resetsAtMs: NOW - MIN } }) });
  assert.equal(e.kind, "rate-limited");
  assert.equal(e.resumeAt, null);
  const a = nextAction(e, { consecutiveFailures: 0, now: NOW });
  assert.equal(a.action, "wait");
  assert.equal(a.countsAsFailure, true);
});

test("text-only failures: rate limit, overload, crash, missing outcome", () => {
  assert.equal(end({ summary: summary({ result: result({ isError: true, text: "API Error: 429 Too Many Requests" }) }), exitCode: 1 }).kind, "rate-limited");
  assert.equal(end({ summary: summary({ result: result({ isError: true, text: "API Error: 529 overloaded_error" }) }), exitCode: 1 }).kind, "overloaded");
  assert.equal(end({ summary: summary({ init: null, counts: { json: 0, nonJson: 0 } }), exitCode: 1, stderrTail: "spawn ENOENT" }).kind, "crashed");
  assert.equal(end({ summary: summary({ result: result() }) }).kind, "no-outcome");
  assert.equal(end({ summary: summary({ result: result({ subtype: "error_max_budget_usd", isError: true }) }) }).kind, "round-budget-exhausted");
});

test("failures back off exponentially and halt after too many in a row", () => {
  const e = end({ summary: summary({ result: result() }) }); // no-outcome
  const first = nextAction(e, { consecutiveFailures: 0, now: NOW, maxConsecutiveFailures: 3 });
  assert.equal(first.action, "wait");
  assert.equal(first.until, NOW + 2 * MIN);
  assert.equal(nextAction(e, { consecutiveFailures: 1, now: NOW, maxConsecutiveFailures: 3 }).until, NOW + 4 * MIN);
  const third = nextAction(e, { consecutiveFailures: 2, now: NOW, maxConsecutiveFailures: 3 });
  assert.equal(third.action, "halt");
  assert.match(third.reason, /3 consecutive/);
});

test("backoff has a ceiling", () => {
  assert.equal(backoffUntil("crashed", 20, NOW), NOW + 60 * MIN);
  assert.equal(backoffUntil("rate-limited", 20, NOW), NOW + 120 * MIN);
  assert.equal(backoffUntil("overloaded", 1, NOW), NOW + 3 * MIN);
});

test("a round that hit its own spend cap is not a failure", () => {
  const e = end({ summary: summary({ result: result({ subtype: "error_max_budget_usd", isError: true }) }) });
  const a = nextAction(e, { consecutiveFailures: 2, now: NOW, maxConsecutiveFailures: 3 });
  assert.equal(a.action, "continue");
  assert.equal(a.countsAsFailure, false);
});
