// SPDX-License-Identifier: Apache-2.0
// The loop end to end, with a fake agent that replays stream-json scenarios. No real account, no
// network: the "agent" is test/fixtures/fake-agent.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoop } from "../src/supervisor.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

function fakeClock(start = new Date(2026, 10, 12, 10, 0, 0).getTime()) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } };
}

const outcomeOf = (findings) => ({ summary: "checked things", findings, followUps: [] });

function setup({ scenarios, config = {}, catalog, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "defectloop-sup-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "loop@example.com");
  git("config", "user.name", "Loop Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".defectloop/\n");
  writeFileSync(join(dir, "README.md"), "# toy project\n");
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  writeFileSync(join(dir, "src", "core", "a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "api", "b.js"), "export const b = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  const scenarioPath = join(dir, "..", `${dir.split("/").pop()}.scenario.json`);
  writeFileSync(scenarioPath, JSON.stringify(scenarios ?? [{ outcome: outcomeOf([]) }]));
  writeFileSync(
    join(dir, "defectloop.catalog.json"),
    JSON.stringify(
      catalog ?? {
        version: 1,
        techniques: [
          { id: "deep-review", name: "Deep review", instructions: "Read one area end to end and look for defects.", perArea: "code" },
          { id: "test-gaps", name: "Test gaps", instructions: "Find behaviour that no test pins down and add tests." },
        ],
      },
    ),
  );
  const cfg = {
    agent: { command: [process.execPath, FAKE] },
    budget: { perRoundUsd: 1, dailyUsd: 5, monthlyUsd: 50 },
    loop: { secondsBetweenRounds: 0, watchdogMs: 50, maxRoundMinutes: 5, maxSilenceMinutes: 5 },
    areas: { discover: [{ dir: "src", kind: "code" }] },
    ...config,
  };
  const configPath = join(dir, "defectloop.config.json");
  writeFileSync(configPath, JSON.stringify(cfg));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "test-key-not-real", CLAUDE_CODE_OAUTH_TOKEN: "should-be-stripped", ANTHROPIC_AUTH_TOKEN: "should-be-stripped", FAKE_AGENT_SCENARIO: scenarioPath, DEFECTLOOP_HOME: join(dir, "..", `${dir.split("/").pop()}.home`) };
  const state = join(dir, ".defectloop");
  const lines = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, configPath, env, state, lines, git, scenarioPath, json: (f) => JSON.parse(readFileSync(join(state, f), "utf8")) };
}

const quiet = () => {};

test("two completed rounds: records, findings, costs, stats, commits and a clean agent environment", async () => {
  const dump = join(tmpdir(), `defectloop-dump-${process.pid}-${Date.now()}.jsonl`);
  const s = setup({
    scenarios: [
      { dump, commit: { file: "src/core/a.js", content: "export const a = 2;\n", message: "fix(core): correct a" }, outcome: outcomeOf([{ title: "Wrong constant in a", status: "fixed", severity: "low", category: "bug", location: "src/core/a.js:1", evidence: "a test", commit: "abc" }]) },
      { dump, events: [{ $init: {} }, { $result: { total_cost_usd: 0.5 } }], outcome: outcomeOf([{ title: "Missing input check", status: "proposed", severity: "high", category: "security", location: "src/api/b.js:1" }]) },
    ],
  });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 2, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "max-rounds");
  assert.equal(r.rounds, 2);

  const rounds = s.lines("rounds.jsonl");
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds.map((x) => x.status), ["completed", "completed"]);
  assert.deepEqual(rounds.map((x) => x.round), ["round-0001", "round-0002"]);
  assert.equal(rounds[0].schemaVersion, 1);
  assert.equal(rounds[0].commits.length, 1);
  assert.match(rounds[0].commits[0], /fix\(core\): correct a/);
  assert.equal(rounds[0].costUsd, 0.25);
  assert.equal(rounds[0].costSource, "reported");
  assert.equal(rounds[1].costUsd, 0.5);
  assert.equal(rounds[0].authSource, "ANTHROPIC_API_KEY");

  const findings = s.lines("findings.jsonl");
  assert.deepEqual(findings.map((f) => f.status), ["fixed", "proposed"]);
  assert.ok(findings.every((f) => f.fingerprint && f.round && f.technique));

  assert.deepEqual(s.lines("ledger.jsonl").map((l) => l.costUsd), [0.25, 0.5]);

  const state = s.json("state.json");
  assert.equal(state.round, 2);
  const ran = rounds.map((x) => x.technique);
  assert.deepEqual([...ran].sort(), ["deep-review", "test-gaps"], "both never-run techniques ran first");

  const calls = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, "set");
  assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, "unset");
  assert.equal(calls[0].env.ANTHROPIC_AUTH_TOKEN, "unset");
  assert.match(calls[0].prompt, /round-0001/);
  assert.match(calls[0].prompt, /round-0001\.outcome\.json/);
  const args = calls[0].args.join(" ");
  for (const flag of ["-p", "--output-format stream-json", "--verbose", "--permission-mode dontAsk", "--permission-prompts none", "--max-budget-usd 1", "--strict-mcp-config", "--no-session-persistence", "--setting-sources project"]) {
    assert.ok(args.includes(flag), `missing ${flag} in: ${args}`);
  }
  const settings = JSON.parse(readFileSync(calls[0].args[calls[0].args.indexOf("--settings") + 1], "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /guard/);
  assert.ok(existsSync(join(s.state, "rounds", "round-0001.jsonl")), "transcript kept");
  assert.ok(existsSync(join(s.state, "rounds", "round-0001.context.md")), "context kept");
});

