#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for `claude -p --output-format stream-json`. It never talks to any service: it replays a
// scenario from the JSON file named by FAKE_AGENT_SCENARIO. The scenario is an array (one entry per
// round, the last one repeats) of:
//   { events: [object | string | {"$init": {...}} | {"$result": {...}}],
//     outcome: object | null, commit: { file, content, message }, dirty: { file, content },
//     stderr: string, exitCode: number, hang: boolean, sleepMs: number, dump: path }

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(
    [
      "Usage: claude [options] [command] [prompt]",
      "  -p, --print",
      "  --output-format <format>",
      "  --verbose",
      "  --model <model>",
      "  --fallback-model <model>",
      "  --effort <level>",
      "  --permission-mode <mode>",
      "  --permission-prompts <target>",
      "  --allowedTools, --allowed-tools <tools...>",
      "  --disallowedTools, --disallowed-tools <tools...>",
      "  --settings <file-or-json>",
      "  --setting-sources <sources>",
      "  --strict-mcp-config",
      "  --mcp-config <configs...>",
      "  --no-session-persistence",
      "  --max-budget-usd <amount>",
      "  --max-turns <turns>",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("2.1.296 (fake agent)\n");
  process.exit(0);
}

const round = process.env.DEFECTLOOP_ROUND ?? "round-0000";
const n = Number(round.replace(/\D/g, "")) || 1;
const scenarios = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCENARIO, "utf8"));
const s = scenarios[Math.min(n - 1, scenarios.length - 1)] ?? {};

let prompt = "";
try {
  prompt = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}

if (s.dump) {
  mkdirSync(dirname(s.dump), { recursive: true });
  appendFileSync(
    s.dump,
    `${JSON.stringify({
      round,
      args,
      prompt,
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "set" : "unset",
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "unset",
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? "set" : "unset",
        DEFECTLOOP_OUTCOME: process.env.DEFECTLOOP_OUTCOME ?? null,
      },
    })}\n`,
  );
}

const SESSION = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const emit = (e) => process.stdout.write(`${typeof e === "string" ? e : JSON.stringify(e)}\n`);
const init = (o = {}) => ({ type: "system", subtype: "init", session_id: SESSION, apiKeySource: "ANTHROPIC_API_KEY", claude_code_version: "2.1.296", cwd: process.cwd(), tools: ["Bash", "Read"], mcp_servers: [], model: "fake-model", permissionMode: "dontAsk", ...o });
const result = (o = {}) => ({ type: "result", subtype: "success", is_error: false, duration_ms: 1000, num_turns: 3, result: "done", session_id: SESSION, total_cost_usd: 0.25, ...o });

for (const e of s.events ?? [{ $init: {} }, { $result: {} }]) {
  if (e && typeof e === "object" && "$init" in e) emit(init(e.$init));
  else if (e && typeof e === "object" && "$result" in e) {
    // the outcome and commits happen before the final result line, as in a real session
    finishWork();
    emit(result(e.$result));
  } else emit(e);
}
if (!(s.events ?? []).some((e) => e && typeof e === "object" && "$result" in e)) finishWork();

function finishWork() {
  if (finishWork.done) return;
  finishWork.done = true;
  if (s.dirty) writeFileSync(join(process.cwd(), s.dirty.file), s.dirty.content ?? "dirty\n");
  if (s.commit) {
    writeFileSync(join(process.cwd(), s.commit.file), s.commit.content ?? "change\n");
    execFileSync("git", ["add", "--", s.commit.file]);
    execFileSync("git", ["commit", "-q", "-m", `${s.commit.message ?? "fix: change"}\n\nDefectloop-Round: ${round}`, "--", s.commit.file]);
  }
  if (s.outcome && process.env.DEFECTLOOP_OUTCOME) {
    mkdirSync(dirname(process.env.DEFECTLOOP_OUTCOME), { recursive: true });
    writeFileSync(process.env.DEFECTLOOP_OUTCOME, JSON.stringify(s.outcome));
  }
}

if (s.stderr) process.stderr.write(s.stderr);
if (s.hang) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(s.exitCode ?? 0), s.sleepMs ?? 0);
