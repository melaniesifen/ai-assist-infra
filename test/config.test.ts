import assert from "node:assert/strict";
import test from "node:test";
import { getDynamoDbTableSpec, listDynamoDbTableSpecs } from "../src/config/dynamodb-tables";
import {
  buildEnvironmentResourceName,
  buildTargetResourceName,
  isProductionEnvironment,
  listDeploymentTargets,
  normalizeEnvironmentName,
  validateInitialDeploymentTargets
} from "../src/config/environments";
import { DYNAMODB_ACCESS_LEVELS, KMS_ACCESS_LEVELS, formatIamBoundaryMarkdown, listIamBoundaryDocuments } from "../src/config/iam-boundaries";
import { KMS_PURPOSES, getKmsAlias, getTargetKmsAlias, listKmsPurposeMappings } from "../src/config/kms-purposes";
import { FORBIDDEN_LOG_FIELDS, SAFE_AUDIT_EVENTS, validateOperationalGuardrails } from "../src/config/operational-guardrails";
import { buildDefaultRouteRateLimits, validateRateLimitConfig } from "../src/config/rate-limits";
import { REQUIRED_RUNTIME_CONFIG, validateRuntimeConfig } from "../src/config/runtime-config";
import { SERVICES, findServiceRoute, groupRoutesByService, listServiceRoutes } from "../src/config/service-routes";

test("normalizes supported environment aliases", () => {
  assert.equal(normalizeEnvironmentName("production"), "prod");
  assert.equal(normalizeEnvironmentName(" development "), "dev");
  assert.equal(normalizeEnvironmentName(" staging "), "stage");
  assert.equal(isProductionEnvironment("prod"), true);
  assert.equal(buildEnvironmentResourceName("dev", "http-api"), "ai-assist-dev-http-api");
  assert.throws(() => normalizeEnvironmentName(" "), /environment name is required/);
  assert.throws(() => normalizeEnvironmentName("qa"), /unsupported environment/);
  assert.throws(() => buildEnvironmentResourceName("dev", " "), /resource name is required/);
});

test("defines exactly two initial deployment targets in one account and region", () => {
  const targets = listDeploymentTargets();
  const result = validateInitialDeploymentTargets(targets);

  assert.equal(result.valid, true);
  assert.deepEqual(targets.map((target) => target.environmentName), ["dev", "prod"]);
  assert.deepEqual([...new Set(targets.map((target) => target.accountEnvVar))], ["CDK_DEFAULT_ACCOUNT"]);
  assert.deepEqual([...new Set(targets.map((target) => target.region))], ["us-west-2"]);
  assert.equal(targets.find((target) => target.environmentName === "prod")?.removalProtection, true);
  assert.equal(buildTargetResourceName(targets[0], "http-api"), "ai-assist-dev-us-west-2-http-api");

  const invalid = validateInitialDeploymentTargets([targets[0], { ...targets[0], stackName: "DuplicateStack" }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("prod deployment target is required")));
});

test("includes MVP SSE route under the session events service", () => {
  const route = findServiceRoute("GET", "/resource-sessions/{sessionId}/events");

  assert.equal(route?.service, SERVICES.SESSION_EVENTS);
  assert.equal(route?.rateLimitTier, "STREAM");
  assert.equal(route?.requiresAuthentication, true);
});

test("returns defensive route copies grouped by service", () => {
  const routes = listServiceRoutes();
  routes[0] = { ...routes[0], service: SERVICES.SECRETS };

  assert.notEqual(listServiceRoutes()[0].service, SERVICES.SECRETS);
  assert.ok(groupRoutesByService()[SERVICES.ORCHESTRATION].some((route) => route.path.includes("/commands")));
});

test("defines TTL and encrypted field metadata for sensitive DynamoDB tables", () => {
  const sessionSecrets = getDynamoDbTableSpec("SessionSecrets");
  const proposedActions = getDynamoDbTableSpec("ProposedActions");

  assert.equal(sessionSecrets.defaultTtlHours, 8);
  assert.deepEqual(sessionSecrets.encryptedFields, ["encryptedSecret"]);
  assert.equal(proposedActions.defaultTtlHours, 24);
  assert.ok(proposedActions.encryptedFields.includes("encryptedPayload"));
  assert.throws(() => getDynamoDbTableSpec("RawPrompts"), /unknown DynamoDB table/);
});

test("can exclude optional session event table from pure inventory views", () => {
  const names = listDynamoDbTableSpecs({ includeOptional: false }).map((spec) => spec.name);

  assert.equal(names.includes("SessionEvents"), false);
  assert.equal(names.includes("ResourceSessions"), true);
});

