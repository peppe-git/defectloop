// SPDX-License-Identifier: Apache-2.0
//
// EXPERIMENTAL adapter for the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, not a dependency:
// install it yourself). Option names follow the TypeScript reference as read on 2026-11-12; this
// adapter has been exercised only against a fake `query`, never against the real SDK.
//
// The guard runs in-process as a PreToolUse hook callback; SDK messages are re-serialised as JSON
// lines so the same stream monitor reads them.

export const ADAPTER_NAME = "agent-sdk";
export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

async function defaultLoad() {
  return import(SDK_PACKAGE);
}

/**
 * @param {{ config: object, prompt: string, env: object, cwd: string, guard: (payload: object) => string|null, load?: () => Promise<{ query: Function }> }} args
 */
export async function startSdk({ config, prompt, env, cwd, guard, load = defaultLoad }) {
  let sdk;
  try {
    sdk = await load();
  } catch (err) {
    throw new Error(`agent.adapter "agent-sdk" needs ${SDK_PACKAGE} installed next to defectloop (${err.message})`);
  }
  if (typeof sdk?.query !== "function") throw new Error(`${SDK_PACKAGE} does not export query(): unsupported version`);
  const a = config.agent;
  const abort = new AbortController();
  let tail = "";
  const preToolUse = async (input) => {
    let why;
    try {
      why = guard(input);
    } catch (err) {
      why = `guard error, blocked by default: ${err.message}`;
    }
    return why ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `defectloop guard: ${why}` } } : {};
  };
  const options = {
    cwd,
    env, // replaces process.env in the SDK: pass the full, filtered environment
    permissionMode: a.permissionMode === "manual" ? "default" : a.permissionMode,
    allowedTools: a.allowedTools,
    disallowedTools: a.disallowedTools,
    maxBudgetUsd: config.budget.perRoundUsd,
    strictMcpConfig: true,
    mcpServers: {},
    abortController: abort,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    stderr: (d) => {
      tail = (tail + String(d)).slice(-4000);
    },
    ...(a.settingSources ? { settingSources: a.settingSources } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.fallbackModel ? { fallbackModel: a.fallbackModel } : {}),
    ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
  };
  const q = sdk.query({ prompt, options });
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  async function* lines() {
    try {
      for await (const m of q) yield JSON.stringify(m);
      resolveExit({ code: 0, signal: null });
    } catch (err) {
      tail = `${tail}\n${err?.message ?? err}`.slice(-4000);
      resolveExit({ code: abort.signal.aborted ? null : 1, signal: abort.signal.aborted ? "SIGTERM" : null });
    }
  }
  return { pid: null, lines: lines(), stderrTail: () => tail, kill: () => abort.abort(), exited, options };
}