test("an unrecognized stream format halts the loop, and a halted loop does not restart", async () => {
  const s = setup({ scenarios: [{ events: ["Something printed in plain text"], outcome: outcomeOf([]) }] });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 5, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "halted");
  assert.match(r.reason, /format/);
  assert.equal(s.lines("rounds.jsonl").length, 1);
  assert.equal(s.json("state.json").halted.kind, "format-unrecognized");
  assert.ok(readFileSync(join(s.state, "ALERTS.md"), "utf8").includes("format"));
  const again = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 5, clock: fakeClock(), log: quiet });
  assert.equal(again.exit, "halted");
  assert.equal(s.lines("rounds.jsonl").length, 1, "no new round was started");
});

test("subscription authentication detected at runtime halts the loop", async () => {
  const s = setup({ scenarios: [{ events: [{ $init: { apiKeySource: "/login managed key" } }, { $result: {} }], outcome: outcomeOf([]) }] });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 3, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "halted");
  assert.equal(s.json("state.json").halted.kind, "auth-policy");
});

test("no API key in the environment: the loop refuses to start", async () => {
  const s = setup();
  const env = { ...s.env };
  delete env.ANTHROPIC_API_KEY;
  const r = await runLoop({ configPath: s.configPath, env, maxRounds: 1, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "preflight-failed");
  assert.match(r.reason, /ANTHROPIC_API_KEY/);
  assert.equal(s.lines("rounds.jsonl").length, 0);
});

test("kill switch: a STOP file before start prevents any round; mid-round it kills the session", async () => {
  const s = setup({ scenarios: [{ events: [{ $init: {} }], hang: true }] });
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "STOP"), "");
  const before = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  assert.equal(before.exit, "stopped");
  assert.equal(s.lines("rounds.jsonl").length, 0);

  execFileSync("rm", [join(s.state, "STOP")]);
  // engage the kill switch only once the session is running (its transcript exists)
  const poll = setInterval(() => {
    if (existsSync(join(s.state, "rounds", "round-0001.jsonl"))) {
      clearInterval(poll);
      writeFileSync(join(s.state, "STOP"), "");
    }
  }, 50);
  const t0 = Date.now();
  const mid = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 3, clock: fakeClock(), log: quiet });
  assert.equal(mid.exit, "stopped");
  assert.ok(Date.now() - t0 < 15_000);
  const rounds = s.lines("rounds.jsonl");
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].status, "stopped");
  assert.equal(rounds[0].costSource, "estimated-cap", "a killed round is charged the per-round cap");
});

test("global kill switch in the user's defectloop home", async () => {
  const s = setup();
  mkdirSync(s.env.DEFECTLOOP_HOME, { recursive: true });
  writeFileSync(join(s.env.DEFECTLOOP_HOME, "STOP"), "");
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "stopped");
  assert.equal(s.lines("rounds.jsonl").length, 0);
});

test("budget: no round starts when a full round would exceed the daily cap", async () => {
  const s = setup();
  const clock = fakeClock();
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "ledger.jsonl"), `${JSON.stringify({ at: new Date(clock.now() - 60_000).toISOString(), round: "round-0000", costUsd: 4.5, source: "reported" })}\n`);
  const r = await runLoop({ configPath: s.configPath, env: s.env, once: true, clock, log: quiet });
  assert.equal(r.exit, "waiting");
  assert.match(r.reason, /daily/);
  assert.equal(r.until, new Date(2026, 10, 13, 0, 0, 0).getTime());
  assert.equal(s.lines("rounds.jsonl").length, 0);
});

