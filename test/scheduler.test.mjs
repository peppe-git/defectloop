// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickArea, pickCampaign, scoreTechnique, updateStats, isEligible } from "../src/scheduler.mjs";

const T = (id, extra = {}) => ({ id, name: id, instructions: `run technique ${id} carefully`, requires: [], ...extra });
const base = { queue: [], round: 10, capabilities: ["docker", "network"], today: "2026-10-26", areas: [], coverage: {}, priorityAreas: [] };

test("a technique that never ran goes first", () => {
  const stats = { a: { rounds: 5, yield: 5, dismissed: 0, lastRound: 9 } };
  const c = pickCampaign({ ...base, techniques: [T("a"), T("b")], stats });
  assert.equal(c.technique.id, "b");
  assert.equal(c.reason, "never run");
});

test("yield wins, but a technique left waiting for long comes back", () => {
  const techniques = [T("a"), T("b")];
  const rich = { a: { rounds: 4, yield: 4, dismissed: 0, lastRound: 9 }, b: { rounds: 4, yield: 0, dismissed: 4, lastRound: 8 } };
  assert.equal(pickCampaign({ ...base, techniques, stats: rich }).technique.id, "a");
  // a is dried up and just ran; b has been idle for many rounds: exploration and waiting bring it back
  const driedUp = { a: { rounds: 30, yield: 4, dismissed: 10, lastRound: 59 }, b: { rounds: 3, yield: 0, dismissed: 0, lastRound: 20 } };
  assert.equal(pickCampaign({ ...base, round: 60, techniques, stats: driedUp }).technique.id, "b");
});

test("score: the exploration bonus shrinks as a technique accumulates rounds", () => {
  const ctx = { totalRounds: 100, round: 101, eligibleCount: 4 };
  const fresh = scoreTechnique({ rounds: 1, yield: 0, dismissed: 0, lastRound: 100 }, ctx);
  const worn = scoreTechnique({ rounds: 50, yield: 0, dismissed: 0, lastRound: 100 }, ctx);
  assert.ok(fresh > worn, `${fresh} should be > ${worn}`);
  // dismissed findings lower the yield a little, never below zero
  const noisy = scoreTechnique({ rounds: 5, yield: 1, dismissed: 20, lastRound: 100 }, ctx);
  const clean = scoreTechnique({ rounds: 5, yield: 1, dismissed: 0, lastRound: 100 }, ctx);
  assert.ok(noisy < clean && noisy > 0);
});

test("score weights are configurable", () => {
  const s = { rounds: 2, yield: 1, dismissed: 0, lastRound: 1 };
  const ctx = { totalRounds: 10, round: 11, eligibleCount: 2 };
  const none = scoreTechnique(s, { ...ctx, scoring: { explorationWeight: 0, waitWeight: 0 } });
  assert.equal(none, (1 + 1) / (2 + 0 + 2));
});

test("constraints: missing capability, daily cap, internal techniques", () => {
  const techniques = [T("d", { requires: ["docker"] }), T("m", { maxPerDay: 1 }), T("r", { internal: true }), T("l")];
  const stats = { m: { rounds: 1, yield: 9, today: { date: "2026-10-26", n: 1 }, lastRound: 9 }, l: { rounds: 1, lastRound: 9 }, d: { rounds: 1, yield: 9, lastRound: 9 } };
  const c = pickCampaign({ ...base, techniques, stats, capabilities: [] });
  assert.equal(c.technique.id, "l");
  const yesterday = { ...stats, m: { ...stats.m, today: { date: "2026-10-25", n: 3 } } };
  assert.equal(pickCampaign({ ...base, techniques, stats: yesterday, capabilities: [] }).technique.id, "m");
  assert.equal(isEligible(T("d", { requires: ["docker"] }), { capabilities: ["docker"], stats: {}, today: "x" }), true);
});

