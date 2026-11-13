// SPDX-License-Identifier: Apache-2.0
//
// The few git facts the supervisor needs: HEAD, dirty files, the round's commits (by trailer).

import { spawnSync } from "node:child_process";
import { relative } from "node:path";

export const TRAILER_KEY = "Defectloop-Round";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function isRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

export function head(root, short = false) {
  const r = git(root, ["rev-parse", ...(short ? ["--short"] : []), "HEAD"]);
  return r.ok ? r.out : null;
}

/** Modified, added, deleted and untracked files (not ignored), repo-relative, excluding `skipDir`. */
export function dirtyFiles(root, skipDir) {
  const r = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return [];
  const skip = skipDir ? relative(root, skipDir).split("\\").join("/") : null;
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop().replace(/^"|"$/g, ""))
    .filter((f) => !skip || (f !== skip && !f.startsWith(`${skip}/`)));
}

/** Commits since `fromSha` that carry the round's trailer, as "sha subject". */
export function roundCommits(root, fromSha, round) {
  if (!fromSha) return [];
  const r = git(root, ["log", "--format=%h%x1f%s%x1f%b%x1e", `${fromSha}..HEAD`]);
  if (!r.ok) return [];
  return r.out
    .split("\x1e")
    .map((x) => x.trim().split("\x1f"))
    .filter((p) => p.length >= 3 && p[2].includes(`${TRAILER_KEY}: ${round}`))
    .map((p) => `${p[0]} ${p[1]}`);
}

/** Number of commits since `fromSha` (with or without trailer). */
export function commitCount(root, fromSha) {
  if (!fromSha) return 0;
  const r = git(root, ["rev-list", "--count", `${fromSha}..HEAD`]);
  return r.ok ? Number(r.out) || 0 : 0;
}
