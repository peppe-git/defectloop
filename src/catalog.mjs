// SPDX-License-Identifier: Apache-2.0
//
// The catalog of audit techniques, supplied by the user (schemas/catalog.schema.json). Validation is
// strict on purpose: a typo in a field name ("maxPerdDay") must be an error, not a silently ignored cap.

import { readFileSync } from "node:fs";

export const TECHNIQUE_KEYS = ["id", "name", "instructions", "requires", "perArea", "maxPerDay", "internal", "origin"];
export const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const CLEANUP_ID = "cleanup";

/** Used when uncommitted changes from an interrupted round are found. Catalogs may override it. */
export const BUILTIN_CLEANUP = Object.freeze({
  id: CLEANUP_ID,
  name: "Clean up an interrupted round",
  internal: true,
  requires: [],
  instructions:
    "A previous round stopped (time limit, rate limit, crash) and left uncommitted changes, listed in the context. Read the diff and the previous round's transcript to understand what it was doing. If the change is complete and sound, run the project's checks and commit it with a pathspec. If it is half done but the direction is clear, finish it. Otherwise set it aside with `git stash push -m defectloop-leftovers -- <files>` and record in the outcome what it was. Never touch the foreign files listed in the context.",
});

/**
 * @returns {{ techniques: object[], errors: string[] }} techniques with the built-in cleanup added when missing
 */
export function validateCatalog(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { techniques: [], errors: ["catalog must be a JSON object { version: 1, techniques: [...] }"] };
  if (raw.version !== 1) errors.push(`catalog.version must be 1 (found ${JSON.stringify(raw.version)})`);
  for (const k of Object.keys(raw)) if (!["$schema", "version", "techniques"].includes(k)) errors.push(`catalog: unknown field "${k}"`);
  if (!Array.isArray(raw.techniques)) return { techniques: [], errors: [...errors, "catalog.techniques must be an array"] };
  const seen = new Set();
  const techniques = [];
  raw.techniques.forEach((t, i) => {
    const where = `technique #${i + 1}${t?.id ? ` (${t.id})` : ""}`;
    const own = validateTechnique(t, where);
    if (t?.id && seen.has(t.id)) own.push(`${where}: duplicate id ${t.id}`);
    if (t?.id) seen.add(t.id);
    errors.push(...own);
    if (!own.length) techniques.push({ requires: [], perArea: false, ...t });
  });
  if (!techniques.some((t) => t.id === CLEANUP_ID)) techniques.push({ ...BUILTIN_CLEANUP });
  return { techniques, errors };
}

export function validateTechnique(t, where = "technique") {
  const e = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) return [`${where}: must be an object`];
  for (const k of Object.keys(t)) if (!TECHNIQUE_KEYS.includes(k)) e.push(`${where}: unknown field "${k}"`);
  if (typeof t.id !== "string" || !ID_RE.test(t.id)) e.push(`${where}: id "${t.id}" must match ${ID_RE} (lowercase, digits, dashes)`);
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 80) e.push(`${where}: name must be a non-empty string of at most 80 characters`);
  if (typeof t.instructions !== "string" || t.instructions.trim().length < 20) e.push(`${where}: instructions must be a string of at least 20 characters (too short)`);
  if (t.requires !== undefined && (!Array.isArray(t.requires) || t.requires.some((r) => typeof r !== "string" || !r))) e.push(`${where}: requires must be an array of capability names`);
  if (t.perArea !== undefined && t.perArea !== false && (typeof t.perArea !== "string" || !t.perArea)) e.push(`${where}: perArea must be false, "all" or an area kind`);
  if (t.maxPerDay !== undefined && (!Number.isInteger(t.maxPerDay) || t.maxPerDay < 1)) e.push(`${where}: maxPerDay must be an integer >= 1`);
  if (t.internal !== undefined && typeof t.internal !== "boolean") e.push(`${where}: internal must be a boolean`);
  return e;
}

/** Reads the catalog file plus the techniques the loop adopted (catalog-extra.json), if any. */
export function loadCatalog(path, extraPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { techniques: [], errors: [`cannot read catalog ${path}: ${err.message}`] };
  }
  const base = validateCatalog(raw);
  if (!extraPath) return base;
  let extra = [];
  try {
    extra = JSON.parse(readFileSync(extraPath, "utf8"));
  } catch {
    return base;
  }
  const ids = new Set(base.techniques.map((t) => t.id));
  for (const t of Array.isArray(extra) ? extra : []) {
    if (!validateTechnique(t).length && !ids.has(t.id)) {
      base.techniques.push({ requires: [], perArea: false, ...t });
      ids.add(t.id);
    }
  }
  return base;
}
