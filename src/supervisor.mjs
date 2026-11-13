// SPDX-License-Identifier: Apache-2.0
//
// The supervisor: runs rounds until something says stop. Each round is a fresh agent session with a
// clean context. Between rounds it decides what to do (scheduler), checks the budget and the kill
// switch, and reacts to what can go wrong (limits, crashes, hung sessions, unrecognised output).
//
// Everything that decides lives in pure modules (scheduler, limits, stream, budget, outcome); this
// file is the I/O around them. Clock, sleep and adapters are injectable for the tests.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentEnv } from "./adapters/env.mjs";
import { startCli } from "./adapters/claude-cli.mjs";
import { startSdk } from "./adapters/agent-sdk.mjs";
import { budgetGate, roundCharge, spendSoFar } from "./budget.mjs";
import { CLEANUP_ID, loadCatalog } from "./catalog.mjs";
import { loadConfig } from "./config.mjs";
import { composeContext, renderPrompt } from "./context.mjs";
import { TRAILER_KEY, commitCount, dirtyFiles, head, roundCommits } from "./git.mjs";
import { guardContext } from "./guard/hook.mjs";
import { evaluate } from "./guard/rules.mjs";
import { journalLines } from "./journal.mjs";
import { checkAuthSource, classifyRoundEnd, nextAction } from "./limits.mjs";
import { fingerprint, normalizeOutcome } from "./outcome.mjs";
import { DEFAULT_PROMPT, OUTCOME_SCHEMA, preflight, writeRunFiles } from "./preflight.mjs";
import { pickCampaign, updateStats } from "./scheduler.mjs";
import { appendJsonl, globalHome, isAlive, localDate, paths, readJson, readJsonl, readState, roundId, writeJson } from "./state.mjs";
import { createStreamMonitor } from "./stream.mjs";

