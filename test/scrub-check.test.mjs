// SPDX-License-Identifier: Apache-2.0
// The scrub-check must be seen failing on a dirty file. Dirty strings are assembled at runtime so
// that this file itself stays clean. Project-specific names live in a private pattern file outside
// the repository; these tests use a fictitious one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/scrub-check.sh", import.meta.url));
const hasBash = spawnSync("bash", ["--version"]).status === 0;

/** Runs the script on `dir`; the private pattern file is only the one given here, never the caller's. */
function scrub(dir, privatePatterns) {
  const env = { ...process.env };
  delete env.SCRUB_PRIVATE_PATTERNS;
  if (privatePatterns !== undefined) env.SCRUB_PRIVATE_PATTERNS = privatePatterns;
  return spawnSync("bash", [SCRIPT, dir], { encoding: "utf8", env });
}

function dirWith(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "defectloop-scrub-"));
  writeFileSync(join(dir, name), text);
  return dir;
}

/** A private pattern file outside the scanned directory. */
function patternFile(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "defectloop-patterns-")), "private.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const FICTITIOUS = "Acme" + "-Widget";
const FICTITIOUS_PATTERNS = ["# fictitious product name", "acme[^a-z0-9]{0,3}widget"];

const dirty = [
  ["issue id", "see " + "B" + "321"],
  ["money", "costs " + String.fromCharCode(0x20ac) + "3"],
  ["commercial term", "the price " + "list" + "ino"],
  ["e-mail", "write to " + "alice" + "@" + "corp.io"],
  ["home path", "/" + "Users" + "/alice/x"],
  ["secret", "sk-" + "ant-" + "api03-abc"],
];

for (const [what, text] of dirty) {
  test(`scrub-check fails on: ${what}`, { skip: !hasBash }, () => {
    const r = scrub(dirWith("dirty.md", `clean line\n${text}\n`));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /dirty\.md:2:/);
  });
}

test("scrub-check passes on clean text and on placeholder addresses", { skip: !hasBash }, () => {
  const r = scrub(dirWith("ok.md", "contact: someone@example.com\nhome: /Users/example/project\n"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("without SCRUB_PRIVATE_PATTERNS only the generic rules run, with a warning", { skip: !hasBash }, () => {
  const r = scrub(dirWith("dirty.md", `clean line\n${FICTITIOUS}\n`));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /warning: SCRUB_PRIVATE_PATTERNS is not set/);
});

test("a private pattern fails the check, case-insensitively", { skip: !hasBash }, () => {
  const r = scrub(dirWith("dirty.md", `clean line\n${FICTITIOUS.toUpperCase()}\n`), patternFile(FICTITIOUS_PATTERNS));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /dirty\.md:2: \[private:2\]/);
  assert.doesNotMatch(r.stderr, /warning/);
});

test("comments and empty lines in the private file are ignored", { skip: !hasBash }, () => {
  // Read as patterns, "#|clean" and "" would both match the clean line.
  const r = scrub(dirWith("ok.md", "clean line\n"), patternFile(["#|clean", "", "   ", ...FICTITIOUS_PATTERNS]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /1 private pattern\(s\) loaded/);
});

test("a private file that does not exist stops the check with exit 2", { skip: !hasBash }, () => {
  const missing = join(mkdtempSync(join(tmpdir(), "defectloop-patterns-")), "missing.txt");
  const r = scrub(dirWith("ok.md", "clean line\n"), missing);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not found/);
});

test("a private pattern that does not compile stops the check with exit 2", { skip: !hasBash }, () => {
  const r = scrub(dirWith("ok.md", "clean line\n"), patternFile(["acme["]));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /invalid pattern at line 1/);
});

test("a private file inside the scanned directory stops the check with exit 2", { skip: !hasBash }, () => {
  const dir = dirWith("ok.md", "clean line\n");
  writeFileSync(join(dir, "private.txt"), FICTITIOUS_PATTERNS.join("\n") + "\n");
  const r = scrub(dir, join(dir, "private.txt"));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /outside the scanned directory/);
});
