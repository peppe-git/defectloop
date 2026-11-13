// SPDX-License-Identifier: Apache-2.0
//
// How a round ended, and what the loop does next. Pure: the supervisor passes in the stream summary,
// the exit code, why it killed the session (if it did) and the outcome; these functions decide.
//
// Principle: understood problems get a bounded, explained wait; anything not understood stops the
// loop (halt) instead of retrying for ever.

const MIN = 60_000;

/** Sources the agent may report in system/init when authentication must be an API key. */
export const API_KEY_SOURCES = ["ANTHROPIC_API_KEY", "apiKeyHelper"];
export const CLOUD_MODES = ["bedrock", "vertex", "foundry"];

/**
 * Checks the authentication the agent says it is using against the configured mode.
 * @returns {string|null} why it is not acceptable, or null
 */
export function checkAuthSource(init, { mode = "api-key", verify = true } = {}) {
  if (!verify) return null;
  const src = init?.apiKeySource;
  if (CLOUD_MODES.includes(mode)) {
    // Cloud provider credentials win over everything else and the agent reports "none" for them.
    return src === undefined || src === "none" ? null : `auth mode is ${mode} but the agent reports apiKeySource "${src}"`;
  }
  if (src === undefined) return "the agent's init event has no apiKeySource: cannot verify that an API key is in use";
  if (API_KEY_SOURCES.includes(src)) return null;
  if (src === "/login managed key") return 'the agent is using a claude.ai login (apiKeySource "/login managed key"); defectloop only runs with an API key';
  return `the agent reports apiKeySource "${src}"; with auth "api-key" only ${API_KEY_SOURCES.join(" or ")} are accepted (a subscription token reports "none")`;
}

const AUTH_RE = /invalid api key|invalid x-api-key|authentication_error|failed to authenticate|not logged in|please run \/login|\b401\b|unauthorized/i;
const RATE_RE = /rate.?limit|too many requests|\b429\b|usage limit|limit reached/i;
const OVERLOAD_RE = /overloaded|\b529\b|\b50[0234]\b|api_error|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network error|socket hang up/i;

/**
 * Classifies the end of a round.
 * @returns {{ kind: string, halt: boolean, resumeAt?: number|null, detail: string }}
 */
export function classifyRoundEnd({ summary, exitCode = 0, killedReason = null, stderrTail = "", outcome = null, authPolicy = {}, now = Date.now(), maxWaitMs = 24 * 60 * MIN }) {
  const s = summary ?? { init: null, result: null, rateLimit: null, problems: [], counts: { json: 0 } };
  if (killedReason === "stop") return { kind: "stopped", halt: false, detail: "kill switch" };
  if (s.problems?.length) return { kind: "format-unrecognized", halt: true, detail: `stream format not recognized: ${s.problems.slice(0, 3).join("; ")}` };
  if (s.init) {
    const why = checkAuthSource(s.init, authPolicy);
    if (why) return { kind: "auth-policy", halt: true, detail: why };
  }
  if (outcome) return { kind: "completed", halt: false, detail: "" };
  if (killedReason === "timeout") return { kind: "timeout", halt: false, detail: "round time limit reached" };
  if (killedReason === "silence") return { kind: "stalled", halt: false, detail: "no events for too long" };

  if (s.rateLimit) {
    const at = s.rateLimit.resetsAtMs;
    if (at > now + maxWaitMs) {
      return { kind: "rate-limited", halt: true, resumeAt: null, detail: `rate limit reset at ${new Date(at).toISOString()} is further away than loop.maxWaitHours: not trusted` };
    }
    return { kind: "rate-limited", halt: false, resumeAt: at > now ? at : null, detail: `rate limit (${s.rateLimit.type ?? "unknown type"})` };
  }

  const r = s.result;
  if (r?.subtype === "error_max_budget_usd") return { kind: "round-budget-exhausted", halt: false, detail: "the round reached its own spend cap" };
  const text = `${r?.isError ? r.text : ""}\n${stderrTail ?? ""}`;
  if (r?.isError || exitCode !== 0) {
    if (AUTH_RE.test(text)) return { kind: "auth-error", halt: true, detail: firstLine(text) };
    if (RATE_RE.test(text)) return { kind: "rate-limited", halt: false, resumeAt: null, detail: firstLine(text) };
    if (OVERLOAD_RE.test(text)) return { kind: "overloaded", halt: false, detail: firstLine(text) };
  }
  if (!r) return { kind: "crashed", halt: false, detail: firstLine(stderrTail) || `agent exited with code ${exitCode} without a result` };
  return { kind: "no-outcome", halt: false, detail: "the session ended without writing an outcome" };
}

function firstLine(s) {
  return String(s ?? "").trim().split("\n").find(Boolean)?.slice(0, 300) ?? "";
}

const BACKOFF_BASE_MIN = { "rate-limited": 20, overloaded: 3, stalled: 5, "no-outcome": 2, crashed: 2 };

/** Exponential backoff after `failures` consecutive failures (>= 1), with a ceiling. */
export function backoffUntil(kind, failures, now) {
  const base = BACKOFF_BASE_MIN[kind] ?? 2;
  const ceiling = kind === "rate-limited" ? 120 : 60;
  return now + Math.min(base * 2 ** Math.max(0, failures - 1), ceiling) * MIN;
}

/**
 * What the loop does after a round.
 * @param {{ kind: string, halt: boolean, resumeAt?: number|null, detail: string }} end
 * @param {{ consecutiveFailures: number, now: number, maxConsecutiveFailures?: number, resetMarginMs?: number }} ctx
 * @returns {{ action: "continue"|"wait"|"halt"|"stop", until?: number, reason: string, countsAsFailure: boolean }}
 */
export function nextAction(end, { consecutiveFailures = 0, now, maxConsecutiveFailures = 3, resetMarginMs = 2 * MIN }) {
  if (end.kind === "stopped") return { action: "stop", reason: "kill switch", countsAsFailure: false };
  if (end.halt) return { action: "halt", reason: `${end.kind}: ${end.detail}`, countsAsFailure: false };
  if (["completed", "timeout", "round-budget-exhausted"].includes(end.kind)) return { action: "continue", reason: end.kind, countsAsFailure: false };
  if (end.kind === "rate-limited" && end.resumeAt) {
    return { action: "wait", until: end.resumeAt + resetMarginMs, reason: `rate limited until ${new Date(end.resumeAt).toISOString()}`, countsAsFailure: false };
  }
  const failures = consecutiveFailures + 1;
  if (failures >= maxConsecutiveFailures) {
    return { action: "halt", reason: `${failures} consecutive failed rounds (last: ${end.kind}: ${end.detail})`, countsAsFailure: true };
  }
  return { action: "wait", until: backoffUntil(end.kind, failures, now), reason: `${end.kind}: ${end.detail}`, countsAsFailure: true };
}
