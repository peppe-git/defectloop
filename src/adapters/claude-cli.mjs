// SPDX-License-Identifier: Apache-2.0
//
// Adapter for the Claude Code CLI in headless mode:
//   claude -p --output-format stream-json --verbose … (prompt on stdin)
// One process per round, in its own process group so that the whole tree (background servers the
// session started included) can be stopped.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { platform } from "node:os";

export const ADAPTER_NAME = "claude-cli";

/** Flags the adapter always passes; `check` verifies they appear in `--help`. */
export const REQUIRED_FLAGS = ["-p", "--output-format", "--verbose", "--permission-mode", "--permission-prompts", "--allowedTools", "--disallowedTools", "--settings", "--strict-mcp-config", "--mcp-config", "--no-session-persistence", "--max-budget-usd"];

export function commandOf(agent) {
  return Array.isArray(agent.command) ? { bin: agent.command[0], pre: agent.command.slice(1) } : { bin: agent.command, pre: [] };
}

/** The CLI arguments of a round. */
export function buildArgs(config, { settingsPath, mcpPath }) {
  const a = config.agent;
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", a.permissionMode,
    "--permission-prompts", "none",
    "--allowedTools", a.allowedTools.join(","),
    "--disallowedTools", a.disallowedTools.join(","),
    "--settings", settingsPath,
    "--strict-mcp-config",
    "--mcp-config", a.mcpConfig ?? mcpPath,
    "--no-session-persistence",
    "--max-budget-usd", String(config.budget.perRoundUsd),
  ];
  if (a.settingSources) args.push("--setting-sources", a.settingSources.join(","));
  if (a.model) args.push("--model", a.model);
  if (a.fallbackModel) args.push("--fallback-model", a.fallbackModel);
  if (a.effort) args.push("--effort", a.effort);
  if (a.maxTurns) args.push("--max-turns", String(a.maxTurns));
  return [...args, ...a.extraArgs];
}

/** Offline check of the installed CLI: it runs, and its help lists every flag the adapter needs. */
export function preflightCli(config, env) {
  const { bin, pre } = commandOf(config.agent);
  const problems = [];
  const warnings = [];
  const v = spawnSync(bin, [...pre, "--version"], { encoding: "utf8", env, timeout: 30_000 });
  if (v.error || v.status !== 0) return { problems: [`cannot run the agent CLI "${bin}": ${v.error?.message ?? (v.stderr || "").trim().slice(0, 200)}`], warnings, version: null };
  const h = spawnSync(bin, [...pre, "--help"], { encoding: "utf8", env, timeout: 30_000 });
  const help = `${h.stdout ?? ""}\n${h.stderr ?? ""}`;
  const a = config.agent;
  const needed = [...REQUIRED_FLAGS, ...(a.settingSources ? ["--setting-sources"] : []), ...(a.model ? ["--model"] : []), ...(a.fallbackModel ? ["--fallback-model"] : []), ...(a.effort ? ["--effort"] : [])];
  for (const f of needed) {
    const re = new RegExp(`(^|[\\s,])${f.replace(/[-]/g, "\\-")}(?![\\w-])`, "m");
    if (!re.test(help)) problems.push(`the agent CLI does not list ${f} in --help: this version is not compatible with the adapter (update it, or report the change)`);
  }
  return { problems, warnings, version: (v.stdout || "").trim().split("\n")[0] };
}

/**
 * Starts a session.
 * @returns {{ pid: number, lines: AsyncIterable<string>, stderrTail: () => string, kill: (graceMs?: number) => void, exited: Promise<{ code: number|null, signal: string|null }> }}
 */
export function startCli({ config, prompt, env, cwd, settingsPath, mcpPath }) {
  const { bin, pre } = commandOf(config.agent);
  const posix = platform() !== "win32";
  const child = spawn(bin, [...pre, ...buildArgs(config, { settingsPath, mcpPath })], { cwd, env, detached: posix, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let tail = "";
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  let settled = false;
  const settle = (v) => {
    if (!settled) {
      settled = true;
      resolveExit(v);
    }
  };
  child.on("error", (err) => {
    tail = `${tail}\n${err.message}`.slice(-4000);
    settle({ code: 127, signal: null });
  });
  child.on("close", (code, signal) => settle({ code, signal }));
  child.stderr.on("data", (c) => {
    tail = (tail + c.toString()).slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const killTree = (sig) => {
    if (!child.pid) return;
    if (posix) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    } else {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
  };
  // background tasks the session started stay in its process group: they go with it
  exited.then(() => killTree("SIGTERM"));

  return {
    pid: child.pid,
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    stderrTail: () => tail,
    kill: (graceMs = 10_000) => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), graceMs).unref();
    },
    exited,
  };
}

/** POSIX single-quote, Windows double-quote: for the hook command line in the settings file. */
export function shellQuote(s) {
  if (platform() === "win32") return `"${String(s).replace(/"/g, '\\"')}"`;
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
