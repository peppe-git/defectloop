// SPDX-License-Identifier: Apache-2.0
//
// Files of the state directory (default `.defectloop/`, not versioned) and small I/O helpers.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export function paths(stateDir) {
  return {
    dir: stateDir,
    state: join(stateDir, "state.json"),
    rounds: join(stateDir, "rounds.jsonl"),
    findings: join(stateDir, "findings.jsonl"),
    ledger: join(stateDir, "ledger.jsonl"),
    journal: join(stateDir, "journal.log"),
    alerts: join(stateDir, "ALERTS.md"),
    report: join(stateDir, "REPORT.md"),
    context: join(stateDir, "context.md"),
    extra: join(stateDir, "catalog-extra.json"),
    stop: join(stateDir, "STOP"),
    pause: join(stateDir, "PAUSE"),
    lock: join(stateDir, "supervisor.pid"),
    roundsDir: join(stateDir, "rounds"),
    run: join(stateDir, "run"),
    tmp: join(stateDir, "tmp"),
  };
}

/** The user-wide directory holding the global kill switch. */
export function globalHome(env = process.env) {
  if (env.DEFECTLOOP_HOME) return env.DEFECTLOOP_HOME;
  if (platform() === "win32" && env.APPDATA) return join(env.APPDATA, "defectloop");
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "defectloop");
}

export function roundId(n) {
  return `round-${String(n).padStart(4, "0")}`;
}

/** Local date YYYY-MM-DD. */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic write: a reader sees the old file or the new one, never half of it. */
export function writeJson(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, p);
}

export function appendJsonl(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(value)}\n`);
}

export function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unreadable: true };
      }
    });
}

export const EMPTY_STATE = Object.freeze({ version: 1, round: 0, consecutiveFailures: 0, waitUntil: 0, waitReason: "", halted: null, stats: {}, coverage: {}, queue: [], foreign: [], leftovers: [] });

export function readState(file) {
  return { ...structuredClone(EMPTY_STATE), ...readJson(file, {}) };
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
