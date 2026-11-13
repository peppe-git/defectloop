// SPDX-License-Identifier: Apache-2.0
//
// The guard as a Claude Code PreToolUse hook: reads the payload on stdin, exits 2 with the reason on
// stderr to block (the reason goes back to the model), exits 0 to allow. Fail-closed: unreadable
// input or configuration blocks.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { globalHome } from "../state.mjs";
import { evaluate, recentlyModified, resolvePolicy } from "./rules.mjs";

/** Builds the evaluation context for a loaded configuration. */
export function guardContext(config, env = process.env) {
  const policy = resolvePolicy(config.guard);
  const skip = [config.stateDir, ...(policy.sharedWorkingTree.ignore ?? []).map((p) => join(config.root, p))];
  return {
    root: config.root,
    home: env.HOME || homedir(),
    stateDir: config.stateDir,
    policy,
    protectedFiles: [config.configPath, config.catalog, config.prompt].filter(Boolean),
    tmpDirs: [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"])],
    round: env.DEFECTLOOP_ROUND || null,
    globalDir: globalHome(env),
    recentFiles: () => recentlyModified(config.root, { windowMs: policy.sharedWorkingTree.windowSeconds * 1000, skip }),
  };
}

/**
 * @param {{ stdin: string, args: string[], env?: object }} io
 * @returns {{ code: 0|2, stderr: string }}
 */
export function runHook({ stdin, args, env = process.env }) {
  const block = (why) => ({ code: 2, stderr: `defectloop guard: ${why}\n` });
  const i = args.indexOf("--config");
  const configPath = i >= 0 ? args[i + 1] : env.DEFECTLOOP_CONFIG;
  if (!configPath) return block("no --config given to the guard: blocked by default");
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    return block(`configuration unreadable or invalid, blocked by default (${String(err.message).split("\n")[0]})`);
  }
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return block("hook input is unreadable (invalid JSON): blocked by default");
  }
  const why = evaluate(payload, guardContext(config, env));
  return why ? block(why) : { code: 0, stderr: "" };
}