export const ROUND_RECORD_VERSION = 1;
const MIN = 60_000;

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function hhmmss(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** Areas: subdirectories of `areas.discover[].dir` plus `areas.list`. */
export function discoverAreas(config) {
  const out = [];
  for (const d of config.areas.discover) {
    let entries = [];
    try {
      entries = readdirSync(join(config.root, d.dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) out.push({ key: `${d.dir.replace(/\/$/, "")}/${e.name}`, name: e.name, kind: d.kind });
  }
  for (const a of config.areas.list) out.push({ key: a.key, name: a.name ?? a.key, kind: a.kind });
  return out;
}

/** Capability probes: each is a command; exit 0 means available. */
export function probeCapabilities(config, env) {
  const ok = [];
  for (const [name, argv] of Object.entries(config.capabilities)) {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: config.root, env, stdio: "ignore", timeout: 20_000 });
    if (r.status === 0) ok.push(name);
  }
  return ok;
}

/**
 * @param {{ configPath: string, env?: object, once?: boolean, maxRounds?: number, clock?: { now: () => number, sleep: (ms: number) => Promise<void> }, log?: (line: string) => void, signal?: AbortSignal, sdkLoader?: Function, skipPreflightCli?: boolean }} opts
 * @returns {Promise<{ exit: string, reason?: string, rounds: number, until?: number }>}
 */
export async function runLoop(opts) {
  const { configPath, env = process.env, once = false, maxRounds = Infinity, clock = realClock, log = (l) => process.stdout.write(`${l}\n`), signal } = opts;
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    return { exit: "preflight-failed", reason: err.message, rounds: 0 };
  }
  const P = paths(config.stateDir);
  for (const d of [P.dir, P.roundsDir, P.run, P.tmp]) mkdirSync(d, { recursive: true });
  const gHome = globalHome(env);
  let current = "—";

  const journal = (line) => {
    const text = `[${hhmmss(clock.now())}] ${current} · ${line}`;
    try {
      if (existsSync(P.journal) && statSync(P.journal).size > 20 * 1024 * 1024) renameSync(P.journal, `${P.journal}.1`);
      appendFileSync(P.journal, `${text}\n`);
    } catch {
      /* the journal must never stop the loop */
    }
    log(text);
  };
  const lastAlert = {};
  const alert = (key, title, text) => {
    const t = clock.now();
    if (lastAlert[key] && t - lastAlert[key] < 3600_000) return;
    lastAlert[key] = t;
    appendFileSync(P.alerts, `- ${new Date(t).toISOString().slice(0, 16).replace("T", " ")} · **${title}** — ${text}\n`);
    journal(`⚠ ${title}: ${text}`);
    const cmd = config.alerts.command;
    if (cmd) {
      try {
        const c = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"], env, detached: false });
        c.on("error", () => {});
        c.stdin.on("error", () => {});
        c.stdin.end(JSON.stringify({ title, text, key, stateDir: P.dir }));
        setTimeout(() => c.kill(), 10_000).unref();
      } catch {
        /* alerts are best effort */
      }
    }
  };
  const stopRequested = () => existsSync(P.stop) || existsSync(join(gHome, "STOP")) || Boolean(signal?.aborted);
  const save = (st, extra = {}) => {
    Object.assign(st, extra, { heartbeat: clock.now(), pid: process.pid });
    writeJson(P.state, st);
  };
  const sleepChecking = async (ms) => {
    const until = clock.now() + ms;
    while (clock.now() < until && !stopRequested()) await clock.sleep(Math.min(5000, until - clock.now()));
  };

  if (stopRequested()) {
    journal("kill switch engaged (STOP file or signal): not starting. `defectloop resume` removes it.");
    return { exit: "stopped", reason: "kill switch", rounds: 0 };
  }
  const initial = readState(P.state);
  if (initial.halted) {
    journal(`halted earlier (${initial.halted.reason}): not starting. Read ALERTS.md, then \`defectloop resume\`.`);
    return { exit: "halted", reason: initial.halted.reason, rounds: 0 };
  }
  const pf = preflight(config, env, { cli: !opts.skipPreflightCli });
  for (const w of pf.warnings) journal(`! ${w}`);
  if (pf.problems.length) {
    for (const p of pf.problems) journal(`✖ ${p}`);
    return { exit: "preflight-failed", reason: pf.problems.join("\n"), rounds: 0 };
  }

  // lock: one supervisor per state directory
  const other = existsSync(P.lock) ? Number(readFileSync(P.lock, "utf8").trim()) || 0 : 0;
  if (other && other !== process.pid && isAlive(other)) return { exit: "locked", reason: `another supervisor is alive (pid ${other})`, rounds: 0 };
  writeFileSync(P.lock, String(process.pid));

  try {
    const st0 = readState(P.state);
    // what is dirty now and was not left by the loop belongs to someone else: never touched
    st0.foreign = dirtyFiles(config.root, config.stateDir).filter((f) => !st0.leftovers.includes(f));
    st0.startedAt = new Date(clock.now()).toISOString();
    save(st0, { phase: "starting" });
    journal(`supervisor started (pid ${process.pid})${st0.foreign.length ? ` · ${st0.foreign.length} foreign files excluded` : ""}`);
    const runFiles = writeRunFiles(config);

    let done = 0;
    for (;;) {
      current = "—";
      if (stopRequested()) {
        journal("STOP: the loop stops");
        return { exit: "stopped", reason: "kill switch", rounds: done };
      }
      const st = readState(P.state);
      if (existsSync(join(P.dir, "RESUME"))) {
        unlinkSync(join(P.dir, "RESUME"));
        Object.assign(st, { waitUntil: 0, waitReason: "", consecutiveFailures: 0 });
        journal("RESUME: wait cleared");
      }
      if (st.halted) return { exit: "halted", reason: st.halted.reason, rounds: done };
      if (existsSync(P.pause)) {
        save(st, { phase: "paused" });
        if (once) return { exit: "paused", rounds: done };
        await clock.sleep(5000);
        continue;
      }
      if (st.waitUntil && clock.now() < st.waitUntil) {
        save(st, { phase: "waiting" });
        if (once) return { exit: "waiting", reason: st.waitReason, until: st.waitUntil, rounds: done };
        await sleepChecking(st.waitUntil - clock.now());
        continue;
      }
      if (done >= maxRounds) return { exit: "max-rounds", rounds: done };

      const gate = budgetGate({ ledger: readJsonl(P.ledger), budget: config.budget, now: clock.now() });
      if (!gate.ok) {
        if (config.loop.onBudgetExhausted === "halt") {
          st.halted = { kind: "budget", reason: gate.reason, at: new Date(clock.now()).toISOString() };
          save(st, { phase: "halted" });
          alert("budget", "Budget exhausted, loop halted", gate.reason);
          return { exit: "halted", reason: gate.reason, rounds: done };
        }
        save(st, { phase: "waiting", waitUntil: gate.retryAt, waitReason: gate.reason });
        alert("budget", "Budget reached", `${gate.reason}; waiting until ${new Date(gate.retryAt).toLocaleString()}`);
        if (once) return { exit: "waiting", reason: gate.reason, until: gate.retryAt, rounds: done };
        continue;
      }

      let outcome;
      try {
        outcome = await runRound({ config, P, st, env, clock, journal, alert, stopRequested, runFiles, setCurrent: (id) => (current = id), sdkLoader: opts.sdkLoader });
      } catch (err) {
        journal(`supervisor error: ${err.stack ?? err}`);
        const s2 = readState(P.state);
        s2.consecutiveFailures += 1;
        if (s2.consecutiveFailures >= config.loop.maxConsecutiveFailures) {
          s2.halted = { kind: "supervisor-error", reason: String(err.message ?? err), at: new Date(clock.now()).toISOString() };
          save(s2, { phase: "halted", current: null });
          alert("halt", "Loop halted", s2.halted.reason);
          return { exit: "halted", reason: s2.halted.reason, rounds: done };
        }
        save(s2, { phase: "waiting", current: null, waitUntil: clock.now() + 2 * MIN * s2.consecutiveFailures, waitReason: `supervisor error: ${String(err.message ?? err).slice(0, 160)}` });
        continue;
      }
      if (outcome.ran) done += 1;
      if (outcome.action === "stop") return { exit: "stopped", reason: "kill switch", rounds: done };
      if (outcome.action === "halt") return { exit: "halted", reason: outcome.reason, rounds: done };
      if (once && outcome.ran) return { exit: "once", rounds: done };
      if (done < maxRounds) await sleepChecking(config.loop.secondsBetweenRounds * 1000);
    }
  } finally {
    try {
      if (readFileSync(P.lock, "utf8") === String(process.pid)) unlinkSync(P.lock);
    } catch {
      /* already gone */
    }
  }
}

