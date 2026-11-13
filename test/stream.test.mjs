// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStreamMonitor } from "../src/stream.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/streams/${name}`, import.meta.url), "utf8").split("\n");
const feed = (lines) => {
  const m = createStreamMonitor();
  for (const l of lines) m.push(l);
  return m.summary();
};

test("a recorded-shape successful session is understood", () => {
  const s = feed(fixture("success.jsonl"));
  assert.deepEqual(s.problems, []);
  assert.equal(s.init.apiKeySource, "ANTHROPIC_API_KEY");
  assert.equal(s.init.sessionId, "00000000-0000-4000-8000-000000000001");
  assert.equal(s.result.isError, false);
  assert.equal(s.result.costUsd, 0.4213);
  assert.equal(s.result.numTurns, 12);
  assert.ok(s.counts.json >= 4);
});

test("unknown event types are tolerated and counted (the format grows additively)", () => {
  const s = feed([...fixture("success.jsonl"), JSON.stringify({ type: "brand_new_event", x: 1 })]);
  assert.deepEqual(s.problems, []);
  assert.equal(s.counts.unknownTypes, 1);
});

test("a rejected rate limit event yields the reset instant; seconds and milliseconds both work", () => {
  const s = feed(fixture("rate-limited.jsonl"));
  assert.deepEqual(s.problems, []);
  assert.equal(s.rateLimit.status, "rejected");
  assert.equal(s.rateLimit.resetsAtMs, 1793000000 * 1000);
  const ms = feed([fixture("success.jsonl")[0], JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793000000123 } })]);
  assert.equal(ms.rateLimit.resetsAtMs, 1793000000123);
});

test("an allowed rate limit event is not a limit", () => {
  const s = feed([fixture("success.jsonl")[0], JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1 } })]);
  assert.equal(s.rateLimit, null);
  assert.deepEqual(s.problems, []);
});

test("unrecognized formats are problems, not guesses", () => {
  const init = fixture("success.jsonl")[0];
  const cases = {
    "plain text on stdout": ["Error: something went wrong"],
    "json that is not an object": [init, "[1,2,3]"],
    "event without a type": [init, JSON.stringify({ kind: "result" })],
    "result without a numeric cost": [init, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })],
    "result with a string cost": [init, JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: "0.4" })],
    "rate limit event with a new shape": [init, JSON.stringify({ type: "rate_limit_event", limit: { state: "blocked" } })],
    "rejected rate limit without a reset": [init, JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })],
    "init without a session id": [JSON.stringify({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })],
  };
  for (const [name, lines] of Object.entries(cases)) {
    assert.ok(feed(lines).problems.length > 0, `expected a problem for: ${name}`);
  }
});

test("no init event within the first events is a problem", () => {
  const lines = Array.from({ length: 30 }, () => JSON.stringify({ type: "assistant", message: { content: [] } }));
  assert.match(feed(lines).problems.join(" "), /init/);
});

test("an empty stream has no problems and no result (a crash, not a format change)", () => {
  const s = feed(["", "   "]);
  assert.deepEqual(s.problems, []);
  assert.equal(s.result, null);
  assert.equal(s.counts.json, 0);
});

test("api retries are counted", () => {
  const init = fixture("success.jsonl")[0];
  const s = feed([init, JSON.stringify({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 })]);
  assert.equal(s.apiRetries, 1);
});

test("push returns the parsed event so callers can journal it", () => {
  const m = createStreamMonitor();
  const e = m.push(fixture("success.jsonl")[0]);
  assert.equal(e.type, "system");
  assert.equal(m.push("not json"), null);
});
