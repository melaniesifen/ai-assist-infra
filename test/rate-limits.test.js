import test from "node:test";
import assert from "node:assert/strict";
import { buildDefaultRouteRateLimits, validateRateLimitConfig } from "../src/rate-limits.js";

test("default rate limits satisfy required MVP routes", () => {
  const result = validateRateLimitConfig(buildDefaultRouteRateLimits());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("reports missing required route limits", () => {
  const result = validateRateLimitConfig({});

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("/provider-secrets/session")));
});

test("reports invalid numeric limits and burst over rate", () => {
  const config = buildDefaultRouteRateLimits();
  config["POST /resource-sessions/{sessionId}/commands"] = {
    requestsPerMinute: 5,
    burst: 6
  };

  const result = validateRateLimitConfig(config);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("burst cannot exceed")));
});

test("reports unknown route keys to catch stale override drift", () => {
  const config = buildDefaultRouteRateLimits();
  config["POST /resource-session/{sessionId}/commands"] = {
    requestsPerMinute: 10,
    burst: 2
  };

  const result = validateRateLimitConfig(config);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("is not a known service route")));
});
