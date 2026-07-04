import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PYTHON_SERVICE_BASE_IMAGE, PYTHON_SERVICE_CONTAINER_ASSETS, validateContainerAssetConfig } from "../src/config/container-assets";
import { DEPLOYMENT_CONFIG_CONTEXT_KEY, parseDeploymentConfigContext } from "../src/config/deployment-config";
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
import { SERVICE_ROUTES, SERVICES, findServiceRoute, groupRoutesByService, listServiceRoutes } from "../src/config/service-routes";

test("normalizes supported environment aliases", () => {
  assert.equal(normalizeEnvironmentName("production"), "prod");
  assert.equal(normalizeEnvironmentName(" development "), "dev");
  assert.equal(normalizeEnvironmentName(" staging "), "gamma");
  assert.equal(normalizeEnvironmentName(" stage "), "gamma");
  assert.equal(isProductionEnvironment("prod"), true);
  assert.equal(buildEnvironmentResourceName("dev", "http-api"), "ai-assist-dev-http-api");
  assert.throws(() => normalizeEnvironmentName(" "), /environment name is required/);
  assert.throws(() => normalizeEnvironmentName("qa"), /unsupported environment/);
  assert.throws(() => buildEnvironmentResourceName("dev", " "), /resource name is required/);
});

test("defines dev gamma and prod deployment targets in one account and region", () => {
  const targets = listDeploymentTargets();
  const result = validateInitialDeploymentTargets(targets);

  assert.equal(result.valid, true);
  assert.deepEqual(targets.map((target) => target.environmentName), ["dev", "gamma", "prod"]);
  assert.deepEqual([...new Set(targets.map((target) => target.accountEnvVar))], ["CDK_DEFAULT_ACCOUNT"]);
  assert.deepEqual([...new Set(targets.map((target) => target.region))], ["us-west-2"]);
  assert.equal(targets.find((target) => target.environmentName === "gamma")?.removalProtection, true);
  assert.equal(targets.find((target) => target.environmentName === "prod")?.removalProtection, true);
  assert.equal(buildTargetResourceName(targets[0], "http-api"), "ai-assist-dev-us-west-2-http-api");

  const invalid = validateInitialDeploymentTargets([targets[0], { ...targets[0], stackName: "DuplicateStack" }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("prod deployment target is required")));
});

test("defines secure repeatable Python service container asset inputs", () => {
  const result = validateContainerAssetConfig();

  assert.equal(result.valid, true);
  assert.equal(PYTHON_SERVICE_CONTAINER_ASSETS.length, Object.values(SERVICES).length);
  assert.equal(PYTHON_SERVICE_BASE_IMAGE.includes(":latest"), false);
  assert.ok(PYTHON_SERVICE_CONTAINER_ASSETS.every((asset) => asset.sourceDirectory.startsWith("ai-assist-")));
  assert.ok(PYTHON_SERVICE_CONTAINER_ASSETS.some((asset) => asset.service === SERVICES.SESSION_EVENTS));
});

test("defines a dogfood runtime image that includes every service package", () => {
  const dockerfile = readFileSync(path.join(process.cwd(), "docker/dogfood-runtime/Dockerfile"), "utf8");
  const dispatcher = readFileSync(path.join(process.cwd(), "docker/dogfood-runtime/ai_assist_dogfood_runtime/http_app.py"), "utf8");
  const sharedServer = readFileSync(path.join(process.cwd(), "docker/python-service/health_server.py"), "utf8");
  const buildContextsByService = new Map([
    [SERVICES.AUTH, "auth_service"],
    [SERVICES.SECRETS, "secrets_service"],
    [SERVICES.ORCHESTRATION, "orchestration_service"],
    [SERVICES.SESSION_EVENTS, "session_events_service"],
    [SERVICES.CONTEXT, "context_service"],
    [SERVICES.GOOGLE_DOCS_ADAPTER, "google_docs_adapter"]
  ]);

  assert.match(dockerfile, /PYTHON_PACKAGE=ai_assist_dogfood_runtime/);
  assert.match(dispatcher, /def handle_http_request/);
  assert.match(dispatcher, /text\/event-stream/);
  for (const asset of PYTHON_SERVICE_CONTAINER_ASSETS) {
    const buildContext = buildContextsByService.get(asset.service);
    assert.ok(buildContext, `${asset.service} must have a dogfood build context`);
    assert.match(dockerfile, new RegExp(`COPY --from=${buildContext} pyproject\\.toml`));
    assert.match(dockerfile, new RegExp(`COPY --from=${buildContext} src`));
    assert.match(dispatcher, new RegExp(asset.pythonPackage));
  }
  for (const route of SERVICE_ROUTES.filter((candidate) => !candidate.intentionallyPlaceholder)) {
    assert.match(dispatcher, new RegExp(route.service), `${route.routeKey} must preserve owning service metadata`);
  }
  for (const method of new Set(SERVICE_ROUTES.filter((candidate) => !candidate.intentionallyPlaceholder).map((route) => route.method))) {
    assert.match(sharedServer, new RegExp(`def do_${method}\\(`), `shared Python server must handle ${method}`);
  }
});

