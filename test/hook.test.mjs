// SPDX-License-Identifier: Apache-2.0
// The guard as Claude Code runs it: a separate process, JSON on stdin, exit 2 to block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/defectloop.mjs", import.meta.url));
const PUSH = "git " + "push";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "defectloop-hook-"));
  const config = join(dir, "defectloop.config.json");
  writeFileSync(config, JSON.stringify({ budget: { perRoundUsd: 1, dailyUsd: 5 }, catalog: "catalog.json" }));
  return { dir, config };
}

const run = (input, args) => spawnSync(process.execPath, [BIN, "guard", ...args], { input, encoding: "utf8" });

test("hook: exit 2 with the reason on stderr when blocked, exit 0 when allowed", () => {
  const { dir, config } = project();
  const blocked = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: PUSH }, cwd: dir }), ["--config", config]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /defectloop guard/);
  const allowed = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: dir }), ["--config", config]);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("hook: unreadable input blocks (fail closed)", () => {
  const { config } = project();
  const r = run("this is not json", ["--config", config]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unreadable|invalid/i);
});

test("hook: missing or broken configuration blocks (fail closed)", () => {
  const { dir } = project();
  const missing = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), ["--config", join(dir, "nope.json")]);
  assert.equal(missing.status, 2);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), ["--config", broken]);
  assert.equal(r.status, 2);
  const noArg = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), []);
  assert.equal(noArg.status, 2);
});

test("hook: the round's outcome file comes from the environment", () => {
  const { dir, config } = project();
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, ".defectloop/rounds/round-0007.outcome.json"), content: "{}" } });
  const withRound = spawnSync(process.execPath, [BIN, "guard", "--config", config], { input: payload, encoding: "utf8", env: { ...process.env, DEFECTLOOP_ROUND: "round-0007" } });
  assert.equal(withRound.status, 0, withRound.stderr);
  const env = { ...process.env };
  delete env.DEFECTLOOP_ROUND;
  const without = spawnSync(process.execPath, [BIN, "guard", "--config", config], { input: payload, encoding: "utf8", env });
  assert.equal(without.status, 2);
});
