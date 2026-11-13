// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/defectloop.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "defectloop-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}
const cli = (dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DEFECTLOOP_HOME: join(dir, ".home"), ...env } });

test("init writes a config and a catalog, and never overwrites them", () => {
  const dir = repo();
  const r = cli(dir, ["init"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, "defectloop.config.json")));
  assert.ok(existsSync(join(dir, "defectloop.catalog.json")));
  writeFileSync(join(dir, "defectloop.config.json"), "{}\n");
  cli(dir, ["init"]);
  assert.equal(readFileSync(join(dir, "defectloop.config.json"), "utf8"), "{}\n");
});

test("check: offline preflight passes with an API key and a compatible agent, fails without the key", () => {
  const dir = repo();
  cli(dir, ["init"]);
  const cfgPath = join(dir, "defectloop.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.agent.command = [process.execPath, FAKE];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const ok = cli(dir, ["check"], { ANTHROPIC_API_KEY: "test-key-not-real" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /guard self-test/i);
  const ko = cli(dir, ["check"]);
  assert.equal(ko.status, 1);
  assert.match(ko.stdout + ko.stderr, /ANTHROPIC_API_KEY/);
  const warn = cli(dir, ["check"], { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.match(warn.stdout, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("check fails when the agent CLI lacks a flag the adapter needs", () => {
  const dir = repo();
  cli(dir, ["init"]);
  const cfgPath = join(dir, "defectloop.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const old = join(dir, "old-agent.mjs");
  writeFileSync(old, 'process.stdout.write("Usage: claude -p --output-format --verbose\\n");\n');
  cfg.agent.command = [process.execPath, old];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = cli(dir, ["check"], { ANTHROPIC_API_KEY: "k" });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /--max-budget-usd/);
});

test("stop, pause, resume and status", () => {
  const dir = repo();
  cli(dir, ["init"]);
  assert.equal(cli(dir, ["stop"]).status, 0);
  assert.ok(existsSync(join(dir, ".defectloop", "STOP")));
  assert.match(cli(dir, ["status"]).stdout, /kill switch/i);
  assert.equal(cli(dir, ["pause"]).status, 0);
  assert.ok(existsSync(join(dir, ".defectloop", "PAUSE")));
  assert.equal(cli(dir, ["resume"]).status, 0);
  assert.equal(existsSync(join(dir, ".defectloop", "STOP")), false);
  assert.equal(existsSync(join(dir, ".defectloop", "PAUSE")), false);
  assert.equal(cli(dir, ["stop", "--global"]).status, 0);
  assert.ok(existsSync(join(dir, ".home", "STOP")));
  assert.equal(cli(dir, ["resume", "--global"]).status, 0);
  assert.equal(existsSync(join(dir, ".home", "STOP")), false);
});

test("service prints unit files and installs nothing", () => {
  const dir = repo();
  cli(dir, ["init"]);
  const systemd = cli(dir, ["service", "systemd"]);
  assert.equal(systemd.status, 0);
  assert.match(systemd.stdout, /ExecStart=.*defectloop.*run/);
  assert.match(systemd.stdout, /Restart=on-failure/);
  const launchd = cli(dir, ["service", "launchd"]);
  assert.match(launchd.stdout, /<key>KeepAlive<\/key>/);
  assert.match(launchd.stdout, /SuccessfulExit/);
  assert.equal(cli(dir, ["service", "cron"]).status, 1);
});

test("report and search work on an empty state", () => {
  const dir = repo();
  cli(dir, ["init"]);
  const r = cli(dir, ["report"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, ".defectloop", "REPORT.md")));
  assert.equal(cli(dir, ["search", "anything"]).status, 1);
});

test("unknown command: usage and exit 1", () => {
  const dir = repo();
  const r = cli(dir, ["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/i);
});
