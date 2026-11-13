// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, authPreflight } from "../src/adapters/env.mjs";
import { buildArgs, REQUIRED_FLAGS } from "../src/adapters/claude-cli.mjs";
import { startSdk } from "../src/adapters/agent-sdk.mjs";
import { resolveConfig } from "../src/config.mjs";
import { evaluate, resolvePolicy } from "../src/guard/rules.mjs";
import { createStreamMonitor } from "../src/stream.mjs";

const { config } = resolveConfig({ budget: { perRoundUsd: 1.5, dailyUsd: 5 }, agent: { model: "sonnet" } }, { configDir: "/home/tester/project" });

test("agent environment: subscription and bearer tokens removed, provider flags removed in api-key mode", () => {
  const env = agentEnv(
    { PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_AUTH_TOKEN: "b", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000" },
    { auth: "api-key" },
    { DEFECTLOOP_ROUND: "round-0001" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_USE_BEDROCK"]) assert.equal(env[k], undefined, k);
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8000");
  assert.equal(env.DEFECTLOOP_ROUND, "round-0001");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  const bedrock = agentEnv({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" }, { auth: "bedrock" });
  assert.equal(bedrock.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(bedrock.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("auth preflight: the key or the provider flag is required; subscription tokens only warn (they are removed)", () => {
  assert.match(authPreflight({}, { auth: "api-key" }).problems[0], /ANTHROPIC_API_KEY/);
  assert.match(authPreflight({}, { auth: "api-key" }).problems[0], /subscription/);
  assert.deepEqual(authPreflight({ ANTHROPIC_API_KEY: "k" }, { auth: "api-key" }).problems, []);
  assert.match(authPreflight({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, { auth: "api-key" }).warnings.join(" "), /removed/);
  assert.match(authPreflight({}, { auth: "vertex" }).problems[0], /CLAUDE_CODE_USE_VERTEX/);
  assert.deepEqual(authPreflight({ CLAUDE_CODE_USE_VERTEX: "1" }, { auth: "vertex" }).problems, []);
});

test("CLI arguments: headless, stream-json, no prompts, per-round spend cap, explicit tools", () => {
  const args = buildArgs(config, { settingsPath: "/s.json", mcpPath: "/m.json" });
  const line = args.join(" ");
  for (const f of REQUIRED_FLAGS) assert.ok(args.includes(f), f);
  assert.match(line, /--output-format stream-json/);
  assert.match(line, /--permission-mode dontAsk/);
  assert.match(line, /--permission-prompts none/);
  assert.match(line, /--max-budget-usd 1\.5/);
  assert.match(line, /--allowedTools Read,Glob,Grep,Edit,Write,Bash/);
  assert.match(line, /--model sonnet/);
  assert.ok(!args.some((a) => /dangerously|bypass|--bare/.test(a)));
  assert.equal(args.includes("--max-turns"), false);
});

test("config refuses extra arguments that would disable permissions or hooks", () => {
  for (const bad of ["--dangerously-skip-permissions", "--bare", "--allow-dangerously-skip-permissions"]) {
    const { errors } = resolveConfig({ budget: { perRoundUsd: 1, dailyUsd: 5 }, agent: { extraArgs: [bad] } }, { configDir: "/x" });
    assert.ok(errors.some((e) => /extraArgs/.test(e)), bad);
  }
});

test("Agent SDK adapter (experimental): options, in-process guard, messages as JSON lines", async () => {
  let seen;
  const fakeSdk = {
    query({ prompt, options }) {
      seen = { prompt, options };
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-1", apiKeySource: "ANTHROPIC_API_KEY" };
        const hook = options.hooks.PreToolUse[0].hooks[0];
        const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git " + "push" }, cwd: "/home/tester/project" }, "t1", { signal: new AbortController().signal });
        const allowed = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/home/tester/project" }, "t2", { signal: new AbortController().signal });
        yield { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify({ denied, allowed }) }] } };
        yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.07, num_turns: 2 };
      })();
    },
  };
  const ctx = { root: "/home/tester/project", home: "/home/tester", stateDir: "/home/tester/project/.defectloop", policy: resolvePolicy({}), tmpDirs: ["/tmp"], recentFiles: () => [] };
  const s = await startSdk({ config, prompt: "do the round", env: { PATH: "/bin", ANTHROPIC_API_KEY: "k" }, cwd: "/home/tester/project", guard: (p) => evaluate(p, ctx), load: async () => fakeSdk });
  const m = createStreamMonitor();
  const lines = [];
  for await (const l of s.lines) {
    lines.push(l);
    m.push(l);
  }
  assert.deepEqual(await s.exited, { code: 0, signal: null });
  assert.equal(seen.prompt, "do the round");
  assert.equal(seen.options.maxBudgetUsd, 1.5);
  assert.equal(seen.options.permissionMode, "dontAsk");
  assert.equal(seen.options.strictMcpConfig, true);
  assert.deepEqual(seen.options.settingSources, ["project"]);
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, "k");
  const { denied, allowed } = JSON.parse(JSON.parse(lines[1]).message.content[0].text);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /defectloop guard/);
  assert.deepEqual(allowed, {});
  assert.equal(m.summary().result.costUsd, 0.07);
  assert.deepEqual(m.summary().problems, []);
});

test("Agent SDK adapter: a missing package is a clear error", async () => {
  await assert.rejects(
    startSdk({ config, prompt: "x", env: {}, cwd: "/", guard: () => null, load: async () => { throw new Error("Cannot find package"); } }),
    /needs @anthropic-ai\/claude-agent-sdk/,
  );
});

test("Agent SDK adapter: a throwing guard denies instead of allowing", async () => {
  let decision;
  const fakeSdk = {
    query({ options }) {
      return (async function* () {
        decision = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "ls" } });
      })();
    },
  };
  const s = await startSdk({ config, prompt: "x", env: {}, cwd: "/", guard: () => { throw new Error("boom"); }, load: async () => fakeSdk });
  for await (const _ of s.lines);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
});
