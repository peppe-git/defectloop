// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATEGORIES, FINDING_STATUSES, SEVERITIES, fingerprint, normalizeOutcome } from "../src/outcome.mjs";

test("unknown fields dropped, enums repaired, lengths capped", () => {
  const o = normalizeOutcome({
    summary: "x".repeat(5000),
    findings: [{ title: "Balance can go negative", status: "fixed-ish", severity: "huge", category: "bug", location: "a.ts:3", extra: 1 }, { title: "" }],
    followUps: [{ technique: "deep-review", brief: "look for variants" }, { technique: "deep-review" }],
    proposedTechnique: { name: "New probe", instructions: "do this and that, then report", requires: ["docker", "mars"], perArea: "whatever" },
  }, { capabilities: ["docker"], areaKinds: ["code"] });
  assert.equal(o.summary.length, 1200);
  assert.equal(o.findings.length, 1);
  assert.deepEqual([o.findings[0].status, o.findings[0].severity], ["unverified", "medium"]);
  assert.equal(o.findings[0].extra, undefined);
  assert.equal(o.followUps.length, 1);
  assert.deepEqual(o.proposedTechnique.requires, ["docker"]);
  assert.equal(o.proposedTechnique.perArea, false);
  assert.equal(normalizeOutcome(null), null);
  assert.equal(normalizeOutcome("text"), null);
  assert.equal(normalizeOutcome([]), null);
});

test("caps on list sizes: 40 findings, 3 follow-ups", () => {
  const o = normalizeOutcome({
    findings: Array.from({ length: 60 }, (_, i) => ({ title: `finding ${i}` })),
    followUps: Array.from({ length: 9 }, () => ({ technique: "a", brief: "b" })),
  });
  assert.equal(o.findings.length, 40);
  assert.equal(o.followUps.length, 3);
});

test("non-string values never leak through", () => {
  const o = normalizeOutcome({ summary: { evil: true }, findings: [{ title: ["array"] }, { title: "ok", evidence: 42 }] });
  assert.equal(o.summary, "");
  assert.equal(o.findings.length, 1);
  assert.equal(o.findings[0].evidence, "");
});

test("fingerprint: same substance, same fingerprint", () => {
  const a = fingerprint({ category: "bug", location: "src/x/A.java:10", title: "The account balance becomes negative" });
  const b = fingerprint({ category: "bug", location: "src/x/A.java:99", title: "becomes negative: the account balance!" });
  const c = fingerprint({ category: "bug", location: "src/x/B.java:10", title: "The account balance becomes negative" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("the published JSON schema and the code agree on every enum", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/outcome.schema.json", import.meta.url), "utf8"));
  const finding = schema.$defs.finding.properties;
  assert.deepEqual(finding.status.enum, FINDING_STATUSES);
  assert.deepEqual(finding.severity.enum, SEVERITIES);
  assert.deepEqual(finding.category.enum, CATEGORIES);
});
