// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveConfig } from "../src/config.mjs";
import { validateCatalog } from "../src/catalog.mjs";

const minimal = { budget: { perRoundUsd: 1, dailyUsd: 5 } };

test("config: defaults are filled in, paths resolved against the config directory", () => {
  const { config, errors } = resolveConfig(minimal, { configDir: "/home/tester/project" });
  assert.deepEqual(errors, []);
  assert.equal(config.agent.adapter, "claude-cli");
  assert.equal(config.agent.auth, "api-key");
  assert.equal(config.agent.permissionMode, "dontAsk");
  assert.equal(config.stateDir, "/home/tester/project/.defectloop");
  assert.equal(config.catalog, "/home/tester/project/defectloop.catalog.json");
  assert.equal(config.loop.maxConsecutiveFailures, 3);
});

test("config: the budget is mandatory", () => {
  assert.ok(resolveConfig({}, { configDir: "/x" }).errors.some((e) => /budget/.test(e)));
});

test("config: there is no subscription authentication mode", () => {
  for (const auth of ["subscription", "oauth", "setup-token", "max"]) {
    const { errors } = resolveConfig({ ...minimal, agent: { auth } }, { configDir: "/x" });
    assert.ok(errors.some((e) => /auth/.test(e)), auth);
  }
  for (const auth of ["api-key", "bedrock", "vertex", "foundry"]) {
    assert.deepEqual(resolveConfig({ ...minimal, agent: { auth } }, { configDir: "/x" }).errors, [], auth);
  }
});

test("config: bypassPermissions is refused", () => {
  const { errors } = resolveConfig({ ...minimal, agent: { permissionMode: "bypassPermissions" } }, { configDir: "/x" });
  assert.ok(errors.some((e) => /permissionMode/.test(e)));
});

test("config: unknown top-level keys are errors (typos must not silently disable a cap)", () => {
  const { errors } = resolveConfig({ ...minimal, budjet: { dailyUsd: 1 } }, { configDir: "/x" });
  assert.ok(errors.some((e) => /budjet/.test(e)));
});

test("config: the example config and the schema agree", () => {
  const example = JSON.parse(readFileSync(new URL("../templates/defectloop.config.json", import.meta.url), "utf8"));
  const { errors } = resolveConfig(example, { configDir: "/x" });
  assert.deepEqual(errors, []);
  const schema = JSON.parse(readFileSync(new URL("../schemas/config.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.agent.properties.auth.enum, ["api-key", "bedrock", "vertex", "foundry"]);
  assert.deepEqual(schema.required, ["budget"]);
});

test("catalog: the example catalog is valid and generic", () => {
  const raw = readFileSync(new URL("../templates/catalog.example.json", import.meta.url), "utf8");
  const { techniques, errors } = validateCatalog(JSON.parse(raw));
  assert.deepEqual(errors, []);
  assert.ok(techniques.length >= 8);
  assert.ok(techniques.some((t) => t.id === "cleanup" && t.internal), "built-in cleanup technique is present");
});

test("catalog: ids, duplicates, unknown fields and bad values are reported", () => {
  const { errors } = validateCatalog({
    version: 1,
    techniques: [
      { id: "Bad Id", name: "x", instructions: "long enough instructions here" },
      { id: "dup", name: "x", instructions: "long enough instructions here" },
      { id: "dup", name: "y", instructions: "long enough instructions here" },
      { id: "short", name: "z", instructions: "no" },
      { id: "typo", name: "z", instructions: "long enough instructions here", maxPerdDay: 2 },
      { id: "neg", name: "z", instructions: "long enough instructions here", maxPerDay: 0 },
    ],
  });
  for (const re of [/Bad Id/, /duplicate.*dup/, /short.*instructions/, /typo.*maxPerdDay/, /neg.*maxPerDay/]) {
    assert.ok(errors.some((e) => re.test(e)), `missing error ${re}: ${errors.join(" | ")}`);
  }
  assert.ok(validateCatalog(null).errors.length > 0);
  assert.ok(validateCatalog({ version: 2, techniques: [] }).errors.length > 0);
});

test("catalog: a catalog without its own cleanup technique gets the built-in one", () => {
  const { techniques } = validateCatalog({ version: 1, techniques: [{ id: "a", name: "A", instructions: "long enough instructions here" }] });
  assert.ok(techniques.find((t) => t.id === "cleanup" && t.internal));
});
