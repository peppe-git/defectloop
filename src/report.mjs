// SPDX-License-Identifier: Apache-2.0
//
// What the loop is doing (status), what it found (report), and search in the findings record.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spendSoFar } from "./budget.mjs";
import { globalHome, isAlive, paths, readJson, readJsonl } from "./state.mjs";

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Findings whose title, location, evidence or category contain every word (any order). */
export function search(config, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return readJsonl(paths(config.stateDir).findings).filter((r) => {
    const text = fold(`${r.title} ${r.location} ${r.evidence} ${r.category}`);
    return words.every((w) => text.includes(w));
  });
}

export function statusText(config, { env = process.env, now = Date.now() } = {}) {
  const P = paths(config.stateDir);
  const st = readJson(P.state, null);
  const findings = readJsonl(P.findings);
  const rounds = readJsonl(P.rounds);
  const count = (s) => findings.filter((r) => r.status === s && !r.duplicateOf).length;
  const lines = [];
  const pid = existsSync(P.lock) ? Number(readFileSync(P.lock, "utf8")) : 0;
  const alive = pid && isAlive(pid);
  const stops = [existsSync(P.stop) && "project STOP file", existsSync(join(globalHome(env), "STOP")) && "global STOP file"].filter(Boolean);
  let phase = !alive ? "NOT RUNNING" : existsSync(P.pause) ? "PAUSED (current round finishes, then waits)" : String(st?.phase ?? "running").toUpperCase();
  if (st?.halted) phase = "HALTED";
  lines.push(`defectloop: ${phase}${alive ? ` · supervisor pid ${pid} · heartbeat ${duration(now - (st?.heartbeat ?? now))} ago` : ""}`);
  if (stops.length) lines.push(`kill switch engaged: ${stops.join(", ")} (\`defectloop resume\` removes it)`);
  if (st?.halted) lines.push(`halted: ${st.halted.reason} (${st.halted.at}) — read ALERTS.md, fix the cause, then \`defectloop resume\``);
  if (!st) {
    lines.push("never started: `defectloop check`, then `defectloop run`");
    return lines.join("\n");
  }
  if (alive && st.current) lines.push(`round ${st.current.round}: ${st.current.technique}${st.current.area ? ` · ${st.current.area}` : ""} · ${st.current.events} events${st.current.lastAction ? ` · last: ${st.current.lastAction}` : ""}`);
  if (st.waitUntil > now) lines.push(`waiting until ${new Date(st.waitUntil).toLocaleString()}: ${st.waitReason}`);
  const spend = spendSoFar(readJsonl(P.ledger), now, { fallbackUsd: config.budget?.perRoundUsd ?? 0 });
  lines.push(`spend: today $${spend.today.toFixed(2)}${config.budget?.dailyUsd ? ` of $${config.budget.dailyUsd}` : ""} · month $${spend.month.toFixed(2)}${config.budget?.monthlyUsd ? ` of $${config.budget.monthlyUsd}` : ""}`);
  lines.push(`total: ${st.round} rounds · ${count("fixed")} fixed · ${count("proposed")} proposed · ${count("unverified")} unverified · ${count("dismissed")} dismissed · queue ${st.queue?.length ?? 0}${st.consecutiveFailures ? ` · consecutive failures ${st.consecutiveFailures}` : ""}`);
  if (rounds.length) {
    lines.push("last rounds:");
    for (const g of rounds.slice(-5).reverse()) lines.push(`  ${g.round} ${g.technique}${g.area ? ` ${g.area}` : ""} → ${g.status}, ${g.minutes} min, $${Number(g.costUsd ?? 0).toFixed(2)}, ${g.counts?.fixed ?? 0}F/${g.counts?.proposed ?? 0}P/${g.counts?.dismissed ?? 0}D/${g.counts?.unverified ?? 0}U${g.commits?.length ? ` · ${g.commits.map((c) => c.split(" ")[0]).join(" ")}` : ""}`);
  }
  if (existsSync(P.alerts)) {
    const last = readFileSync(P.alerts, "utf8").trim().split("\n").slice(-3);
    if (last[0]) lines.push("recent alerts:", ...last.map((a) => `  ${a}`));
  }
  return lines.join("\n");
}

