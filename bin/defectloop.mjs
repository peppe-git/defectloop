#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// defectloop command line. `defectloop help` lists the commands.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runHook } from "../src/guard/hook.mjs";
import { preflight } from "../src/preflight.mjs";
import { search, statusText, writeReport } from "../src/report.mjs";
import { launchdPlist, systemdUnit } from "../src/service.mjs";
import { globalHome, isAlive, paths, readState, writeJson } from "../src/state.mjs";
import { runLoop } from "../src/supervisor.mjs";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;

const USAGE = `usage: defectloop <command> [options]

  init                         write defectloop.config.json and defectloop.catalog.json (never overwrites)
  check                        offline preflight: config, catalog, git, agent CLI, API key, guard self-test
  run [--once] [--max-rounds N] [--env-file F]
                               run rounds until stopped, halted or out of rounds
  status                       what the loop is doing now
  report                       write .defectloop/REPORT.md with everything found
  search <words>               search the findings record (exit 0 = found, 1 = nothing)
  pause | resume [--global] | stop [--global]
                               finish the round and wait | clear kill switch, pause and halt | kill switch
  service <systemd|launchd>    print a user service definition (installs nothing)
  guard --config F             PreToolUse hook entry point (used by the agent, not by you)

options: --config <path> (default ./defectloop.config.json), --version, help`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const configPath = resolve(opt("--config") ?? process.env.DEFECTLOOP_CONFIG ?? "defectloop.config.json");

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function config() {
  try {
    return loadConfig(configPath);
  } catch (err) {
    die(`defectloop: ${err.message}\n(run \`defectloop init\` to create a configuration)`);
  }
}

/** KEY=VALUE lines; refused when readable by group or others (POSIX). */
function readEnvFile(file) {
  const st = statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) die(`defectloop: ${file} is readable by other users: chmod 600 ${file}`);
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

async function main() {
  switch (cmd) {
    case "guard": {
      let stdin = "";
      try {
        stdin = readFileSync(0, "utf8");
      } catch {
        /* empty stdin: runHook blocks */
      }
      const r = runHook({ stdin, args: argv.slice(1) });
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.code);
    }
    case "init": {
      const cfg = resolve("defectloop.config.json");
      const cat = resolve("defectloop.catalog.json");
      for (const [src, dst] of [[join(PKG, "templates", "defectloop.config.json"), cfg], [join(PKG, "templates", "catalog.example.json"), cat]]) {
        if (existsSync(dst)) console.log(`kept existing ${dst}`);
        else {
          copyFileSync(src, dst);
          console.log(`wrote ${dst}`);
        }
      }
      console.log("\nnext: add .defectloop/ to .gitignore, set the budget in defectloop.config.json, export ANTHROPIC_API_KEY, run `defectloop check`.");
      return;
    }
    case "check": {
      const c = config();
      const r = preflight(c, process.env);
      for (const i of r.info) console.log(`✓ ${i}`);
      for (const w of r.warnings) console.log(`! ${w}`);
      for (const p of r.problems) console.log(`✖ ${p}`);
      console.log(`budget: up to $${c.budget.perRoundUsd} per round${c.budget.dailyUsd ? `, $${c.budget.dailyUsd} per day` : ""}${c.budget.monthlyUsd ? `, $${c.budget.monthlyUsd} per month` : ""}`);
      if (r.problems.length) process.exit(1);
      console.log("ready: defectloop run");
      return;
    }
    case "run": {
      const envFile = opt("--env-file");
      const env = envFile ? { ...process.env, ...readEnvFile(resolve(envFile.replace(/^~(?=\/)/, process.env.HOME ?? ""))) } : process.env;
      const ctrl = new AbortController();
      process.on("SIGTERM", () => ctrl.abort());
      process.on("SIGINT", () => ctrl.abort());
      const max = opt("--max-rounds");
      const r = await runLoop({ configPath, env, once: flag("--once"), maxRounds: max ? Number(max) : Infinity, signal: ctrl.signal });
      console.log(`defectloop: ${r.exit}${r.reason ? ` — ${r.reason}` : ""}`);
      // halted and stopped exit 0 on purpose: a service manager must not restart them in a loop
      process.exit(r.exit === "preflight-failed" || r.exit === "locked" ? 1 : 0);
    }
    case "status":
      console.log(statusText(config()));
      return;
    case "report":
      console.log(writeReport(config()));
      return;
    case "search": {
      const words = argv.slice(1).filter((x, i, a) => x !== "--config" && a[i - 1] !== "--config").join(" ");
      const found = search(config(), words);
      for (const r of found.slice(-30)) console.log(`[${r.status}] ${r.title} — ${r.location || "?"} (${r.round}${r.commit ? `, ${r.commit}` : ""})\n    evidence: ${String(r.evidence ?? "").slice(0, 240)}`);
      console.log(found.length ? `${found.length} findings.` : "New ground: nothing in the record.");
      process.exit(found.length ? 0 : 1);
    }
    case "stop": {
      if (flag("--global")) {
        mkdirSync(globalHome(), { recursive: true });
        writeFileSync(join(globalHome(), "STOP"), `${new Date().toISOString()}\n`);
        console.log(`global kill switch engaged: ${join(globalHome(), "STOP")} (every loop of this user stops)`);
        return;
      }
      const P = paths(config().stateDir);
      mkdirSync(P.dir, { recursive: true });
      writeFileSync(P.stop, `${new Date().toISOString()}\n`);
      console.log("kill switch engaged: the current session is stopped within seconds; nothing restarts until `defectloop resume`.");
      return;
    }
    case "pause": {
      const P = paths(config().stateDir);
      mkdirSync(P.dir, { recursive: true });
      writeFileSync(P.pause, "");
      console.log("paused: the current round finishes, then the loop waits. `defectloop resume` to continue.");
      return;
    }
    case "resume": {
      if (flag("--global")) {
        rmSync(join(globalHome(), "STOP"), { force: true });
        console.log("global kill switch removed.");
        return;
      }
      const c = config();
      const P = paths(c.stateDir);
      rmSync(P.stop, { force: true });
      rmSync(P.pause, { force: true });
      const pid = existsSync(P.lock) ? Number(readFileSync(P.lock, "utf8")) : 0;
      if (pid && isAlive(pid)) writeFileSync(join(P.dir, "RESUME"), "");
      else if (existsSync(P.state)) {
        const st = readState(P.state);
        writeJson(P.state, { ...st, halted: null, waitUntil: 0, waitReason: "", consecutiveFailures: 0 });
      }
      console.log("resumed: kill switch, pause, halt and waits cleared. Start it with `defectloop run` if it is not running.");
      return;
    }
    case "service": {
      const kind = argv[1];
      const c = config();
      const args = { node: process.execPath, bin: join(PKG, "bin", "defectloop.mjs"), config: c.configPath, root: c.root, stateDir: c.stateDir, envFile: join(globalHome(), "env"), label: `io.defectloop.${c.root.split(/[\\/]/).pop().replace(/[^A-Za-z0-9.-]/g, "-")}` };
      if (kind === "systemd") process.stdout.write(systemdUnit(args));
      else if (kind === "launchd") process.stdout.write(launchdPlist(args));
      else die("usage: defectloop service <systemd|launchd>");
      return;
    }
    case "--version":
    case "version":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return;
    default:
      die(`unknown command "${cmd}"\n${USAGE}`);
  }
}

main().catch((err) => die(`defectloop: ${err.stack ?? err}`));