test("dogfood runtime dispatcher imports and handles the SSE route", () => {
  const script = [
    "import ai_assist_dogfood_runtime.http_app as app",
    "response = app.handle_http_request(method='GET', path='/sessions/test-session/events')",
    "assert response['status'] == 200, response",
    "assert response['headers']['Content-Type'] == 'text/event-stream', response",
    "assert b'dogfood runtime sse path ready' in response['body'], response"
  ].join("; ");
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: path.join(process.cwd(), "docker/dogfood-runtime")
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("parses local deployment config from CDK context without exposing secrets", () => {
  const config = parseDeploymentConfigContext(
    {
      dev: {
        hostedZoneId: "Z1234567890ABC",
        hostedZoneName: "example.test",
        sseDomainName: "sse.dev.example.test",
        edgeJwtAuthEnabled: true,
        productAuthIssuer: "https://auth.dev.example.test/",
        productAuthAudience: "ai-assist-dev",
        trustedUserTenantId: "dev-tenant",
        trustedUserUserId: "dev-user"
      }
    },
    "dev"
  );

  assert.equal(config.productAuthAudience, "ai-assist-dev");
  assert.equal(config.productAuthIssuer, "https://auth.dev.example.test/");
  assert.equal(config.trustedUserTenantId, "dev-tenant");
  assert.equal(config.trustedUserUserId, "dev-user");
  assert.equal(config.edgeJwtAuthEnabled, true);
  assert.equal(
    parseDeploymentConfigContext(
      {
        dev: {
          hostedZoneId: "Z1234567890ABC",
          hostedZoneName: "example.test",
          sseDomainName: "sse.dev.example.test",
          edgeJwtAuthEnabled: false,
          productAuthAudience: "ai-assist-dev",
          trustedUserTenantId: "dev-tenant",
          trustedUserUserId: "dev-user"
        }
      },
      "dev"
    ).edgeJwtAuthEnabled,
    false
  );
  assert.throws(() => parseDeploymentConfigContext({}, "dev"), new RegExp(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.dev is required`));
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          dev: {
            hostedZoneId: "not-a-zone-id",
            hostedZoneName: "example.test",
            sseDomainName: "sse.dev.example.test",
            edgeJwtAuthEnabled: true,
            productAuthIssuer: "http://auth.dev.example.test/",
            productAuthAudience: "ai-assist-dev",
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user"
          }
        },
        "dev"
      ),
    /hostedZoneId must be a Route 53 hosted zone id/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          dev: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.other.test",
            edgeJwtAuthEnabled: true,
            productAuthIssuer: "https://auth.dev.example.test/",
            productAuthAudience: "ai-assist-dev",
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user"
          }
        },
        "dev"
      ),
    /sseDomainName must be a subdomain of hostedZoneName/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          gamma: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.gamma.example.test",
            edgeJwtAuthEnabled: false,
            productAuthAudience: "ai-assist-gamma",
            trustedUserTenantId: "gamma-tenant",
            trustedUserUserId: "gamma-user"
          }
        },
        "gamma"
      ),
    /edgeJwtAuthEnabled may be false only for dev/
  );
});

test("defines canonical M9 auth OAuth resource action and SSE route contract", () => {
  const canonicalRoutes = [
    "POST /auth/login",
    "POST /auth/logout",
    "GET /auth/session",
    "POST /oauth/google/start",
    "GET /oauth/google/callback",
    "GET /oauth/google/status",
    "DELETE /oauth/google/connection",
    "GET /setup/status",
    "POST /provider-secrets/session",
    "GET /provider-secrets/session/{provider}/status",
    "DELETE /provider-secrets/session/{provider}",
    "GET /providers",
    "GET /resources",
    "POST /resource-sessions",
    "GET /resource-sessions/{sessionId}",
    "POST /resource-sessions/{sessionId}/commands",
    "GET /sessions/{sessionId}/events",
    "GET /context-modes",
    "PUT /resource-sessions/{sessionId}/context-mode",
    "POST /resource-sessions/{sessionId}/context-preview",
    "GET /resource-sessions/{sessionId}/actions",
    "POST /resource-sessions/{sessionId}/actions/{actionId}/approve",
    "POST /resource-sessions/{sessionId}/actions/{actionId}/reject",
    "POST /resource-sessions/{sessionId}/apply-action"
  ];
  const routeKeys = SERVICE_ROUTES.map((route) => route.routeKey);
  const route = findServiceRoute("GET", "/sessions/{sessionId}/events");

  assert.deepEqual(routeKeys, ["GET /health", ...canonicalRoutes]);
  assert.equal(route?.service, SERVICES.SESSION_EVENTS);
  assert.equal(route?.rateLimitTier, "STREAM");
  assert.equal(route?.requiresAuthentication, true);
  assert.equal(route?.edgeSurface, "public-alb");
  assert.equal(SERVICE_ROUTES.filter((candidate) => candidate.intentionallyPlaceholder).map((candidate) => candidate.routeKey).join(","), "GET /health");
  assert.equal(findServiceRoute("GET", "/auth/google/start"), null);
  assert.equal(findServiceRoute("GET", "/resource-sessions/{sessionId}/events"), null);
  assert.equal(findServiceRoute("GET", "/oauth/google/callback")?.requiresAuthentication, false);
  assert.equal(findServiceRoute("POST", "/auth/login")?.requiresAuthentication, false);
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

test("keeps KMS purpose validation while resolving to one shared app key", () => {
  assert.equal(getKmsAlias("prod", KMS_PURPOSES.OAUTH_TOKENS), "alias/ai-assist-prod-app-key");
  assert.equal(getKmsAlias("prod", KMS_PURPOSES.SESSION_SECRETS), "alias/ai-assist-prod-app-key");
  assert.equal(getTargetKmsAlias(listDeploymentTargets()[0], KMS_PURPOSES.SESSION_SECRETS), "alias/ai-assist-dev-us-west-2-app-key");
  assert.equal(listKmsPurposeMappings({ includeOptional: false }).some((item) => item.purpose === KMS_PURPOSES.USER_SECRETS), false);
  assert.throws(() => getKmsAlias("dev", "raw-content"), /unknown KMS purpose/);
});

test("validates trusted-user runtime config without leaking secret values", () => {
  const validConfig = Object.fromEntries(REQUIRED_RUNTIME_CONFIG.map((entry) => [entry.name, "configured"]));
  validConfig.WEB_APP_BASE_URL = "https://example.test";
  validConfig.API_BASE_URL = "https://api.example.test";
  validConfig.SSE_BASE_URL = "https://sse.example.test";
  validConfig.GOOGLE_OAUTH_CALLBACK_URL = "https://api.example.test/oauth/google/callback";
  validConfig.ALLOWED_ORIGINS = "https://example.test";
  validConfig.SESSION_SECRET_TTL_HOURS = "8";
  validConfig.PROPOSED_ACTION_TTL_HOURS = "24";
  validConfig.SSE_HEARTBEAT_SECONDS = "25";
  validConfig.SSE_REPLAY_WINDOW_SECONDS = "300";
  validConfig.TRUSTED_USER_MODE = "true";
  assert.equal(validateRuntimeConfig(validConfig).valid, true);

  const invalid = validateRuntimeConfig({
    ...validConfig,
    GOOGLE_OAUTH_CLIENT_SECRET_REF: "super-secret-value",
    API_BASE_URL: "http://localhost:8080",
    GOOGLE_OAUTH_CALLBACK_URL: "https://api.example.test/auth/google/callback",
    ALLOWED_ORIGINS: "https://example.test,http://bad.example.test",
    SSE_HEARTBEAT_SECONDS: "soon",
    TRUSTED_USER_MODE: "false"
  });

  assert.equal(invalid.valid, false);
  assert.equal(invalid.setupStatus, "blocked");
  assert.ok(invalid.safeMessages.some((message) => message.includes("API_BASE_URL must use https")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("GOOGLE_OAUTH_CALLBACK_URL must use /oauth/google/callback")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("ALLOWED_ORIGINS origin http://bad.example.test must use https")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("TRUSTED_USER_MODE must be true")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("SSE_HEARTBEAT_SECONDS must be a positive integer")));
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
