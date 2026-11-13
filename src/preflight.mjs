// SPDX-License-Identifier: Apache-2.0
//
// Offline checks before the loop starts (and for `defectloop check`). Nothing here calls a model.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { authPreflight } from "./adapters/env.mjs";
import { preflightCli, shellQuote } from "./adapters/claude-cli.mjs";
import { loadCatalog } from "./catalog.mjs";
import { isRepo } from "./git.mjs";
import { paths } from "./state.mjs";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BIN = join(PACKAGE_ROOT, "bin", "defectloop.mjs");
export const DEFAULT_PROMPT = join(PACKAGE_ROOT, "templates", "PROMPT.md");
export const OUTCOME_SCHEMA = join(PACKAGE_ROOT, "schemas", "outcome.schema.json");

/** The hook command written into the session settings. */
export function hookCommand(config) {
  return [process.execPath, BIN, "guard", "--config", config.configPath].map(shellQuote).join(" ");
}

/** Writes the per-run settings (the guard hook) and an empty MCP configuration; returns their paths. */
export function writeRunFiles(config) {
  const P = paths(config.stateDir);
  mkdirSync(P.run, { recursive: true });
  const settingsPath = join(P.run, "settings.json");
  const mcpPath = join(P.run, "mcp.json");
  const settings = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(config), timeout: 30 }] }] } };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  return { settingsPath, mcpPath };
}

/** Runs the real hook process on two payloads: a push must be blocked, a status allowed. */
export function guardSelfTest(config, env) {
  const run = (command) => spawnSync(process.execPath, [BIN, "guard", "--config", config.configPath], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: config.root }), encoding: "utf8", env, timeout: 30_000 });
  const push = run("git " + "push");
  const status = run("git status");
  const problems = [];
  if (push.status !== 2) problems.push(`guard self-test: a push was not blocked (exit ${push.status}) ${push.stderr ?? ""}`.trim());
  if (status.status !== 0) problems.push(`guard self-test: git status was blocked (exit ${status.status}) ${status.stderr ?? ""}`.trim());
  return problems;
}

/**
 * @returns {{ problems: string[], warnings: string[], info: string[] }}
 */
export function preflight(config, env, { cli = true } = {}) {
  const problems = [];
  const warnings = [];
  const info = [];
  const cat = loadCatalog(config.catalog);
  if (cat.errors.length) problems.push(...cat.errors.map((e) => `catalog: ${e}`));
  else info.push(`catalog: ${cat.techniques.filter((t) => !t.internal).length} techniques`);
  if (!isRepo(config.root)) problems.push(`${config.root} is not a git repository`);
  else {
    const rel = relative(config.root, config.stateDir);
    if (!rel.startsWith("..")) {
      const ig = spawnSync("git", ["check-ignore", "-q", rel], { cwd: config.root });
      if (ig.status !== 0) warnings.push(`${rel}/ is not ignored by git: add it to .gitignore`);
    }
  }
  const prompt = config.prompt ?? DEFAULT_PROMPT;
  try {
    readFileSync(prompt, "utf8");
  } catch {
    problems.push(`prompt template not readable: ${prompt}`);
  }
  const auth = authPreflight(env, config.agent);
  problems.push(...auth.problems);
  warnings.push(...auth.warnings);
  if (cli && config.agent.adapter === "claude-cli") {
    const r = preflightCli(config, env);
    problems.push(...r.problems);
    warnings.push(...r.warnings);
    if (r.version) info.push(`agent CLI: ${r.version}`);
  }
  if (config.agent.adapter === "agent-sdk") warnings.push("agent.adapter agent-sdk is experimental and untested against the real SDK");
  const g = config.guard ?? {};
  if (g.publish === false) warnings.push("guard.publish is false: the guard will not block publishing");
  if (g.destructive === false) warnings.push("guard.destructive is false: the guard will not block destructive commands");
  if (existsSync(dirname(config.configPath ?? "")) && config.configPath) problems.push(...guardSelfTest(config, env));
  if (!problems.some((p) => p.startsWith("guard self-test"))) info.push("guard self-test: push blocked, status allowed");
  return { problems, warnings, info };
}
