// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetGate, roundCharge, spendSoFar, validateBudget } from "../src/budget.mjs";

const caps = { perRoundUsd: 2, dailyUsd: 10, monthlyUsd: 50 };
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const entry = (ms, costUsd) => ({ at: new Date(ms).toISOString(), costUsd });

test("a spend cap is mandatory", () => {
  assert.ok(validateBudget(undefined).length > 0);
  assert.ok(validateBudget({}).length > 0);
  assert.ok(validateBudget({ dailyUsd: 10 }).some((e) => /perRoundUsd/.test(e)));
  assert.ok(validateBudget({ perRoundUsd: 1 }).some((e) => /dailyUsd|monthlyUsd/.test(e)));
  assert.ok(validateBudget({ perRoundUsd: 0, dailyUsd: 5 }).length > 0);
  assert.ok(validateBudget({ perRoundUsd: 3, dailyUsd: 2 }).some((e) => /larger/.test(e)));
  assert.deepEqual(validateBudget({ perRoundUsd: 1, dailyUsd: 5 }), []);
  assert.deepEqual(validateBudget(caps), []);
});

test("spend so far: today and this month, local calendar", () => {
  const now = at(2026, 11, 12, 15);
  const ledger = [entry(at(2026, 11, 12, 9), 1.5), entry(at(2026, 11, 11, 23), 2), entry(at(2026, 10, 31, 23), 7), entry(at(2026, 11, 12, 14), 0.25)];
  const s = spendSoFar(ledger, now);
  assert.equal(s.today, 1.75);
  assert.equal(s.month, 3.75);
});

test("gate: a full round must still fit under the daily and monthly caps", () => {
  const now = at(2026, 11, 12, 15);
  assert.equal(budgetGate({ ledger: [entry(now - 1000, 7.9)], budget: caps, now }).ok, true);
  const day = budgetGate({ ledger: [entry(now - 1000, 8.5)], budget: caps, now });
  assert.equal(day.ok, false);
  assert.equal(day.retryAt, at(2026, 11, 13, 0));
  assert.match(day.reason, /daily/);
  const month = budgetGate({ ledger: [entry(at(2026, 11, 1), 49)], budget: caps, now });
  assert.equal(month.ok, false);
  assert.equal(month.retryAt, new Date(2026, 11, 1, 0, 0, 0).getTime());
  assert.match(month.reason, /monthly/);
});

test("gate with only a monthly cap", () => {
  const now = at(2026, 11, 12);
  assert.equal(budgetGate({ ledger: [entry(now, 30)], budget: { perRoundUsd: 1, monthlyUsd: 40 }, now }).ok, true);
});

test("a round without a reported cost is charged the per-round cap", () => {
  assert.deepEqual(roundCharge({ result: { costUsd: 0.31 } }, caps), { costUsd: 0.31, source: "reported" });
  assert.deepEqual(roundCharge({ result: null }, caps), { costUsd: 2, source: "estimated-cap" });
  assert.deepEqual(roundCharge(null, caps), { costUsd: 2, source: "estimated-cap" });
});

test("malformed ledger lines are charged, not ignored", () => {
  const now = at(2026, 11, 12, 15);
  const s = spendSoFar([{ at: "garbage", costUsd: 1 }, { at: new Date(now).toISOString(), costUsd: "NaN" }], now, { fallbackUsd: 2 });
  assert.equal(s.today, 3);
});