test("nothing eligible: no campaign", () => {
  assert.equal(pickCampaign({ ...base, techniques: [T("d", { requires: ["gpu"] })], stats: {} }), null);
});

test("the queue gets one round in three; resuming an interrupted round always passes", () => {
  const techniques = [T("a"), T("b")];
  const stats = { a: { rounds: 1, lastRound: 1 }, b: { rounds: 1, lastRound: 2 } };
  const queue = [{ technique: "b", brief: "look for variants", origin: "round-0002" }];
  const fromQueue = [9, 10, 11, 12, 13, 14].filter((round) => pickCampaign({ ...base, round, techniques, stats, queue }).queueItem);
  assert.deepEqual(fromQueue, [10, 13]);
  const resume = [{ technique: "b", resume: true }];
  const c = pickCampaign({ ...base, round: 9, techniques, stats, queue: resume });
  assert.equal(c.queueItem?.technique, "b");
  assert.equal(c.reason, "resume interrupted round");
});

test("a queue item for an unknown or ineligible technique is skipped", () => {
  const techniques = [T("a"), T("d", { requires: ["docker"] })];
  const stats = { a: { rounds: 1, lastRound: 1 }, d: { rounds: 1, lastRound: 1 } };
  const queue = [{ technique: "ghost", brief: "x" }, { technique: "d", brief: "y" }];
  const c = pickCampaign({ ...base, round: 10, techniques, stats, queue, capabilities: [] });
  assert.equal(c.queueItem, undefined);
  assert.equal(c.technique.id, "a");
});

test("area: the least covered, ties broken by priority areas", () => {
  const areas = [
    { key: "src/admin", name: "admin", kind: "backend" },
    { key: "src/billing", name: "billing", kind: "backend" },
    { key: "web/Home", name: "Home", kind: "web" },
  ];
  const t = T("x", { perArea: "backend" });
  assert.equal(pickArea(t, { areas, coverage: {}, priorityAreas: ["billing"] }).name, "billing");
  assert.equal(pickArea(t, { areas, coverage: { x: { "src/billing": 5 } }, priorityAreas: ["billing"] }).name, "admin");
  assert.equal(pickArea(T("y", { perArea: "web" }), { areas, coverage: {} }).name, "Home");
  assert.equal(pickArea(T("all", { perArea: "all" }), { areas, coverage: { all: { "src/admin": 1, "src/billing": 1 } } }).name, "Home");
  assert.equal(pickArea(T("z"), { areas, coverage: {} }), null);
});

test("stats: fixed weighs more than proposed, the daily counter resets", () => {
  let s = updateStats({}, "t1", { findings: [{ status: "fixed" }, { status: "proposed" }, { status: "dismissed" }], minutes: 30, round: 4, today: "2026-10-26" });
  assert.equal(s.t1.yield, 1.7);
  assert.equal(s.t1.dismissed, 1);
  s = updateStats(s, "t1", { findings: [], minutes: 10, round: 5, today: "2026-10-26" });
  assert.deepEqual(s.t1.today, { date: "2026-10-26", n: 2 });
  s = updateStats(s, "t1", { findings: [], minutes: 10, round: 6, today: "2026-10-27", sha: "abc" });
  assert.deepEqual([s.t1.today.n, s.t1.rounds, s.t1.lastSha, s.t1.lastRound], [1, 3, "abc", 6]);
});

test("pickCampaign is deterministic: same input, same choice", () => {
  const techniques = [T("a"), T("b"), T("c")];
  const stats = { a: { rounds: 3, yield: 1, lastRound: 7 }, b: { rounds: 3, yield: 1, lastRound: 8 }, c: { rounds: 3, yield: 1, lastRound: 9 } };
  const one = pickCampaign({ ...base, techniques, stats });
  const two = pickCampaign({ ...base, techniques, stats });
  assert.equal(one.technique.id, two.technique.id);
  assert.equal(one.technique.id, "a");
});
