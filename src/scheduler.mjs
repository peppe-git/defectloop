// SPDX-License-Identifier: Apache-2.0
//
// Which campaign (technique, and area when the technique works per area) a round gets. Pure: no I/O,
// no clock, no randomness; the same input always gives the same choice.
//
// Order of the rules:
//   1. a queue item (variants of a recent finding, resumption of an interrupted round) once every
//      `queueEvery` rounds, so the queue cannot monopolise the loop; a resumption always passes;
//   2. an eligible technique that never ran;
//   3. the highest score.
//
// The score is a heuristic in the spirit of UCB1, not a textbook bandit: rewards are not bounded in
// [0, 1] and a "waiting" bonus is added. See docs/concepts.md.

import { STATUS_WEIGHT } from "./outcome.mjs";

export const DEFAULT_SCORING = Object.freeze({
  /** c in c * sqrt(ln(N + 1) / (n + 1)). */
  explorationWeight: 0.5,
  /** weight of the bonus for techniques that have not run for a while (0..1 before weighting). */
  waitWeight: 0.3,
  /** how much a dismissed finding (a false alarm) weighs against the yield, as extra rounds. */
  dismissedPenalty: 0.15,
  /** the queue gets one round in this many. */
  queueEvery: 3,
});

/** A technique can run if the environment has what it needs and its daily cap is not reached. */
export function isEligible(t, { capabilities = [], stats = {}, today }) {
  if ((t.requires ?? []).some((r) => !capabilities.includes(r))) return false;
  if (t.maxPerDay != null) {
    const s = stats[t.id];
    const nToday = s?.today?.date === today ? s.today.n : 0;
    if (nToday >= t.maxPerDay) return false;
  }
  return true;
}

/**
 * Score of a technique = Bayesian-smoothed yield per round + exploration bonus + waiting bonus.
 *
 * - yield: (weighted findings + 1) / (rounds + dismissedPenalty * dismissed + 2). Per round, not
 *   cumulative, so a technique that dries up sinks on its own.
 * - exploration: grows with the total number of rounds and shrinks with this technique's rounds, so
 *   no technique leaves the rotation for ever.
 * - waiting: up to 1 when the technique has not run for 2 * (number of eligible techniques) rounds.
 */
export function scoreTechnique(s, { totalRounds, round, eligibleCount, scoring = {} }) {
  const k = { ...DEFAULT_SCORING, ...scoring };
  const rounds = s?.rounds ?? 0;
  const yieldPerRound = ((s?.yield ?? 0) + 1) / (rounds + (s?.dismissed ?? 0) * k.dismissedPenalty + 2);
  const exploration = k.explorationWeight * Math.sqrt(Math.log(totalRounds + 1) / (rounds + 1));
  const waiting = s?.lastRound ? Math.min(1, (round - s.lastRound) / (2 * Math.max(1, eligibleCount))) : 1;
  return yieldPerRound + exploration + k.waitWeight * waiting;
}

/** The least covered area for a technique; ties go to priority areas, then to the given order. */
export function pickArea(t, { areas = [], coverage = {}, priorityAreas = [] }) {
  const kind = t.perArea;
  if (!kind) return null;
  const candidates = areas.filter((a) => kind === "all" || a.kind === kind);
  if (!candidates.length) return null;
  const cov = coverage[t.id] ?? {};
  return [...candidates].sort((a, b) => {
    const ca = cov[a.key] ?? 0;
    const cb = cov[b.key] ?? 0;
    if (ca !== cb) return ca - cb;
    const pa = priorityAreas.includes(a.name) || priorityAreas.includes(a.key) ? 0 : 1;
    const pb = priorityAreas.includes(b.name) || priorityAreas.includes(b.key) ? 0 : 1;
    return pa - pb;
  })[0];
}

/**
 * The campaign of a round, or null when nothing is eligible.
 * @returns {null | { technique: object, area: object|null, reason: string, queueItem?: object, queueIndex?: number }}
 */
export function pickCampaign({ techniques, stats = {}, queue = [], round, capabilities = [], today, areas = [], coverage = {}, priorityAreas = [], scoring = {} }) {
  const k = { ...DEFAULT_SCORING, ...scoring };
  const ctx = { capabilities, stats, today };
  const byId = new Map(techniques.map((t) => [t.id, t]));
  const eligible = techniques.filter((t) => !t.internal && isEligible(t, ctx));

  const queueIndex = queue.findIndex((v) => {
    const t = byId.get(v.technique);
    return t && isEligible(t, ctx);
  });
  const item = queue[queueIndex];
  if (item && (item.resume || (round - 1) % k.queueEvery === 0 || !eligible.length)) {
    const t = byId.get(item.technique);
    const area = item.area
      ? (areas.find((a) => a.key === item.area || a.name === item.area) ?? { key: item.area, name: item.area, kind: "?" })
      : pickArea(t, { areas, coverage, priorityAreas });
    return { technique: t, area, reason: item.resume ? "resume interrupted round" : `queued (${item.origin ?? "?"})`, queueItem: item, queueIndex };
  }
  if (!eligible.length) return null;

  const neverRun = eligible.find((t) => !(stats[t.id]?.rounds > 0));
  if (neverRun) return { technique: neverRun, area: pickArea(neverRun, { areas, coverage, priorityAreas }), reason: "never run" };

  const totalRounds = Object.values(stats).reduce((n, s) => n + (s?.rounds ?? 0), 0);
  let best = null;
  for (const t of eligible) {
    const score = scoreTechnique(stats[t.id], { totalRounds, round, eligibleCount: eligible.length, scoring: k });
    if (!best || score > best.score) best = { t, score };
  }
  return { technique: best.t, area: pickArea(best.t, { areas, coverage, priorityAreas }), reason: `score ${best.score.toFixed(2)}` };
}

/** A technique's statistics after a round that ran (completed or timed out). */
export function updateStats(stats, techniqueId, { findings = [], minutes = 0, round, today, sha }) {
  const s = { rounds: 0, yield: 0, dismissed: 0, minutes: 0, ...(stats[techniqueId] ?? {}) };
  s.rounds += 1;
  s.yield = Math.round((s.yield + findings.reduce((n, f) => n + (STATUS_WEIGHT[f.status] ?? 0), 0)) * 1000) / 1000;
  s.dismissed += findings.filter((f) => f.status === "dismissed").length;
  s.minutes = Math.round((s.minutes + minutes) * 10) / 10;
  s.lastRound = round;
  if (sha) s.lastSha = sha;
  s.today = s.today?.date === today ? { date: today, n: s.today.n + 1 } : { date: today, n: 1 };
  return { ...stats, [techniqueId]: s };
}