test("a hung session is killed at the round time limit and charged the cap", async () => {
  const s = setup({ scenarios: [{ events: [{ $init: {} }], hang: true }], config: { loop: { secondsBetweenRounds: 0, watchdogMs: 50, maxRoundMinutes: 0.01, maxSilenceMinutes: 5 } } });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "max-rounds");
  const [round] = s.lines("rounds.jsonl");
  assert.equal(round.status, "timeout");
  assert.equal(round.costUsd, 1);
  assert.equal(round.costSource, "estimated-cap");
  assert.equal(s.json("state.json").stats[round.technique].rounds, 1, "a timed-out technique still counts as tried");
});

test("rounds without an outcome back off and halt after three in a row", async () => {
  const s = setup({ scenarios: [{ events: [{ $init: {} }, { $result: {} }] }] });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 10, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "halted");
  assert.match(r.reason, /3 consecutive/);
  assert.deepEqual(s.lines("rounds.jsonl").map((x) => x.status), ["no-outcome", "no-outcome", "no-outcome"]);
});

test("structured rate limit: the loop waits until the reset, then the interrupted campaign resumes first", async () => {
  const clock = fakeClock();
  const reset = Math.floor((clock.now() + 3600_000) / 1000);
  const s = setup({
    scenarios: [
      { events: [{ $init: {} }, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } }, { $result: { is_error: true, subtype: "error_during_execution", result: "rate limited", total_cost_usd: 0.01 } }] },
      { outcome: outcomeOf([]) },
    ],
  });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 2, clock, log: quiet });
  assert.equal(r.exit, "max-rounds");
  const rounds = s.lines("rounds.jsonl");
  assert.deepEqual(rounds.map((x) => x.status), ["rate-limited", "completed"]);
  assert.equal(rounds[1].technique, rounds[0].technique);
  assert.match(rounds[1].reason, /resume/);
  assert.ok(clock.now() >= reset * 1000, "the loop slept until the reset");
});

test("leftover uncommitted changes from a broken round lead to a cleanup round; foreign files are excluded", async () => {
  const s = setup({
    files: { "NOTES.md": "someone else's work in progress\n" },
    scenarios: [{ dirty: { file: "src/core/half.js", content: "export const half = 1;\n" }, events: [{ $init: {} }, { $result: {} }] }, { outcome: outcomeOf([]) }],
    config: { loop: { secondsBetweenRounds: 0, watchdogMs: 50, maxRoundMinutes: 5, maxSilenceMinutes: 5, maxConsecutiveFailures: 5 } },
  });
  const r = await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 2, clock: fakeClock(), log: quiet });
  assert.equal(r.exit, "max-rounds");
  const rounds = s.lines("rounds.jsonl");
  assert.equal(rounds[1].technique, "cleanup");
  const context = readFileSync(join(s.state, "rounds", "round-0002.context.md"), "utf8");
  assert.match(context, /src\/core\/half\.js/);
  assert.match(context, /NOTES\.md/);
  assert.match(context, /[Ff]oreign/);
});

test("follow-ups from an outcome enter the queue; unknown techniques are dropped", async () => {
  const s = setup({
    scenarios: [{ outcome: { summary: "s", findings: [], followUps: [{ technique: "test-gaps", area: "src/api", brief: "check the sibling handler" }, { technique: "ghost", brief: "x" }] } }],
  });
  await runLoop({ configPath: s.configPath, env: s.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  const q = s.json("state.json").queue;
  assert.equal(q.length, 1);
  assert.equal(q[0].technique, "test-gaps");
  assert.equal(q[0].origin, "round-0001");
});

test("proposed techniques are recorded but not adopted unless enabled", async () => {
  const proposal = { summary: "s", findings: [], proposedTechnique: { name: "Locale probe", instructions: "Switch locales and compare rendered strings." } };
  const off = setup({ scenarios: [{ outcome: proposal }] });
  await runLoop({ configPath: off.configPath, env: off.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  assert.equal(existsSync(join(off.state, "catalog-extra.json")), false);
  assert.equal(off.lines("rounds.jsonl")[0].proposedTechnique.name, "Locale probe");

  const on = setup({ scenarios: [{ outcome: proposal }], config: { loop: { secondsBetweenRounds: 0, watchdogMs: 50, acceptProposedTechniques: true } } });
  await runLoop({ configPath: on.configPath, env: on.env, maxRounds: 1, clock: fakeClock(), log: quiet });
  const extra = on.json("catalog-extra.json");
  assert.equal(extra.length, 1);
  assert.match(extra[0].id, /^x-01$/);
});
