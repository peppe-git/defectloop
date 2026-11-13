// SPDX-License-Identifier: Apache-2.0
//
// The environment an agent session gets, and the authentication preflight. Shared by the adapters.
//
// defectloop does not run on Claude subscription logins (see docs/costs.md): the OAuth token
// variables are removed from the session's environment, and an API key (or a cloud provider) is
// required before the loop starts.

const DROP_ALWAYS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]);
const PROVIDER_FLAG = { bedrock: "CLAUDE_CODE_USE_BEDROCK", vertex: "CLAUDE_CODE_USE_VERTEX", foundry: "CLAUDE_CODE_USE_FOUNDRY" };

/**
 * @param {object} base the supervisor's environment
 * @param {{ auth: string }} agent
 * @param {object} extra variables to add (DEFECTLOOP_*)
 */
export function agentEnv(base, agent, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base ?? {})) {
    if (v === undefined || DROP_ALWAYS.has(k)) continue;
    // markers of a parent Claude Code session would make the child believe it is nested
    if (/^CLAUDE_CODE_/.test(k) && !/^CLAUDE_CODE_(USE_|SKIP_|MAX_OUTPUT_TOKENS$)/.test(k)) continue;
    // in api-key mode a provider flag would silently take precedence over the key
    if (agent.auth === "api-key" && /^CLAUDE_CODE_USE_/.test(k)) continue;
    env[k] = v;
  }
  env.DISABLE_AUTOUPDATER = "1";
  env.DEFECTLOOP = "1";
  return { ...env, ...extra };
}

/** @returns {{ problems: string[], warnings: string[] }} */
export function authPreflight(base, agent) {
  const problems = [];
  const warnings = [];
  if (agent.auth === "api-key") {
    if (!base.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is not set. defectloop runs only with an API key (agent.auth "api-key") or a cloud provider (bedrock, vertex, foundry); it does not use Claude subscription logins.');
    for (const k of Object.values(PROVIDER_FLAG)) if (base[k]) warnings.push(`${k} is set but agent.auth is "api-key": it will be removed from the agent's environment`);
  } else {
    const flag = PROVIDER_FLAG[agent.auth];
    if (!flag) problems.push(`unknown agent.auth "${agent.auth}"`);
    else if (!base[flag] || base[flag] === "0") problems.push(`agent.auth is "${agent.auth}" but ${flag}=1 is not set`);
  }
  if (base.CLAUDE_CODE_OAUTH_TOKEN) warnings.push("CLAUDE_CODE_OAUTH_TOKEN is set in this shell: it will be removed from the agent's environment (subscription tokens are not used)");
  if (base.ANTHROPIC_AUTH_TOKEN) warnings.push("ANTHROPIC_AUTH_TOKEN is set in this shell: it will be removed from the agent's environment (it would take precedence over the API key)");
  return { problems, warnings };
}
