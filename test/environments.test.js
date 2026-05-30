import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironmentResourceName, isProductionEnvironment, normalizeEnvironmentName } from "../src/environments.js";

test("normalizes supported environment aliases", () => {
  assert.equal(normalizeEnvironmentName("development"), "dev");
  assert.equal(normalizeEnvironmentName("STAGING"), "stage");
  assert.equal(normalizeEnvironmentName("prod"), "prod");
});

test("rejects unsupported environment names", () => {
  assert.throws(() => normalizeEnvironmentName("qa"), /unsupported environment/);
});

test("builds stable resource names with canonical environment", () => {
  assert.equal(buildEnvironmentResourceName("production", "kms"), "ai-assist-prod-kms");
  assert.equal(isProductionEnvironment("prod"), true);
});