test("keeps KMS aliases purpose-specific and optional mappings filterable", () => {
  assert.equal(getKmsAlias("prod", KMS_PURPOSES.SESSION_SECRETS), "alias/ai-assist-prod-session-secrets-key");
  assert.equal(getTargetKmsAlias(listDeploymentTargets()[0], KMS_PURPOSES.SESSION_SECRETS), "alias/ai-assist-dev-us-west-2-session-secrets-key");
  assert.equal(listKmsPurposeMappings({ includeOptional: false }).some((item) => item.purpose === KMS_PURPOSES.USER_SECRETS), false);
  assert.throws(() => getKmsAlias("dev", "raw-content"), /unknown KMS purpose/);
});

test("validates trusted-user runtime config without leaking secret values", () => {
  const validConfig = Object.fromEntries(REQUIRED_RUNTIME_CONFIG.map((entry) => [entry.name, entry.name.endsWith("_URL") || entry.name.endsWith("_URI") || entry.name === "AI_ASSIST_ALLOWED_CORS_ORIGINS" ? "https://example.test" : "configured"]));
  validConfig.AI_ASSIST_TRUSTED_USER_MODE = "true";
  assert.equal(validateRuntimeConfig(validConfig).valid, true);

  const invalid = validateRuntimeConfig({
    ...validConfig,
    GOOGLE_OAUTH_CLIENT_SECRET_ARN: "super-secret-value",
    AI_ASSIST_AUTH_SERVICE_URL: "http://localhost:8080",
    AI_ASSIST_TRUSTED_USER_MODE: "false"
  });

  assert.equal(invalid.valid, false);
  assert.equal(invalid.setupStatus, "blocked");
  assert.ok(invalid.safeMessages.some((message) => message.includes("AI_ASSIST_AUTH_SERVICE_URL must use https")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("AI_ASSIST_TRUSTED_USER_MODE must be true")));
  assert.equal(JSON.stringify(invalid).includes("super-secret-value"), false);
});

test("defines metadata-only audit, metrics, alarms, and runbooks for guarded paths", () => {
  assert.deepEqual(validateOperationalGuardrails(), { valid: true, errors: [] });

  for (const event of SAFE_AUDIT_EVENTS) {
    for (const forbidden of FORBIDDEN_LOG_FIELDS) {
      assert.equal(event.fields.includes(forbidden), false, `${event.eventName} must not log ${forbidden}`);
    }
  }
});

test("documents service table and KMS IAM boundaries", () => {
  const docs = listIamBoundaryDocuments();
  const secrets = docs.find((entry) => entry.service === SERVICES.SECRETS);
  const markdown = formatIamBoundaryMarkdown();

  assert.deepEqual(secrets?.tableAccess.map((table) => table.tableName), ["SessionSecrets"]);
  assert.ok(secrets?.kmsPurposes.includes("session-secrets"));
  assert.ok(secrets?.tableAccess.every((table) => table.access.includes(DYNAMODB_ACCESS_LEVELS.WRITE)));
  assert.ok(secrets?.kmsAccess.every((key) => key.access.includes(KMS_ACCESS_LEVELS.ENCRYPT)));

  const googleDocs = docs.find((entry) => entry.service === SERVICES.GOOGLE_DOCS_ADAPTER);
  assert.deepEqual(googleDocs?.tableAccess[0].access, [DYNAMODB_ACCESS_LEVELS.READ]);
  assert.deepEqual(googleDocs?.kmsAccess[0].access, [KMS_ACCESS_LEVELS.DESCRIBE, KMS_ACCESS_LEVELS.DECRYPT]);
  assert.match(markdown, /\| Service \| DynamoDB Tables \| KMS Purposes \| Notes \|/);
  assert.match(markdown, /ProposedActions/);
});

test("validates default route rate limits and stale overrides", () => {
  const config = buildDefaultRouteRateLimits();
  assert.deepEqual(validateRateLimitConfig(config), { valid: true, errors: [] });
  assert.deepEqual(validateRateLimitConfig(null), { valid: false, errors: ["rate limit config must be an object"] });

  const missingRequired = validateRateLimitConfig({});
  assert.equal(missingRequired.valid, false);
  assert.ok(missingRequired.errors.some((error) => error.includes("/provider-secrets/session")));

  const invalid = {
    ...config,
    "POST /resource-session/{sessionId}/commands": {
      requestsPerMinute: 10,
      burst: 2
    },
    "POST /resource-sessions/{sessionId}/commands": {
      requestsPerMinute: 5,
      burst: 6
    },
    "GET /providers": {
      requestsPerMinute: 0,
      burst: 1
    }
  };
  const result = validateRateLimitConfig(invalid);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("is not a known service route")));
  assert.ok(result.errors.some((error) => error.includes("burst cannot exceed")));
  assert.ok(result.errors.some((error) => error.includes("GET /providers.requestsPerMinute must be a positive integer")));
});
