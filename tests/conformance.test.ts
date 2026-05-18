/**
 * Conformance test — verifies the plugin's protocol schemas + fixtures
 * stay in sync with upstream.
 *
 * Loads the fixture set from @xpaysh/conformance-fixtures and validates
 * every fixture (that declares `_meta.validates_against`) through Ajv
 * against the canonical JSON Schemas vendored in @xpaysh/{acp,ucp}-schemas.
 *
 * This test runs without platform credentials. The plugin's actual wire
 * handlers are exercised by separate e2e suites that hit a sandbox store.
 *
 * Run: npx tsx tests/conformance.test.ts
 */

import assert from "node:assert/strict";
import { listFixtures, loadFixture } from "@xpaysh/conformance-fixtures";
import { schemas as acpSchemas } from "@xpaysh/acp-schemas";
import { registerForValidation as registerUcp } from "@xpaysh/ucp-schemas";
import Ajv from "ajv/dist/2020";

let passed = 0;
let failed = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
for (const [name, schema] of Object.entries(acpSchemas)) {
  ajv.addSchema(schema as object, `schema.${name}.json`);
}
registerUcp(ajv);

function t(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stdout.write(`✗ ${name}\n    ${msg.split("\n").slice(0, 3).join("\n    ")}\n`);
    failed += 1;
  }
}

t("ACP fixtures validate against vendored schemas", () => {
  let checked = 0;
  for (const filename of listFixtures("acp")) {
    const fx = loadFixture(`acp/${filename}`);
    const target = (fx._meta as Record<string, string>)?.validates_against;
    if (!target) continue;
    const validate = ajv.getSchema(target);
    if (!validate) throw new Error(`cannot resolve ${target} (fixture acp/${filename})`);
    if (!validate(fx.body)) {
      throw new Error(
        `acp/${filename} failed: ${JSON.stringify(validate.errors).slice(0, 300)}`,
      );
    }
    checked += 1;
  }
  assert.ok(checked >= 7, `expected ≥7 validated ACP fixtures, got ${checked}`);
});

t("UCP fixtures validate against vendored schemas", () => {
  let checked = 0;
  for (const filename of listFixtures("ucp")) {
    const fx = loadFixture(`ucp/${filename}`);
    const target = (fx._meta as Record<string, string>)?.validates_against;
    if (!target) continue;
    const validate = ajv.getSchema(target);
    if (!validate) throw new Error(`cannot resolve ${target} (fixture ucp/${filename})`);
    if (!validate(fx.body)) {
      throw new Error(
        `ucp/${filename} failed: ${JSON.stringify(validate.errors).slice(0, 300)}`,
      );
    }
    checked += 1;
  }
  assert.ok(checked >= 2, `expected ≥2 validated UCP fixtures, got ${checked}`);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
