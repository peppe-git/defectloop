// SPDX-License-Identifier: Apache-2.0
//
// Spend accounting. The source of truth is the cost each session reports in its final `result`
// event (`total_cost_usd`, a client-side estimate), appended to `ledger.jsonl`. A session that ends
// without reporting a cost (killed, crashed) is charged the per-round cap: accounting errs on the
// expensive side. Caps are mandatory; there is no default.

/** @returns {string[]} configuration errors */
export function validateBudget(b) {
  const errors = [];
  if (!b || typeof b !== "object") return ["budget is required: set budget.perRoundUsd and budget.dailyUsd and/or budget.monthlyUsd"];
  const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!pos(b.perRoundUsd)) errors.push("budget.perRoundUsd is required and must be a positive number (passed to the agent as its own spend cap)");
  if (b.dailyUsd === undefined && b.monthlyUsd === undefined) errors.push("set at least one of budget.dailyUsd or budget.monthlyUsd");
  for (const k of ["dailyUsd", "monthlyUsd"]) {
    if (b[k] !== undefined && !pos(b[k])) errors.push(`budget.${k} must be a positive number`);
    if (pos(b[k]) && pos(b.perRoundUsd) && b.perRoundUsd > b[k]) errors.push(`budget.perRoundUsd (${b.perRoundUsd}) is larger than budget.${k} (${b[k]}): no round could ever start`);
  }
  if (pos(b.dailyUsd) && pos(b.monthlyUsd) && b.dailyUsd > b.monthlyUsd) errors.push("budget.dailyUsd is larger than budget.monthlyUsd");
  return errors;
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const startOfMonth = (ms) => {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const nextDay = (ms) => {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime();
};
const nextMonth = (ms) => {
  const d = new Date(startOfMonth(ms));
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
};
const round4 = (x) => Math.round(x * 10_000) / 10_000;

/**
 * Spend today and this month (local calendar of the machine running the loop).
 * Entries with an unreadable date count as today; entries with an unreadable cost count as `fallbackUsd`.
 */
export function spendSoFar(ledger, now, { fallbackUsd = 0 } = {}) {
  const day = startOfDay(now);
  const month = startOfMonth(now);
  let today = 0;
  let thisMonth = 0;
  for (const e of ledger ?? []) {
    const t = Date.parse(e?.at);
    const cost = typeof e?.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0 ? e.costUsd : fallbackUsd;
    const when = Number.isFinite(t) ? t : now;
    if (when >= day) today += cost;
    if (when >= month) thisMonth += cost;
  }
  return { today: round4(today), month: round4(thisMonth) };
}

/**
 * Whether a whole new round still fits under the caps.
 * @returns {{ ok: boolean, today: number, month: number, reason?: string, retryAt?: number }}
 */
export function budgetGate({ ledger, budget, now }) {
  const s = spendSoFar(ledger, now, { fallbackUsd: budget.perRoundUsd });
  const next = budget.perRoundUsd;
  if (budget.monthlyUsd !== undefined && s.month + next > budget.monthlyUsd) {
    return { ok: false, ...s, reason: `monthly cap: spent $${s.month.toFixed(2)} of $${budget.monthlyUsd}, a round may cost up to $${next}`, retryAt: nextMonth(now) };
  }
  if (budget.dailyUsd !== undefined && s.today + next > budget.dailyUsd) {
    return { ok: false, ...s, reason: `daily cap: spent $${s.today.toFixed(2)} of $${budget.dailyUsd}, a round may cost up to $${next}`, retryAt: nextDay(now) };
  }
  return { ok: true, ...s };
}

/** What to write in the ledger for a round, given the stream summary. */
export function roundCharge(summary, budget) {
  const c = summary?.result?.costUsd;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0) return { costUsd: c, source: "reported" };
  return { costUsd: budget.perRoundUsd, source: "estimated-cap" };
}
