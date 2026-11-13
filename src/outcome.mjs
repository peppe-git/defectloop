// SPDX-License-Identifier: Apache-2.0
//
// The outcome a round writes for the supervisor (schemas/outcome.schema.json), brought back to a safe
// shape: known fields only, valid enums, bounded lengths. The agent writes this file; the supervisor
// never trusts it beyond what this module lets through.

import { createHash } from "node:crypto";

export const OUTCOME_SCHEMA_VERSION = 1;
export const FINDING_STATUSES = ["fixed", "proposed", "dismissed", "unverified"];
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const CATEGORIES = ["bug", "security", "performance", "consistency", "test", "data", "ux", "docs", "other"];

/** How much a finding counts towards a technique's yield: a fix is worth more than a proposal. */
export const STATUS_WEIGHT = { fixed: 1, proposed: 0.7, unverified: 0.2, dismissed: 0 };

const LIMITS = { summary: 1200, title: 200, location: 200, evidence: 600, commit: 40, technique: 40, area: 120, brief: 400, name: 80, instructions: 2000, findings: 40, followUps: 3 };

function text(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * @param {unknown} raw parsed JSON written by the agent
 * @param {{ capabilities?: string[], areaKinds?: string[] }} [known] values a proposed technique may use
 * @returns {null | { summary: string, findings: object[], followUps: object[], proposedTechnique: object|null }}
 */
export function normalizeOutcome(raw, known = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .slice(0, LIMITS.findings)
    .map((f) => ({
      title: text(f?.title, LIMITS.title),
      status: oneOf(f?.status, FINDING_STATUSES, "unverified"),
      severity: oneOf(f?.severity, SEVERITIES, "medium"),
      category: oneOf(f?.category, CATEGORIES, "other"),
      location: text(f?.location, LIMITS.location),
      evidence: text(f?.evidence, LIMITS.evidence),
      commit: text(f?.commit, LIMITS.commit),
    }))
    .filter((f) => f.title);

  const followUps = (Array.isArray(raw.followUps) ? raw.followUps : [])
    .slice(0, LIMITS.followUps)
    .map((v) => ({ technique: text(v?.technique, LIMITS.technique), area: text(v?.area, LIMITS.area), brief: text(v?.brief, LIMITS.brief) }))
    .filter((v) => v.technique && v.brief);

  let proposedTechnique = null;
  const p = raw.proposedTechnique;
  if (p && typeof p === "object" && text(p.name, LIMITS.name) && text(p.instructions, LIMITS.instructions)) {
    const caps = known.capabilities ?? [];
    const kinds = known.areaKinds ?? [];
    proposedTechnique = {
      name: text(p.name, LIMITS.name),
      instructions: text(p.instructions, LIMITS.instructions),
      requires: (Array.isArray(p.requires) ? p.requires : []).filter((r) => typeof r === "string" && caps.includes(r)),
      perArea: p.perArea === "all" || kinds.includes(p.perArea) ? p.perArea : false,
    };
  }
  return { summary: text(raw.summary, LIMITS.summary), findings, followUps, proposedTechnique };
}

/** A short fingerprint of a finding, to recognise the same defect reported by two rounds. */
export function fingerprint(f) {
  const file = String(f?.location ?? "").split(":")[0].trim().toLowerCase();
  const words = String(f?.title ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 8)
    .join(" ");
  return createHash("sha1").update(`${f?.category ?? ""}|${file}|${words}`).digest("hex").slice(0, 12);
}
