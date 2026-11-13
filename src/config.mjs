// SPDX-License-Identifier: Apache-2.0
//
// Configuration: defaults, validation, path resolution. See docs/configuration.md and
// schemas/config.schema.json. Unknown keys are errors: a typo must never silently disable a cap.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateBudget } from "./budget.mjs";
import { DEFAULT_SCORING } from "./scheduler.mjs";
import { GUARD_KEYS } from "./guard/rules.mjs";

export const AUTH_MODES = ["api-key", "bedrock", "vertex", "foundry"];
export const PERMISSION_MODES = ["dontAsk", "acceptEdits", "default", "manual", "auto"];
export const ADAPTERS = ["claude-cli", "agent-sdk"];

export const DEFAULTS = Object.freeze({
  root: ".",
  stateDir: ".defectloop",
  catalog: "defectloop.catalog.json",
  prompt: null,
  agent: {
    adapter: "claude-cli",
    command: "claude",
    auth: "api-key",
    verifyAuthSource: true,
    model: null,
    fallbackModel: null,
    effort: null,
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    disallowedTools: ["WebSearch", "AskUserQuestion", "CronCreate", "CronDelete", "ScheduleWakeup", "RemoteTrigger", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree"],
    settingSources: ["project"],
    mcpConfig: null,
    maxTurns: null,
    extraArgs: [],
  },
  loop: {
    maxRoundMinutes: 60,
    maxSilenceMinutes: 20,
    secondsBetweenRounds: 20,
    maxConsecutiveFailures: 3,
    maxWaitHours: 24,
    keepRounds: 300,
    acceptProposedTechniques: false,
    onBudgetExhausted: "wait",
    watchdogMs: 2000,
  },
  scoring: { ...DEFAULT_SCORING },
  areas: { discover: [], list: [], priority: [] },
  capabilities: {},
  guard: {},
  alerts: { command: null },
});

const TOP_KEYS = ["$schema", "root", "stateDir", "catalog", "prompt", "agent", "loop", "budget", "scoring", "areas", "capabilities", "guard", "alerts"];

function unknownKeys(obj, allowed, where, errors) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

const abs = (base, p) => (p == null ? p : isAbsolute(p) ? p : resolve(base, p));

/**
 * @param {object} raw parsed JSON
 * @param {{ configDir: string }} where
 * @returns {{ config: object, errors: string[] }}
 */
export function resolveConfig(raw, { configDir }) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, errors: ["configuration must be a JSON object"] };
  unknownKeys(raw, TOP_KEYS, "config", errors);
  unknownKeys(raw.agent, Object.keys(DEFAULTS.agent), "agent", errors);
  unknownKeys(raw.loop, Object.keys(DEFAULTS.loop), "loop", errors);
  unknownKeys(raw.scoring, Object.keys(DEFAULTS.scoring), "scoring", errors);
  unknownKeys(raw.areas, Object.keys(DEFAULTS.areas), "areas", errors);
  unknownKeys(raw.alerts, Object.keys(DEFAULTS.alerts), "alerts", errors);
  unknownKeys(raw.guard, GUARD_KEYS, "guard", errors);
  unknownKeys(raw.budget, ["perRoundUsd", "dailyUsd", "monthlyUsd"], "budget", errors);

  const agent = { ...DEFAULTS.agent, ...(raw.agent ?? {}) };
  const loop = { ...DEFAULTS.loop, ...(raw.loop ?? {}) };
  const scoring = { ...DEFAULTS.scoring, ...(raw.scoring ?? {}) };
  const areas = { ...DEFAULTS.areas, ...(raw.areas ?? {}) };
  errors.push(...validateBudget(raw.budget));

  if (!ADAPTERS.includes(agent.adapter)) errors.push(`agent.adapter must be one of ${ADAPTERS.join(", ")}`);
  if (!AUTH_MODES.includes(agent.auth)) errors.push(`agent.auth must be one of ${AUTH_MODES.join(", ")}; subscription logins are not supported (see docs/costs.md)`);
  if (!PERMISSION_MODES.includes(agent.permissionMode)) errors.push(`agent.permissionMode must be one of ${PERMISSION_MODES.join(", ")} (bypassPermissions is refused)`);
  const cmdOk = (typeof agent.command === "string" && agent.command) || (Array.isArray(agent.command) && agent.command.length && agent.command.every((x) => typeof x === "string" && x));
  if (!cmdOk) errors.push("agent.command must be a program name or a non-empty array of strings");
  for (const k of ["allowedTools", "disallowedTools", "extraArgs"]) if (!Array.isArray(agent[k]) || agent[k].some((x) => typeof x !== "string")) errors.push(`agent.${k} must be an array of strings`);
  if (agent.settingSources !== null && (!Array.isArray(agent.settingSources) || !agent.settingSources.length || agent.settingSources.some((s) => !["user", "project", "local"].includes(s)))) errors.push('agent.settingSources must be null (the agent\'s default) or a non-empty array of "user", "project", "local"');
  if (agent.maxTurns !== null && (!Number.isInteger(agent.maxTurns) || agent.maxTurns < 1)) errors.push("agent.maxTurns must be null or a positive integer");
  if (agent.extraArgs.some((a) => /dangerously|bypass|^--bare$/.test(a))) errors.push("agent.extraArgs may not disable permissions or hooks (--dangerously-*, bypass, --bare)");

  const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  for (const k of ["maxRoundMinutes", "maxSilenceMinutes", "maxWaitHours", "watchdogMs"]) if (!posNum(loop[k])) errors.push(`loop.${k} must be a positive number`);
  if (!(typeof loop.secondsBetweenRounds === "number" && loop.secondsBetweenRounds >= 0)) errors.push("loop.secondsBetweenRounds must be >= 0");
  for (const k of ["maxConsecutiveFailures", "keepRounds"]) if (!Number.isInteger(loop[k]) || loop[k] < 1) errors.push(`loop.${k} must be a positive integer`);
  if (!["wait", "halt"].includes(loop.onBudgetExhausted)) errors.push('loop.onBudgetExhausted must be "wait" or "halt"');
  if (typeof loop.acceptProposedTechniques !== "boolean") errors.push("loop.acceptProposedTechniques must be a boolean");
  for (const [k, v] of Object.entries(scoring)) if (!(typeof v === "number" && v >= 0)) errors.push(`scoring.${k} must be a number >= 0`);
  if (!Number.isInteger(scoring.queueEvery) || scoring.queueEvery < 1) errors.push("scoring.queueEvery must be a positive integer");

  for (const [k, v] of Object.entries(raw.capabilities ?? {})) {
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) errors.push(`capabilities.${k} must be a command as an array of strings, e.g. ["docker", "info"]`);
  }
  if (!Array.isArray(areas.discover) || areas.discover.some((d) => typeof d?.dir !== "string" || typeof d?.kind !== "string")) errors.push('areas.discover must be an array of { "dir": "...", "kind": "..." }');
  if (!Array.isArray(areas.list) || areas.list.some((a) => typeof a?.key !== "string" || typeof a?.kind !== "string")) errors.push('areas.list must be an array of { "key": "...", "kind": "...", "name"?: "..." }');
  if (raw.alerts?.command != null && (!Array.isArray(raw.alerts.command) || raw.alerts.command.some((x) => typeof x !== "string"))) errors.push("alerts.command must be null or an array of strings");

  const root = abs(configDir, raw.root ?? DEFAULTS.root);
  const config = {
    root,
    configPath: null,
    stateDir: abs(root, raw.stateDir ?? DEFAULTS.stateDir),
    catalog: abs(root, raw.catalog ?? DEFAULTS.catalog),
    prompt: raw.prompt ? abs(root, raw.prompt) : null,
    agent: { ...agent, mcpConfig: agent.mcpConfig ? abs(root, agent.mcpConfig) : null },
    loop,
    budget: raw.budget ? { ...raw.budget } : undefined,
    scoring,
    areas,
    capabilities: { ...(raw.capabilities ?? {}) },
    guard: raw.guard ?? {},
    alerts: { ...DEFAULTS.alerts, ...(raw.alerts ?? {}) },
  };
  return { config, errors };
}

/** Reads and resolves a configuration file. Throws with all errors joined when invalid. */
export function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read configuration ${path}: ${err.message}`);
  }
  const { config, errors } = resolveConfig(raw, { configDir: dirname(resolve(path)) });
  if (errors.length) throw new Error(`invalid configuration ${path}:\n  - ${errors.join("\n  - ")}`);
  config.configPath = resolve(path);
  return config;
}