async function runRound({ config, P, st, env, clock, journal, alert, stopRequested, runFiles, setCurrent, sdkLoader }) {
  const now0 = clock.now();
  const n = st.round + 1;
  const id = roundId(n);
  const today = localDate(now0);
  const root = config.root;

  const catalog = loadCatalog(config.catalog, P.extra);
  if (catalog.errors.length) {
    st.halted = { kind: "catalog", reason: `catalog became invalid: ${catalog.errors[0]}`, at: new Date(now0).toISOString() };
    writeJson(P.state, st);
    alert("halt", "Loop halted", st.halted.reason);
    return { ran: false, action: "halt", reason: st.halted.reason };
  }
  const byId = new Map(catalog.techniques.map((t) => [t.id, t]));
  const capabilities = probeCapabilities(config, env);
  const areas = discoverAreas(config);
  const leftovers = dirtyFiles(root, config.stateDir).filter((f) => !st.foreign.includes(f));

  const campaign = leftovers.length
    ? { technique: byId.get(CLEANUP_ID), area: null, reason: `${leftovers.length} files left uncommitted by an interrupted round` }
    : pickCampaign({ techniques: catalog.techniques, stats: st.stats, queue: st.queue, round: n, capabilities, today, areas, coverage: st.coverage, priorityAreas: config.areas.priority, scoring: config.scoring });
  if (!campaign) {
    journal("no eligible technique (capabilities or daily caps): retrying in 10 minutes");
    writeJson(P.state, { ...st, phase: "waiting", waitUntil: now0 + 10 * MIN, waitReason: "no eligible technique" });
    return { ran: false, action: "wait" };
  }
  setCurrent(id);
  const t = campaign.technique;
  journal(`▶ ${t.id} ${t.name}${campaign.area ? ` · ${campaign.area.key}` : ""} (${campaign.reason})`);

  const spend = spendSoFar(readJsonl(P.ledger), now0, { fallbackUsd: config.budget.perRoundUsd });
  const trailer = `${TRAILER_KEY}: ${id}`;
  const context = composeContext({
    round: id,
    when: new Date(now0).toLocaleString(),
    campaign,
    capabilities,
    allCapabilities: Object.keys(config.capabilities),
    budget: { ...spend, ...config.budget },
    leftovers,
    foreign: st.foreign,
    findings: readJsonl(P.findings),
    queue: st.queue,
    referenceSha: st.stats[t.id]?.lastSha ?? null,
    trailer,
  });
  writeFileSync(P.context, context);
  writeFileSync(join(P.roundsDir, `${id}.context.md`), context);
  const outcomePath = join(P.roundsDir, `${id}.outcome.json`);
  rmSync(outcomePath, { force: true });
  const template = readFileSync(config.prompt ?? DEFAULT_PROMPT, "utf8");
  const prompt = renderPrompt(template, { ROUND: id, CONTEXT: P.context, OUTCOME: outcomePath, OUTCOME_SCHEMA, TRAILER: trailer, SCRATCH: P.tmp, MAX_MINUTES: config.loop.maxRoundMinutes });

  const startSha = head(root);
  st.round = n;
  if (campaign.queueIndex != null) st.queue.splice(campaign.queueIndex, 1);
  const started = Date.now();
  st.current = { round: id, technique: t.id, name: t.name, area: campaign.area?.key ?? null, reason: campaign.reason, startedAt: new Date(now0).toISOString(), events: 0, lastAction: "" };
  writeJson(P.state, { ...st, phase: "round", heartbeat: now0, pid: process.pid });

  const sessionEnv = agentEnv(env, config.agent, { DEFECTLOOP_ROUND: id, DEFECTLOOP_OUTCOME: outcomePath, DEFECTLOOP_STATE: P.dir, DEFECTLOOP_CONFIG: config.configPath });
  const monitor = createStreamMonitor();
  const transcript = join(P.roundsDir, `${id}.jsonl`);
  let killed = null;
  let lastEvent = Date.now();
  let session;
  if (config.agent.adapter === "agent-sdk") {
    const gctx = guardContext(config, sessionEnv);
    session = await startSdk({ config, prompt, env: sessionEnv, cwd: root, guard: (payload) => evaluate(payload, gctx), load: sdkLoader });
  } else {
    session = startCli({ config, prompt, env: sessionEnv, cwd: root, ...runFiles });
  }
  const kill = (reason) => {
    if (killed) return;
    killed = reason;
    journal(`✖ stopping the session: ${reason}`);
    session.kill();
  };
  const watchdog = setInterval(() => {
    const t2 = Date.now();
    const sum = monitor.summary();
    if (stopRequested()) kill("stop");
    else if (sum.problems.length) kill("format");
    else if (sum.init && checkAuthSource(sum.init, { mode: config.agent.auth, verify: config.agent.verifyAuthSource })) kill("auth-policy");
    else if (t2 - started > config.loop.maxRoundMinutes * MIN) kill("timeout");
    else if (t2 - lastEvent > config.loop.maxSilenceMinutes * MIN) kill("silence");
  }, config.loop.watchdogMs);

  let lastSave = 0;
  try {
    for await (const line of session.lines) {
      appendFileSync(transcript, `${line}\n`);
      const e = monitor.push(line);
      lastEvent = Date.now();
      if (!e) continue;
      st.current.events += 1;
      for (const l of journalLines(e)) {
        journal(l);
        if (!l.startsWith("»")) st.current.lastAction = l.slice(0, 160);
      }
      if (Date.now() - lastSave > 10_000) {
        lastSave = Date.now();
        writeJson(P.state, { ...st, phase: "round", heartbeat: clock.now(), pid: process.pid });
      }
    }
  } finally {
    clearInterval(watchdog);
  }
  const { code } = await session.exited;
  const nowEnd = clock.now();
  const minutes = Math.round((Date.now() - started) / 6000) / 10;
  const summary = monitor.summary();
  const areaKinds = [...new Set(areas.map((a) => a.kind))];
  const outcome = normalizeOutcome(readJson(outcomePath, null), { capabilities: Object.keys(config.capabilities), areaKinds });
  const killedReason = ["stop", "timeout", "silence"].includes(killed) ? killed : null;
  const end = classifyRoundEnd({ summary, exitCode: code ?? 1, killedReason, stderrTail: session.stderrTail(), outcome, authPolicy: { mode: config.agent.auth, verify: config.agent.verifyAuthSource }, now: nowEnd, maxWaitMs: config.loop.maxWaitHours * 60 * MIN });
  const decision = nextAction(end, { consecutiveFailures: st.consecutiveFailures, now: nowEnd, maxConsecutiveFailures: config.loop.maxConsecutiveFailures });

  const charge = roundCharge(summary, config.budget);
  appendJsonl(P.ledger, { at: new Date(nowEnd).toISOString(), round: id, costUsd: charge.costUsd, source: charge.source });

  const commits = roundCommits(root, startSha, id);
  const otherCommits = Math.max(0, commitCount(root, startSha) - commits.length);
  const shaEnd = head(root, true);
  st.leftovers = dirtyFiles(root, config.stateDir).filter((f) => !st.foreign.includes(f));

  const findings = outcome?.findings ?? [];
  const tried = ["completed", "timeout", "round-budget-exhausted"].includes(end.kind);
  if (tried && !end.halt) {
    st.stats = updateStats(st.stats, t.id, { findings, minutes, round: n, today, sha: shaEnd });
    if (campaign.area && areas.some((a) => a.key === campaign.area.key)) {
      st.coverage[t.id] ??= {};
      st.coverage[t.id][campaign.area.key] = n;
    }
    const seen = new Map(readJsonl(P.findings).map((r) => [r.fingerprint, r.round]));
    for (const f of findings) {
      const fp = fingerprint(f);
      const row = { ...f, round: id, date: today, technique: t.id, area: campaign.area?.key ?? null, fingerprint: fp };
      if (seen.has(fp) && f.status !== "fixed") row.duplicateOf = seen.get(fp);
      appendJsonl(P.findings, row);
    }
    for (const v of outcome?.followUps ?? []) {
      const dup = st.queue.some((q) => q.technique === v.technique && (q.area ?? "") === (v.area ?? ""));
      const justDone = v.technique === t.id && (v.area ?? "") === (campaign.area?.key ?? "");
      if (byId.has(v.technique) && !byId.get(v.technique).internal && !dup && !justDone) st.queue.push({ ...v, origin: id, originRound: n });
    }
    st.queue = st.queue.filter((v) => v.resume || n - (v.originRound ?? n) <= 40).slice(-15);
    if (outcome?.proposedTechnique && config.loop.acceptProposedTechniques) {
      const extra = readJson(P.extra, []);
      const name = outcome.proposedTechnique.name.toLowerCase();
      if (extra.length < 20 && !catalog.techniques.some((x) => x.name.toLowerCase() === name)) {
        const added = { id: `x-${String(extra.length + 1).padStart(2, "0")}`, ...outcome.proposedTechnique, origin: id };
        writeJson(P.extra, [...extra, added]);
        journal(`✚ new technique ${added.id}: ${added.name}`);
      }
    }
    const critical = findings.filter((f) => f.severity === "critical" && f.status !== "dismissed");
    if (critical.length) alert(`critical-${id}`, "Critical finding", critical.map((f) => f.title).join(" · "));
  }

  if (decision.countsAsFailure) st.consecutiveFailures += 1;
  else if (decision.action === "continue") st.consecutiveFailures = 0;
  st.waitUntil = decision.action === "wait" ? decision.until : 0;
  st.waitReason = decision.action === "wait" ? decision.reason : "";
  if ((end.kind === "rate-limited" || end.kind === "overloaded") && decision.action === "wait" && !campaign.queueItem?.resume && t.id !== CLEANUP_ID) {
    st.queue.unshift({ technique: t.id, area: campaign.area?.key ?? "", resume: true, brief: `Resume the campaign of round ${id}, interrupted (${end.kind}).`, origin: id, originRound: n });
  }
  if (decision.action === "halt") {
    st.halted = { kind: end.halt ? end.kind : "consecutive-failures", reason: decision.reason, at: new Date(nowEnd).toISOString(), round: id };
    alert("halt", "Loop halted", `${decision.reason} — read ${transcript}, fix the cause, then \`defectloop resume\``);
  } else if (st.consecutiveFailures === 2) {
    alert("failures", "Two failed rounds in a row", `${end.kind}: ${end.detail}`);
  }

  const count = (s) => findings.filter((f) => f.status === s).length;
  const record = {
    schemaVersion: ROUND_RECORD_VERSION,
    round: id,
    technique: t.id,
    techniqueName: t.name,
    area: campaign.area?.key ?? null,
    reason: campaign.reason,
    startedAt: new Date(now0).toISOString(),
    minutes,
    status: end.kind,
    detail: end.detail,
    next: decision.action,
    waitUntil: decision.action === "wait" ? new Date(decision.until).toISOString() : null,
    counts: { fixed: count("fixed"), proposed: count("proposed"), dismissed: count("dismissed"), unverified: count("unverified") },
    commits,
    otherCommits,
    costUsd: charge.costUsd,
    costSource: charge.source,
    authSource: summary.init?.apiKeySource ?? null,
    model: summary.init?.model ?? null,
    agentVersion: summary.init?.version ?? null,
    numTurns: summary.result?.numTurns ?? null,
    summary: outcome?.summary ?? "",
    proposedTechnique: outcome?.proposedTechnique ?? null,
    error: end.kind === "completed" ? null : (summary.result?.isError ? summary.result.text : session.stderrTail()).slice(0, 300) || null,
  };
  appendJsonl(P.rounds, record);
  journal(`■ ${end.kind} in ${minutes} min · $${charge.costUsd.toFixed(2)} (${charge.source}) · ${record.counts.fixed} fixed / ${record.counts.proposed} proposed / ${record.counts.dismissed} dismissed / ${record.counts.unverified} unverified · ${commits.length} commits${decision.action === "wait" ? ` · waiting until ${new Date(decision.until).toLocaleTimeString()} (${decision.reason})` : ""}${decision.action === "halt" ? ` · HALT: ${decision.reason}` : ""}`);
  writeJson(P.state, { ...st, phase: decision.action === "halt" ? "halted" : "between-rounds", current: null, lastRound: record, heartbeat: clock.now(), pid: process.pid });
  pruneRounds(P.roundsDir, config.loop.keepRounds);
  return { ran: true, action: decision.action, reason: decision.reason };
}

function pruneRounds(dir, keep) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const numbers = [...new Set(names.map((f) => f.match(/^round-(\d+)\./)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
  for (const n of numbers.slice(0, Math.max(0, numbers.length - keep))) {
    for (const f of names) if (f.startsWith(`${roundId(n)}.`)) rmSync(join(dir, f), { force: true });
  }
}
