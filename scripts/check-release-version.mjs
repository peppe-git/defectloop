#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate, run first by .github/workflows/release.yml: the workflow must run on a tag, the tag
// must be "v" + the version in package.json, and the version must be a stable release (no
// prerelease such as -SNAPSHOT or -rc.1, no build metadata).
//
//   node scripts/check-release-version.mjs [path/to/package.json]
//
// Reads GITHUB_REF_TYPE and GITHUB_REF_NAME, which GitHub Actions sets for every run.
// Exit 0 = publishable, 1 = refused (reasons on stderr).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Returns the reasons this ref and version must not be published; empty when they may. */
export function checkRelease({ refType, refName, version }) {
  const problems = [];
  if (refType !== "tag") {
    problems.push(`the workflow must run on a tag, not on ${refType ? `a ${refType}` : "an unknown ref"} (${refName || "?"})`);
  }
  if (typeof version !== "string" || !STABLE.test(version)) {
    const pre = typeof version === "string" && /^\d+\.\d+\.\d+-/.test(version) && !version.includes("+");
    problems.push(pre
      ? `package.json version ${version} is a prerelease: bump it to a stable version first`
      : `package.json version ${version} is not a stable MAJOR.MINOR.PATCH version`);
  }
  if (refType === "tag" && refName !== `v${version}`) {
    problems.push(`tag ${refName} does not match package.json version ${version} (expected v${version})`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = process.argv[2] ?? fileURLToPath(new URL("../package.json", import.meta.url));
  let version;
  try {
    version = JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch (error) {
    console.error(`release check failed: cannot read ${manifest}: ${error.message}`);
    process.exit(1);
  }
  const problems = checkRelease({
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    version,
  });
  if (problems.length > 0) {
    console.error(`release check failed:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`release check passed: ${process.env.GITHUB_REF_NAME} publishes version ${version}`);
}
