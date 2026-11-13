// SPDX-License-Identifier: Apache-2.0
//
// Reads the agent's stream-json line by line and keeps only what the loop depends on: the init event
// (who is paying, which session), the final result (cost, error), rate-limit events. Pure: feed it
// lines, ask for a summary.
//
// The format has no documented stability guarantee. The policy here is:
//   - new event types are tolerated (counted in `unknownTypes`): the format grows additively;
//   - the events the loop depends on must have the shape it knows, otherwise a `problem` is recorded;
//   - any problem makes the supervisor stop the loop safely instead of guessing and looping.

export const KNOWN_TYPES = new Set(["system", "assistant", "user", "result", "rate_limit_event", "stream_event", "tool_progress", "auth_status", "keep_alive", "control_request", "control_response", "prompt_suggestion"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {{ initWithin?: number }} [opts] how many JSON events may precede system/init */
export function createStreamMonitor({ initWithin = 20 } = {}) {
  const st = {
    init: null,
    result: null,
    rateLimit: null,
    apiRetries: 0,
    counts: { lines: 0, json: 0, nonJson: 0, unknownTypes: 0 },
    problems: [],
    byType: {},
  };
  const problem = (p) => {
    if (st.problems.length < 20) st.problems.push(p);
  };

  function onSystem(e) {
    if (e.subtype === "init") {
      if (typeof e.session_id !== "string" || !e.session_id) {
        problem("system/init event without a session_id");
        return;
      }
      st.init = {
        sessionId: e.session_id,
        apiKeySource: typeof e.apiKeySource === "string" ? e.apiKeySource : undefined,
        model: typeof e.model === "string" ? e.model : null,
        version: typeof e.claude_code_version === "string" ? e.claude_code_version : null,
        permissionMode: typeof e.permissionMode === "string" ? e.permissionMode : null,
        cwd: typeof e.cwd === "string" ? e.cwd : null,
        capabilities: Array.isArray(e.capabilities) ? e.capabilities.filter((c) => typeof c === "string") : null,
      };
    } else if (e.subtype === "api_retry") {
      st.apiRetries += 1;
    }
  }

  function onResult(e) {
    if (typeof e.is_error !== "boolean") {
      problem("result event without a boolean is_error");
      return;
    }
    if (!isNum(e.total_cost_usd) || e.total_cost_usd < 0) {
      problem("result event without a numeric total_cost_usd");
      return;
    }
    st.result = {
      subtype: typeof e.subtype === "string" ? e.subtype : null,
      isError: e.is_error,
      text: typeof e.result === "string" ? e.result.slice(0, 2000) : "",
      costUsd: e.total_cost_usd,
      numTurns: isNum(e.num_turns) ? e.num_turns : null,
      durationMs: isNum(e.duration_ms) ? e.duration_ms : null,
    };
  }

  function onRateLimit(e) {
    const info = e.rate_limit_info;
    if (!info || typeof info !== "object" || typeof info.status !== "string") {
      problem("rate_limit_event without rate_limit_info.status");
      return;
    }
    if (info.status !== "rejected") return;
    if (!isNum(info.resetsAt) || info.resetsAt <= 0) {
      problem("rejected rate_limit_event without a numeric resetsAt");
      return;
    }
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    st.rateLimit = { status: info.status, resetsAtMs: ms, type: typeof info.rateLimitType === "string" ? info.rateLimitType : null };
  }

  return {
    /** Feeds one line of stdout. Returns the parsed event, or null for blank or invalid lines. */
    push(line) {
      const s = String(line ?? "").trim();
      if (!s) return null;
      st.counts.lines += 1;
      let e;
      try {
        e = JSON.parse(s);
      } catch {
        st.counts.nonJson += 1;
        problem(`line ${st.counts.lines} is not JSON: ${s.slice(0, 120)}`);
        return null;
      }
      if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.type !== "string") {
        problem(`line ${st.counts.lines} is not an event object with a string type`);
        return null;
      }
      st.counts.json += 1;
      st.byType[e.type] = (st.byType[e.type] ?? 0) + 1;
      if (!KNOWN_TYPES.has(e.type)) st.counts.unknownTypes += 1;
      if (e.type === "system") onSystem(e);
      else if (e.type === "result") onResult(e);
      else if (e.type === "rate_limit_event") onRateLimit(e);
      if (!st.init && st.counts.json >= initWithin && !st.problems.some((p) => p.includes("no system/init"))) {
        problem(`no system/init event within the first ${initWithin} events`);
      }
      return e;
    },
    summary() {
      return { init: st.init, result: st.result, rateLimit: st.rateLimit, apiRetries: st.apiRetries, counts: { ...st.counts }, byType: { ...st.byType }, problems: [...st.problems] };
    },
  };
}
