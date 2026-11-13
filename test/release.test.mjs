// SPDX-License-Identifier: Apache-2.0
// The release workflow publishes only a stable version whose tag matches package.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease } from "../scripts/check-release-version.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/check-release-version.mjs", import.meta.url));

test("a tag that matches a stable version passes", () => {
  assert.deepEqual(checkRelease({ refType: "tag", refName: "v0.1.0", version: "0.1.0" }), []);
  assert.deepEqual(checkRelease({ refType: "tag", refName: "v12.3.40", version: "12.3.40" }), []);
});

const refused = [
  ["a branch (manual run not on a tag)", { refType: "branch", refName: "main", version: "0.1.0" }, /tag/],
  ["a missing ref", { refType: "", refName: "", version: "0.1.0" }, /tag/],
  ["a tag that differs from the version", { refType: "tag", refName: "v0.1.1", version: "0.1.0" }, /does not match/],
  ["a tag without the v prefix", { refType: "tag", refName: "0.1.0", version: "0.1.0" }, /does not match/],
  ["a prerelease version", { refType: "tag", refName: "v0.1.0-SNAPSHOT", version: "0.1.0-SNAPSHOT" }, /prerelease/],
  ["a prerelease tag on a stable version", { refType: "tag", refName: "v0.1.0-rc.1", version: "0.1.0" }, /does not match/],
  ["build metadata", { refType: "tag", refName: "v0.1.0+abc", version: "0.1.0+abc" }, /not a stable/],
  ["leading zeros", { refType: "tag", refName: "v0.01.0", version: "0.01.0" }, /not a stable/],
  ["a missing version", { refType: "tag", refName: "v0.1.0", version: undefined }, /not a stable/],
];

for (const [what, input, message] of refused) {
  test(`refuses ${what}`, () => {
    const problems = checkRelease(input);
    assert.ok(problems.length > 0, "expected a problem");
    assert.match(problems.join("\n"), message);
  });
}

test("the command line reads GitHub's ref variables and a package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "defectloop-release-"));
  const manifest = join(dir, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "x", version: "1.2.3" }));
  const run = (env, file = manifest) =>
    spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  const ok = run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /release check passed/);

  const wrong = run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.4" });
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /release check failed/);

  assert.equal(run({}).status, 1, "no ref variables: refused");
  assert.equal(run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" }, join(dir, "missing.json")).status, 1);
});