export function writeReport(config, { now = Date.now() } = {}) {
  const P = paths(config.stateDir);
  const st = readJson(P.state, {});
  const findings = readJsonl(P.findings);
  const rounds = readJsonl(P.rounds);
  const count = (s) => findings.filter((r) => r.status === s && !r.duplicateOf).length;
  const r = [];
  r.push("# defectloop report", "", `Generated ${new Date(now).toISOString()} · ${rounds.length} rounds · ${findings.length} findings`, "");
  r.push("| status | findings |", "|---|---|");
  for (const s of ["fixed", "proposed", "unverified", "dismissed"]) r.push(`| ${s} | ${count(s)} |`);
  const commits = rounds.flatMap((g) => g.commits ?? []);
  r.push("", `Local commits made by the loop: **${commits.length}**. Review them before publishing anything: publishing is your decision.`, "");
  const section = (title, filter) => {
    const items = findings.filter(filter).reverse();
    r.push(`## ${title} (${items.length})`, "");
    if (!items.length) r.push("_none_", "");
    for (const v of items) r.push(`- **${v.title}** · ${v.severity} · ${v.category} · \`${v.location || "?"}\` · ${v.round} (${v.technique}${v.area ? ` ${v.area}` : ""})${v.commit ? ` · commit \`${v.commit}\`` : ""}${v.duplicateOf ? ` · duplicate of ${v.duplicateOf}` : ""}\n  - evidence: ${v.evidence || "—"}`);
    r.push("");
  };
  section("Critical and high, still open", (v) => ["critical", "high"].includes(v.severity) && !["fixed", "dismissed"].includes(v.status));
  section("Fixed", (v) => v.status === "fixed");
  section("Proposed (decisions for you)", (v) => v.status === "proposed");
  section("Unverified", (v) => v.status === "unverified");
  const proposals = rounds.filter((g) => g.proposedTechnique);
  if (proposals.length) {
    r.push(`## Techniques proposed by rounds (${proposals.length})`, "", "Not adopted unless `loop.acceptProposedTechniques` is true. Review before copying into the catalog: they were written by the agent.", "");
    for (const g of proposals) r.push(`- ${g.round}: **${g.proposedTechnique.name}** — ${g.proposedTechnique.instructions.slice(0, 300)}`);
    r.push("");
  }
  r.push("## Yield per technique", "", "| technique | rounds | yield | dismissed | avg min | last round |", "|---|---|---|---|---|---|");
  for (const [id, s] of Object.entries(st.stats ?? {}).sort()) r.push(`| ${id} | ${s.rounds} | ${Number(s.yield).toFixed(1)} | ${s.dismissed} | ${Math.round(s.minutes / Math.max(1, s.rounds))} | ${s.lastRound} |`);
  r.push("", "## Last 30 rounds", "", "| round | technique | area | status | min | cost | F/P/D/U | commits | summary |", "|---|---|---|---|---|---|---|---|---|");
  for (const g of rounds.slice(-30).reverse()) {
    const c = g.counts ?? {};
    r.push(`| ${g.round} | ${g.technique} | ${g.area ?? ""} | ${g.status} | ${g.minutes} | $${Number(g.costUsd ?? 0).toFixed(2)} | ${c.fixed ?? 0}/${c.proposed ?? 0}/${c.dismissed ?? 0}/${c.unverified ?? 0} | ${(g.commits ?? []).map((x) => x.split(" ")[0]).join(" ")} | ${(g.summary || g.error || "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} |`);
  }
  if (existsSync(P.alerts)) r.push("", "## Alerts", "", readFileSync(P.alerts, "utf8").split("\n").slice(-20).join("\n"));
  mkdirSync(P.dir, { recursive: true });
  writeFileSync(P.report, `${r.join("\n")}\n`);
  return P.report;
}
