import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PYTHON_SERVICE_BASE_IMAGE, PYTHON_SERVICE_CONTAINER_ASSETS, validateContainerAssetConfig } from "../src/config/container-assets";
import { DEPLOYMENT_CONFIG_CONTEXT_KEY, getWebAppDomainName, parseDeploymentConfigContext } from "../src/config/deployment-config";
import { buildDogfoodRuntimeSourceHash } from "../src/config/dogfood-runtime-source-hash";
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
  assert.deepEqual(targets.map((target) => target.runtimeResourceName), ["dogfood-runtime", "shared-runtime", "shared-runtime"]);
  assert.deepEqual([...new Set(targets.map((target) => target.accountEnvVar))], ["CDK_DEFAULT_ACCOUNT"]);
  assert.deepEqual([...new Set(targets.map((target) => target.region))], ["us-west-2"]);
  assert.equal(targets.find((target) => target.environmentName === "gamma")?.removalProtection, true);
  assert.equal(targets.find((target) => target.environmentName === "prod")?.removalProtection, true);
  assert.equal(buildTargetResourceName(targets[0], "http-api"), "ai-assist-dev-us-west-2-http-api");

  const invalid = validateInitialDeploymentTargets([targets[0], { ...targets[0], stackName: "DuplicateStack" }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("prod deployment target is required")));

  const invalidGammaName = validateInitialDeploymentTargets([
    targets[0],
    { ...targets[1], runtimeResourceName: "dogfood-runtime" },
    targets[2]
  ]);
  assert.equal(invalidGammaName.valid, false);
  assert.ok(invalidGammaName.errors.some((error) => error.includes("gamma runtime resource name must not include dogfood")));
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
  assert.match(dispatcher, /supports_sse=True/);
  assert.match(dispatcher, /def session_events_handler/);
  assert.match(dispatcher, /def _conditional_put/);
  assert.match(dispatcher, /attribute_not_exists\(applyLock\)/);
  assert.match(dispatcher, /#applyLock\.#idempotencyKey = :idempotencyKey/);
  assert.match(sharedServer, /def _write_stream_response/);
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

test("dogfood runtime source hash changes when service source changes", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ai-assist-dogfood-hash-"));
  const runtimeRoot = path.join(workspaceRoot, "ai-assist-infra/docker/dogfood-runtime");
  mkdirSync(path.join(runtimeRoot, "ai_assist_dogfood_runtime"), { recursive: true });
  writeFileSync(path.join(runtimeRoot, "Dockerfile"), "FROM python:3.13\n");
  writeFileSync(path.join(runtimeRoot, "ai_assist_dogfood_runtime/http_app.py"), "def handle_http_request(): pass\n");

  for (const asset of PYTHON_SERVICE_CONTAINER_ASSETS) {
    const serviceRoot = path.join(workspaceRoot, asset.sourceDirectory);
    mkdirSync(path.join(serviceRoot, "src", asset.pythonPackage), { recursive: true });
    writeFileSync(path.join(serviceRoot, "pyproject.toml"), `[project]\nname = "${asset.sourceDirectory}"\n`);
    writeFileSync(path.join(serviceRoot, "src", asset.pythonPackage, "__init__.py"), "\n");
  }

  const before = buildDogfoodRuntimeSourceHash(workspaceRoot, runtimeRoot);
  const targetAsset = PYTHON_SERVICE_CONTAINER_ASSETS.find((asset) => asset.service === SERVICES.ORCHESTRATION);
  assert.ok(targetAsset);
  writeFileSync(path.join(workspaceRoot, targetAsset.sourceDirectory, "src", targetAsset.pythonPackage, "http_app.py"), "def handle_http_request(): return {}\n");
  const afterServiceChange = buildDogfoodRuntimeSourceHash(workspaceRoot, runtimeRoot);
  assert.notEqual(afterServiceChange, before);

  mkdirSync(path.join(workspaceRoot, targetAsset.sourceDirectory, "src", targetAsset.pythonPackage, "__pycache__"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, targetAsset.sourceDirectory, "src", targetAsset.pythonPackage, "__pycache__", "http_app.cpython-313.pyc"), "ignored");
  assert.equal(buildDogfoodRuntimeSourceHash(workspaceRoot, runtimeRoot), afterServiceChange);
});

test("dogfood runtime dispatcher delegates the SSE route to the session-events runtime", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
import os
from ai_assist_session_events import http_app as events
events.reset_runtime_for_tests()
os.environ[app.TRUSTED_UPSTREAM_SSE_HEADERS_ENV] = "true"
events.publish_session_event({
    "eventId": "evt_001",
    "tenantId": "tenant_001",
    "userId": "user_001",
    "sessionId": "session_001",
    "requestId": "req_001",
    "correlationId": "corr_001",
    "type": "progress",
    "sequence": 1,
    "createdAt": "2026-05-29T00:00:00.000Z",
    "payload": {"stage": "context.loading", "status": "started", "messageCode": "CONTEXT_LOADING"},
})
response = app.handle_http_request(
    method="GET",
    path="/sessions/session_001/events",
    headers={"X-AI-Assist-Tenant-Id": "tenant_001", "X-AI-Assist-User-Id": "user_001"},
)
assert response["status"] == 200, response
assert response["headers"]["Content-Type"] == "text/event-stream; charset=utf-8", response
chunk = response["stream"].pop_pending()[0]
assert chunk.startswith("id: evt_001\\n"), chunk
assert "dogfood runtime sse path ready" not in chunk, chunk
app.dogfood_session_event_publisher().publish({
    "eventId": "evt_002",
    "tenantId": "tenant_001",
    "userId": "user_001",
    "sessionId": "session_001",
    "requestId": "req_002",
    "correlationId": "corr_001",
    "type": "assistant.delta",
    "sequence": 2,
    "createdAt": "2026-05-29T00:00:01.000Z",
    "payload": {"messageId": "msg_001", "delta": "hello", "index": 0},
})
published_chunk = response["stream"].pop_pending()[0]
assert published_chunk.startswith("id: evt_002\\n"), published_chunk
assert '"type":"assistant.delta"' in published_chunk, published_chunk
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-session-events-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime rejects caller-supplied SSE trusted headers unless trusted upstream is enabled", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
from ai_assist_session_events import http_app as events
events.reset_runtime_for_tests()
response = app.handle_http_request(
    method="GET",
    path="/sessions/session_001/events",
    headers={"X-AI-Assist-Tenant-Id": "spoofed-tenant", "X-AI-Assist-User-Id": "spoofed-user"},
)
assert response["status"] == 401, response
assert "stream" not in response, response
assert events.stream_log_records()[0]["errorCode"] == "AUTH_CONTEXT_REQUIRED", events.stream_log_records()
class Codec:
    def verify_bearer(self, header):
        raise RuntimeError("public SSE must not accept edge JWT identity")
class Identity:
    def derive_identity(self, product_session):
        raise AssertionError("identity should not be derived")
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
app._AUTH_APP = AuthApp()
forged = app.handle_http_request(
    method="GET",
    path="/sessions/session_001/events",
    headers={
        "authorization": "Bearer forged.jwt.signature",
        "x-ai-assist-auth-subject": "cognito-subject-a",
    },
)
assert forged["status"] == 500, forged
assert "stream" not in forged, forged
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-session-events-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime derives session-events identity from product session bearer", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
from ai_assist_session_events import http_app as events
events.reset_runtime_for_tests()
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        assert product_session == {"session": "session-1"}, product_session
        return {"tenantId": "tenant_001", "userId": "user_001", "authSubject": "trusted-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
app._AUTH_APP = AuthApp()
events.publish_session_event({
    "eventId": "evt_001",
    "tenantId": "tenant_001",
    "userId": "user_001",
    "sessionId": "session_001",
    "requestId": "req_001",
    "correlationId": "corr_001",
    "type": "progress",
    "sequence": 1,
    "createdAt": "2026-05-29T00:00:00.000Z",
    "payload": {"stage": "context.loading", "status": "started", "messageCode": "CONTEXT_LOADING"},
})
response = app.handle_http_request(
    method="GET",
    path="/sessions/session_001/events",
    headers={
        "authorization": "Bearer session-1",
        "x-ai-assist-tenant-id": "attacker-tenant",
        "X-Ai-Assist-User-Id": "attacker-user",
        "Last-Event-ID": "evt_missing",
    },
)
assert response["status"] == 200, response
assert response["headers"]["Content-Type"] == "text/event-stream; charset=utf-8", response
chunk = response["stream"].pop_pending()[0]
assert "REFRESH_SESSION_STATE" in chunk, chunk
open_log = events.stream_log_records()[0]
assert open_log["tenantId"] == "tenant_001", open_log
assert open_log["userId"] == "user_001", open_log
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-session-events-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("shared python HTTP wrapper preserves streaming responses without content length", () => {
  const wrapper = readFileSync(path.join(process.cwd(), "docker/python-service/health_server.py"), "utf8");

  assert.match(wrapper, /def _write_stream_response/);
  assert.match(wrapper, /stream\.pop_pending\(\)/);
  assert.match(wrapper, /stream\.heartbeat\(\)/);
  assert.match(wrapper, /close\(disconnect_reason="client_disconnect"\)/);
});

test("dogfood runtime dispatcher normalizes lambda-style package responses", () => {
  const script = [
    "import json",
    "import ai_assist_dogfood_runtime.http_app as app",
    "response = app.normalize_package_response({'statusCode': 418, 'headers': {'X-Test': 'yes'}, 'body': {'error': {'code': 'TEAPOT'}}})",
    "assert response['status'] == 418, response",
    "assert response['headers']['Content-Type'] == 'application/json', response",
    "assert response['headers']['X-Test'] == 'yes', response",
    "assert json.loads(response['body'].decode('utf-8'))['error']['code'] == 'TEAPOT', response"
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

test("dogfood runtime action routes return safe dependency errors until action deps are configured", () => {
  const script = `
import json
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        return {"tenantId": "tenant_001", "userId": "user_001", "authSubject": "trusted-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
app._AUTH_APP = AuthApp()
app._ORCHESTRATION_CONFIGURED = False
response = app.handle_http_request(
    method="GET",
    path="/resource-sessions/session_001/actions",
    headers={"authorization": "Bearer session-1"},
)
body = json.loads(response["body"].decode("utf-8"))
assert response["status"] == 501, response
assert body["error"]["code"] == "ORCHESTRATION_DEPENDENCIES_NOT_CONFIGURED", body
assert body["error"]["metadata"]["operation"] == "list_actions", body
assert body["error"]["metadata"]["sessionId"] == "session_001", body
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-orchestration-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime wires proposed action create list get approve reject and apply dependencies", () => {
  const script = `
import json
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        return {"tenantId": "tenant_001", "userId": "user_001", "authSubject": "trusted-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
class FakeActions:
    def __init__(self):
        self.calls = []
    async def create_proposed_action(self, identity, input_data):
        self.calls.append(("create", identity, input_data))
        return {"actionId": "action_001", "status": "PROPOSED", "sessionId": input_data["sessionId"], "resourceId": input_data["resourceId"]}
    async def list_actions(self, identity, input_data):
        self.calls.append(("list", identity, input_data))
        return {"actions": [{"actionId": "action_001", "status": "PROPOSED"}]}
    async def get_action(self, identity, input_data):
        self.calls.append(("get", identity, input_data))
        return {"actionId": input_data["actionId"], "status": "PROPOSED"}
    async def approve_action(self, identity, input_data):
        self.calls.append(("approve", identity, input_data))
        return {"actionId": input_data["actionId"], "status": "APPROVED"}
    async def reject_action(self, identity, input_data):
        self.calls.append(("reject", identity, input_data))
        return {"actionId": input_data["actionId"], "status": "REJECTED"}
    async def apply_action(self, identity, input_data):
        self.calls.append(("apply", identity, input_data))
        return {"actionId": input_data["actionId"], "status": "APPLIED"}
fake_actions = FakeActions()
app._AUTH_APP = AuthApp()
app._ORCHESTRATION_CONFIGURED = False
app.dogfood_action_service = lambda orchestration_module=None: fake_actions
headers = {"authorization": "Bearer session-1", "content-type": "application/json", "idempotency-key": "idem-1"}
create_body = {
    "provider": "google_docs",
    "resourceId": "doc_001",
    "resourceRevision": "rev_001",
    "targetRange": {"start": 0, "end": 4},
    "originalTextHash": "sha256:original",
    "actionType": "replace_text",
    "payload": {"proposedText": "safe replacement"},
}
requests = [
    ("POST", "/resource-sessions/session_001/actions", create_body),
    ("GET", "/resource-sessions/session_001/actions", None),
    ("GET", "/resource-sessions/session_001/actions/action_001", {"resourceId": "doc_001"}),
    ("POST", "/resource-sessions/session_001/actions/action_001/approve", {"resourceId": "doc_001"}),
    ("POST", "/resource-sessions/session_001/actions/action_001/reject", {"resourceId": "doc_001"}),
    ("POST", "/resource-sessions/session_001/apply-action", {"actionId": "action_001", "resourceId": "doc_001"}),
]
statuses = []
for method, path, body in requests:
    response = app.handle_http_request(
        method=method,
        path=path,
        headers=headers,
        body=None if body is None else json.dumps(body).encode("utf-8"),
    )
    statuses.append(response["status"])
assert statuses == [201, 200, 200, 200, 200, 200], statuses
assert [call[0] for call in fake_actions.calls] == ["create", "list", "get", "approve", "reject", "apply"], fake_actions.calls
apply_call = fake_actions.calls[-1][2]
assert apply_call["idempotencyKey"] == "idem-1", apply_call
assert all(call[1]["tenantId"] == "tenant_001" and call[1]["userId"] == "user_001" for call in fake_actions.calls), fake_actions.calls
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-orchestration-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime strips caller identity headers before adding derived identity", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        assert product_session == {"session": "session-1"}, product_session
        return {"tenantId": "trusted-tenant", "userId": "trusted-user", "authSubject": "trusted-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
app._AUTH_APP = AuthApp()
headers = {
    "authorization": "Bearer session-1",
    "x-ai-assist-tenant-id": "attacker-tenant",
    "X-Ai-Assist-User-Id": "attacker-user",
    "x-ai-assist-auth-subject": "attacker-subject",
    "x-request-id": "req-1",
}
result = app.authenticated_downstream_headers(headers)
assert result["X-Ai-Assist-Tenant-Id"] == "trusted-tenant", result
assert result["X-Ai-Assist-User-Id"] == "trusted-user", result
assert result["X-Ai-Assist-Auth-Subject"] == "trusted-subject", result
assert result["x-request-id"] == "req-1", result
assert "x-ai-assist-tenant-id" not in result, result
`;
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

test("dogfood runtime reports platform provider status as metadata only", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        return {"tenantId": "trusted-tenant", "userId": "trusted-user", "authSubject": "trusted-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
app._AUTH_APP = AuthApp()
os.environ["PLATFORM_PROVIDER_DEFAULT"] = "openai"
os.environ["PLATFORM_PROVIDER_SECRET_REF_OPENAI"] = "openai-secret-ref"
os.environ["PLATFORM_PROVIDER_MODEL_OPENAI"] = "test-model"
os.environ["PLATFORM_PROVIDER_OWNER_DEV_ENABLED"] = "true"
os.environ["PLATFORM_PROVIDER_QUOTA_MODE"] = "enforced"
os.environ["PLATFORM_PROVIDER_AUDIT_MODE"] = "metadata"
os.environ.pop("PLATFORM_PROVIDER_SECRET_REF_ANTHROPIC", None)
response = app.handle_http_request(
    method="GET",
    path="/providers",
    headers={
        "authorization": "Bearer session-1",
        "x-ai-assist-tenant-id": "caller-tenant",
        "x-ai-assist-user-id": "caller-user",
        "x-request-id": "req-providers",
        "x-correlation-id": "corr-providers",
    },
)
payload = json.loads(response["body"].decode("utf-8"))
assert response["status"] == 200, response
assert response["headers"]["Cache-Control"] == "no-store", response
assert payload["requestId"] == "req-providers", payload
assert payload["correlationId"] == "corr-providers", payload
assert payload["data"]["defaultProvider"] == "openai", payload
providers = {item["provider"]: item for item in payload["data"]["providers"]}
assert providers["openai"]["available"] is True, payload
assert providers["openai"]["default"] is True, payload
assert providers["openai"]["quotaReady"] is True, payload
assert providers["openai"]["auditReady"] is True, payload
assert providers["openai"]["modelConfigured"] is True, payload
assert providers["openai"]["ownerDevEnabled"] is True, payload
assert providers["anthropic"]["status"] == "not_configured", payload
assert "openai-secret-ref" not in json.dumps(payload), payload
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-orchestration-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime keeps platform provider disabled by default", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app
os.environ["PLATFORM_PROVIDER_DEFAULT"] = "openai"
os.environ["PLATFORM_PROVIDER_SECRET_REF_OPENAI"] = "openai-secret-ref"
os.environ["PLATFORM_PROVIDER_MODEL_OPENAI"] = "test-model"
os.environ["PLATFORM_PROVIDER_QUOTA_MODE"] = "enforced"
os.environ["PLATFORM_PROVIDER_AUDIT_MODE"] = "metadata"
os.environ.pop("PLATFORM_PROVIDER_OWNER_DEV_ENABLED", None)
payload = app.platform_provider_status_payload()
providers = {item["provider"]: item for item in payload["providers"]}
assert providers["openai"]["available"] is False, payload
assert providers["openai"]["reasonCode"] == "DOGFOOD_OWNER_DEV_PROVIDER_DISABLED", payload
assert providers["openai"]["ownerDevEnabled"] is False, payload
`;
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

test("dogfood runtime routes owner read-only summarize through OpenAI client hook", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        assert header == "Bearer session-1", header
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        return {"tenantId": "trusted-tenant", "userId": "owner-user", "authSubject": "owner-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
class FakeContext:
    def resolve_context(self, request):
        return {
            "authorized": True,
            "tenantId": request["tenantId"],
            "userId": request["userId"],
            "sessionId": request["sessionId"],
            "provider": "google_docs",
            "contextMode": request["contextMode"],
            "resourceRef": {"provider": "google_docs", "resourceId": request["resourceId"]},
            "resourceRevision": "rev-1",
            "content": "private document text must only reach provider request",
            "provenance": {"connectorVerified": True, "resourceRevision": "rev-1"},
        }
captured = {}
class FakeOpenAiClient:
    def __init__(self, credential):
        self.credential = credential
    def complete(self, request):
        captured["credential"] = self.credential
        captured["request"] = request
        return {
            "model": request["model"],
            "content": "Summary text",
            "finishReason": "stop",
            "usage": {"inputTokens": 11, "outputTokens": 3, "totalTokens": 14},
        }
app._AUTH_APP = AuthApp()
app._ORCHESTRATION_CONFIGURED = False
app.DogfoodContextDependency = lambda: FakeContext()
app.platform_provider_credential = lambda reference: "sk-test-secret"
app.openai_chat_client = lambda credential: FakeOpenAiClient(credential)
os.environ["AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON"] = json.dumps([
    {"authSubject": "owner-subject", "tenantId": "trusted-tenant", "userId": "owner-user", "role": "owner", "status": "active"}
])
os.environ["PLATFORM_PROVIDER_DEFAULT"] = "openai"
os.environ["PLATFORM_PROVIDER_SECRET_REF_OPENAI"] = "openai-secret-ref"
os.environ["PLATFORM_PROVIDER_MODEL_OPENAI"] = "test-model"
os.environ["PLATFORM_PROVIDER_OWNER_DEV_ENABLED"] = "true"
os.environ["PLATFORM_PROVIDER_QUOTA_MODE"] = "enforced"
os.environ["PLATFORM_PROVIDER_AUDIT_MODE"] = "metadata"
response = app.handle_http_request(
    method="POST",
    path="/resource-sessions/session-1/commands",
    headers={"authorization": "Bearer session-1", "idempotency-key": "idem-1", "x-request-id": "req-1"},
    body=json.dumps({"resourceId": "doc-1", "contextMode": "ACTIVE_RESOURCE"}).encode("utf-8"),
)
payload = json.loads(response["body"].decode("utf-8"))
serialized = json.dumps(payload)
assert response["status"] == 202, response
assert payload["data"]["finishReason"] == "stop", payload
assert captured["credential"] == "sk-test-secret", captured
assert captured["request"]["model"] == "test-model", captured
assert "private document text" in captured["request"]["messages"][1]["content"], captured
assert "sk-test-secret" not in serialized, payload
assert "private document text" not in serialized, payload
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-orchestration-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime blocks non-owner platform provider spend", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app
class Codec:
    def verify_bearer(self, header):
        return {"session": "session-1"}
class Identity:
    def derive_identity(self, product_session):
        return {"tenantId": "trusted-tenant", "userId": "member-user", "authSubject": "member-subject"}
class AuthApp:
    product_session_codec = Codec()
    identity_service = Identity()
class FakeContext:
    def resolve_context(self, request):
        return {
            "authorized": True,
            "tenantId": request["tenantId"],
            "userId": request["userId"],
            "sessionId": request["sessionId"],
            "provider": "google_docs",
            "contextMode": request["contextMode"],
            "resourceRef": {"provider": "google_docs", "resourceId": request["resourceId"]},
            "resourceRevision": "rev-1",
            "content": "private document text",
            "provenance": {"connectorVerified": True, "resourceRevision": "rev-1"},
        }
app._AUTH_APP = AuthApp()
app._ORCHESTRATION_CONFIGURED = False
app.DogfoodContextDependency = lambda: FakeContext()
app.platform_provider_credential = lambda reference: (_ for _ in ()).throw(AssertionError("provider secret must not be read"))
os.environ["AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON"] = json.dumps([
    {"authSubject": "member-subject", "tenantId": "trusted-tenant", "userId": "member-user", "role": "member", "status": "active"}
])
os.environ["PLATFORM_PROVIDER_DEFAULT"] = "openai"
os.environ["PLATFORM_PROVIDER_SECRET_REF_OPENAI"] = "openai-secret-ref"
os.environ["PLATFORM_PROVIDER_MODEL_OPENAI"] = "test-model"
os.environ["PLATFORM_PROVIDER_OWNER_DEV_ENABLED"] = "true"
os.environ["PLATFORM_PROVIDER_QUOTA_MODE"] = "enforced"
os.environ["PLATFORM_PROVIDER_AUDIT_MODE"] = "metadata"
response = app.handle_http_request(
    method="POST",
    path="/resource-sessions/session-1/commands",
    headers={"authorization": "Bearer session-1", "idempotency-key": "idem-1"},
    body=json.dumps({"resourceId": "doc-1", "contextMode": "ACTIVE_RESOURCE"}).encode("utf-8"),
)
payload = json.loads(response["body"].decode("utf-8"))
serialized = json.dumps(payload)
assert response["status"] == 403, response
assert payload["error"]["code"] == "DOGFOOD_OWNER_DEV_PROVIDER_OWNER_ONLY", payload
assert "private document text" not in serialized, payload
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-orchestration-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood runtime injects platform provider access into orchestration command bodies", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app
os.environ["PLATFORM_PROVIDER_DEFAULT"] = "openai"
os.environ["PLATFORM_PROVIDER_SECRET_REF_OPENAI"] = "openai-secret-ref"
os.environ["PLATFORM_PROVIDER_QUOTA_MODE"] = "enforced"
os.environ["PLATFORM_PROVIDER_AUDIT_MODE"] = "metadata"
body = app.dogfood_orchestration_body(
    "POST",
    "/resource-sessions/session-1/commands",
    json.dumps({
        "prompt": "do not log me",
        "tenantId": "caller-tenant",
        "userId": "caller-user",
    }).encode("utf-8"),
)
payload = json.loads(body.decode("utf-8"))
assert payload["provider"] == "openai", payload
assert payload["providerAccess"] == {
    "source": "platform",
    "reference": "openai-secret-ref",
    "quotaDecision": {"decision": "allow", "status": "ready"},
    "auditDecision": {"decision": "recorded", "status": "ready"},
}, payload
assert payload["tenantId"] == "caller-tenant", payload
assert payload["userId"] == "caller-user", payload
byo = app.dogfood_orchestration_body(
    "POST",
    "/resource-sessions/session-1/commands",
    json.dumps({
        "provider": "openai",
        "providerAccess": {"source": "byo", "credential": "sk-raw", "secretRef": "secret-1"},
    }).encode("utf-8"),
)
byo_payload = json.loads(byo.decode("utf-8"))
assert byo_payload["providerAccess"] == {"source": "byo", "secretRef": "secret-1"}, byo_payload
assert "sk-raw" not in json.dumps(byo_payload), byo_payload
`;
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

test("dogfood Google token provider reports account selection as validation", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
from ai_assist_google_docs_adapter.errors import GoogleDocsAdapterError
class OAuthTokens:
    def get_google_status(self, identity):
        return {"accounts": [
            {"googleAccountId": "acct-1", "isAvailable": True},
            {"googleAccountId": "acct-2", "isAvailable": True},
        ]}
class AuthApp:
    oauth_token_service = OAuthTokens()
provider = app.AuthGoogleTokenProvider(AuthApp())
try:
    provider.get_access_token({"tenantId": "tenant-1", "userId": "user-1", "operation": "listResources"})
except GoogleDocsAdapterError as error:
    assert error.code == "VALIDATION_ERROR", error
    assert error.http_status == 400, error
    assert error.details == {"field": "googleAccountId"}, error
else:
    raise AssertionError("expected GoogleDocsAdapterError")
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-google-docs-adapter/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood context consent checks Google OAuth with read context handoff operation", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app
calls = []
class Provider:
    def __init__(self, _auth_app):
        pass
    def get_access_token(self, request):
        calls.append(dict(request))
        return {"status": "active", "accessToken": "token"}
app.dogfood_auth_app = lambda: object()
app.AuthGoogleTokenProvider = Provider
app.dogfood_require_google_oauth({
    "tenantId": "tenant-1",
    "userId": "user-1",
    "authSubject": "subject-1",
    "resourceRef": {"provider": "google_docs", "resourceId": "doc-1"},
})
assert calls[0]["operation"] == "readContext", calls
assert calls[0]["requiredScopes"] == ["https://www.googleapis.com/auth/documents.readonly"], calls
`;
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

test("dogfood runtime loads context consent grants from DynamoDB and gates static emergency JSON", () => {
  const script = `
import json
import os
import ai_assist_dogfood_runtime.http_app as app

class Table:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get((Key["tenantId"], Key["userId#provider#contextMode#grantId"]))
        return {"Item": item} if item else {}

    def query(self, **kwargs):
        tenant_id = kwargs["ExpressionAttributeValues"][":tenantId"]
        sort_prefix = kwargs["ExpressionAttributeValues"][":sortKeyPrefix"]
        return {
            "Items": [
                item
                for (item_tenant_id, sort_key), item in self.items.items()
                if item_tenant_id == tenant_id and sort_key.startswith(sort_prefix)
            ]
        }

class DynamoDb:
    def __init__(self, table):
        self.table = table

    def Table(self, _name):
        return self.table

grant = {
    "grantId": "grant-1",
    "tenantId": "tenant-1",
    "userId": "user-1",
    "provider": "google_docs",
    "contextMode": "ACTIVE_RESOURCE",
    "resourceRef": {"provider": "google_docs", "resourceId": "doc-1"},
    "scopes": ["docs.read"],
    "status": "active",
    "grantedAt": "2026-05-29T11:00:00.000Z",
    "expiresAt": "2099-01-01T00:00:00.000Z",
}
request = {
    "tenantId": "tenant-1",
    "userId": "user-1",
    "provider": "google_docs",
    "contextMode": "ACTIVE_RESOURCE",
    "resourceRef": {"provider": "google_docs", "resourceId": "doc-1"},
}
assert app.dogfood_context_consent_grant(request, "grant-1") is None
os.environ[app.DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV] = json.dumps(grant)
assert app.dogfood_context_consent_grant(request, "grant-1") is None
os.environ[app.DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED_ENV] = "true"
assert app.dogfood_context_consent_grant(request, "grant-1")["grantId"] == "grant-1"
assert app.dogfood_context_consent_grant(request, "other-grant") is None
del os.environ[app.DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED_ENV]

table = Table()
table.items[("tenant-1", "user-1#google_docs#ACTIVE_RESOURCE#grant-1")] = {
    **grant,
    "userId#provider#contextMode#grantId": "user-1#google_docs#ACTIVE_RESOURCE#grant-1",
    "ttl": 4070908800,
}
app._CONTEXT_CONSENT_REPOSITORY = None
app.boto3_resource = lambda service_name: DynamoDb(table)
os.environ[app.CONSENT_GRANT_TABLE_NAME_ENV] = "ContextConsentGrants"
assert app.dogfood_context_consent_grant(request, "grant-1")["grantId"] == "grant-1"
wrong_resource = {**request, "resourceRef": {"provider": "google_docs", "resourceId": "doc-2"}}
assert app.dogfood_context_consent_grant(wrong_resource, "grant-1") is None
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-context-service/src")
      ].join(path.delimiter)
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("dogfood orchestration context dependency resolves only after matching consent exists", () => {
  const script = `
import ai_assist_dogfood_runtime.http_app as app

grant = {
    "grantId": "grant-1",
    "tenantId": "tenant-1",
    "userId": "user-1",
    "provider": "google_docs",
    "contextMode": "ACTIVE_RESOURCE",
    "resourceRef": {"provider": "google_docs", "resourceId": "doc-1"},
    "scopes": ["docs.read"],
    "status": "active",
    "grantedAt": "2026-05-29T11:00:00.000Z",
    "expiresAt": "2099-01-01T00:00:00.000Z",
}

def fake_consent(request, _grant_id):
    if request["resourceRef"]["resourceId"] == "doc-1":
        return grant
    return None

def fake_read_context(request):
    return {
        "context": {
            "contextId": "ctx-1",
            "tenantId": request["tenantId"],
            "userId": request["userId"],
            "sessionId": request["sessionId"],
            "provider": "google_docs",
            "resourceRef": request["resourceRef"],
            "contextMode": request["contextMode"],
            "connector": "google_docs",
            "content": "redacted test content",
            "resourceRevision": "rev-1",
            "anchors": {},
            "connectorVerified": True,
        },
        "resourceRevision": "rev-1",
    }

app.dogfood_context_consent_grant = fake_consent
app.dogfood_google_docs_read_context = fake_read_context
dependency = app.DogfoodContextDependency()
resolved = dependency.resolve_context({
    "tenantId": "tenant-1",
    "userId": "user-1",
    "sessionId": "session-1",
    "resourceId": "doc-1",
    "contextMode": "ACTIVE_RESOURCE",
})
assert resolved["authorized"] is True
assert resolved["resourceRef"]["resourceId"] == "doc-1"
assert resolved["resourceRevision"] == "rev-1"
missing = dependency.resolve_context({
    "tenantId": "tenant-1",
    "userId": "user-1",
    "sessionId": "session-1",
    "resourceId": "doc-2",
    "contextMode": "ACTIVE_RESOURCE",
})
assert missing["authorized"] is False
assert missing["reasonCode"] == "CONTEXT_UNAVAILABLE"
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(process.cwd(), "docker/dogfood-runtime"),
        path.join(process.cwd(), "../ai-assist-context-service/src")
      ].join(path.delimiter)
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
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        edgeJwtAuthEnabled: true,
        allowedProductUsers: [
          {
            authSubject: "cognito-subject-a",
            tenantId: "tenant-a",
            userId: "user-a",
            role: "owner",
            status: "active"
          },
          {
            authSubject: "cognito-subject-b",
            tenantId: "tenant-b",
            userId: "user-b",
            role: "member",
            status: "active"
          }
        ],
        trustedUserTenantId: "dev-tenant",
        trustedUserUserId: "dev-user",
        trustedUserAuthSubject: "trusted-user:dev-user",
        webAppBaseUrl: "https://dev.example.test/",
        googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
      }
    },
    "dev"
  );
  assert.equal(config.allowedProductUsers.length, 2);
  assert.equal(config.allowedProductUsers[0].authSubject, "cognito-subject-a");
  assert.equal(config.trustedUserTenantId, "dev-tenant");
  assert.equal(config.trustedUserUserId, "dev-user");
  assert.equal(config.trustedUserAuthSubject, "trusted-user:dev-user");
  assert.equal(config.webAppBaseUrl, "https://dev.example.test");
  assert.equal(getWebAppDomainName(config.webAppBaseUrl), "dev.example.test");
  assert.equal(config.googleOAuthClientId, "dev-google-client-id.apps.googleusercontent.com");
  assert.equal(config.platformProviderOwnerDevEnabled, false);
  assert.equal(config.platformProviderModelOpenai, undefined);
  assert.deepEqual(config.productAuthHostedUiCallbackUrls, [
    "https://dev-extension.chromiumapp.org/",
    "https://dev-extension.extensions.allizom.org/"
  ]);
  assert.deepEqual(config.productAuthHostedUiLogoutUrls, [
    "https://dev-extension.chromiumapp.org/",
    "https://dev-extension.extensions.allizom.org/"
  ]);
  assert.equal(config.edgeJwtAuthEnabled, true);
  assert.equal(
    parseDeploymentConfigContext(
      {
        dev: {
          hostedZoneId: "Z1234567890ABC",
          hostedZoneName: "example.test",
          sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
          edgeJwtAuthEnabled: false,
          allowedProductUsers: [],
          trustedUserTenantId: "dev-tenant",
          trustedUserUserId: "dev-user",
          trustedUserAuthSubject: "trusted-user:dev-user",
          webAppBaseUrl: "https://dev.example.test",
          googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
        }
      },
      "dev"
    ).edgeJwtAuthEnabled,
    false
  );
  assert.equal(
    parseDeploymentConfigContext(
      {
        dev: {
          hostedZoneId: "Z1234567890ABC",
          hostedZoneName: "example.test",
          sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
          edgeJwtAuthEnabled: true,
          allowedProductUsers: [],
          trustedUserTenantId: "dev-tenant",
          trustedUserUserId: "dev-user",
          trustedUserAuthSubject: "trusted-user:dev-user",
          webAppBaseUrl: "https://dev.example.test",
          googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
        }
      },
      "dev"
    ).allowedProductUsers.length,
    0
  );
  const ownerDevProviderConfig = parseDeploymentConfigContext(
    {
      dev: {
        hostedZoneId: "Z1234567890ABC",
        hostedZoneName: "example.test",
        sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        edgeJwtAuthEnabled: true,
        allowedProductUsers: [],
        trustedUserTenantId: "dev-tenant",
        trustedUserUserId: "dev-user",
        trustedUserAuthSubject: "trusted-user:dev-user",
        webAppBaseUrl: "https://dev.example.test",
        googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com",
        platformProviderOwnerDevEnabled: true,
        platformProviderModelOpenai: "gpt-4.1-mini"
      }
    },
    "dev"
  );
  assert.equal(ownerDevProviderConfig.platformProviderOwnerDevEnabled, true);
  assert.equal(ownerDevProviderConfig.platformProviderModelOpenai, "gpt-4.1-mini");
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          dev: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.dev.example.test",
            productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [],
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user",
            trustedUserAuthSubject: "trusted-user:dev-user",
            webAppBaseUrl: "https://dev.example.test",
            googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com",
            platformProviderOwnerDevEnabled: true
          }
        },
        "dev"
      ),
    /platformProviderModelOpenai is required/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          gamma: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.gamma.example.test",
            productAuthHostedUiCallbackUrls: ["https://gamma-extension.chromiumapp.org/"],
            productAuthHostedUiLogoutUrls: ["https://gamma-extension.chromiumapp.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [],
            trustedUserTenantId: "gamma-tenant",
            trustedUserUserId: "gamma-user",
            trustedUserAuthSubject: "trusted-user:gamma-user",
            webAppBaseUrl: "https://gamma.example.test",
            googleOAuthClientId: "gamma-google-client-id.apps.googleusercontent.com",
            platformProviderOwnerDevEnabled: true,
            platformProviderModelOpenai: "gpt-4.1-mini"
          }
        },
        "gamma"
      ),
    /platformProviderOwnerDevEnabled may be true only for dev/
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
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user",
            trustedUserAuthSubject: "trusted-user:dev-user",
            webAppBaseUrl: "https://dev.example.test",
            googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
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
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user",
            trustedUserAuthSubject: "trusted-user:dev-user",
            webAppBaseUrl: "https://dev.example.test",
            googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
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
          dev: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user",
            trustedUserAuthSubject: "trusted-user:dev-user",
            webAppBaseUrl: "https://dev.other.test",
            googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
          }
        },
        "dev"
      ),
    /webAppBaseUrl host must be a subdomain of hostedZoneName/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          dev: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "dev-tenant",
            trustedUserUserId: "dev-user",
            trustedUserAuthSubject: "trusted-user:dev-user",
            webAppBaseUrl: "https://sse.dev.example.test",
            googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
          }
        },
        "dev"
      ),
    /webAppBaseUrl host must be different from sseDomainName/
  );
  for (const invalidWebAppBaseUrl of [
    "https://dev.example.test/app",
    "https://dev.example.test?preview=true",
    "https://dev.example.test#app",
    "https://user:pass@dev.example.test",
    "https://dev.example.test:8443"
  ]) {
    assert.throws(
      () =>
        parseDeploymentConfigContext(
          {
            dev: {
              hostedZoneId: "Z1234567890ABC",
              hostedZoneName: "example.test",
              sseDomainName: "sse.dev.example.test",
        productAuthHostedUiCallbackUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
        productAuthHostedUiLogoutUrls: ["https://dev-extension.chromiumapp.org/", "https://dev-extension.extensions.allizom.org/"],
              edgeJwtAuthEnabled: true,
              allowedProductUsers: [
                {
                  authSubject: "cognito-subject-a",
                  tenantId: "tenant-a",
                  userId: "user-a",
                  role: "owner",
                  status: "active"
                }
              ],
              trustedUserTenantId: "dev-tenant",
              trustedUserUserId: "dev-user",
              trustedUserAuthSubject: "trusted-user:dev-user",
              webAppBaseUrl: invalidWebAppBaseUrl,
              googleOAuthClientId: "dev-google-client-id.apps.googleusercontent.com"
            }
          },
          "dev"
        ),
      /webAppBaseUrl must be an https origin URL without path, query, fragment, credentials, or port/,
      `${invalidWebAppBaseUrl} must be rejected`
    );
  }
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          gamma: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.gamma.example.test",
            productAuthHostedUiCallbackUrls: ["https://gamma-extension.chromiumapp.org/"],
            productAuthHostedUiLogoutUrls: ["https://gamma-extension.chromiumapp.org/"],
            edgeJwtAuthEnabled: false,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "gamma-tenant",
            trustedUserUserId: "gamma-user",
            trustedUserAuthSubject: "trusted-user:gamma-user",
            webAppBaseUrl: "https://gamma.example.test",
            googleOAuthClientId: "gamma-google-client-id.apps.googleusercontent.com"
          }
        },
        "gamma"
      ),
    /edgeJwtAuthEnabled may be false only for dev/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          gamma: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.gamma.example.test",
            productAuthHostedUiCallbackUrls: ["https://replace-with-extension-id.chromiumapp.org/"],
            productAuthHostedUiLogoutUrls: ["https://gamma-extension.chromiumapp.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "gamma-tenant",
            trustedUserUserId: "gamma-user",
            trustedUserAuthSubject: "trusted-user:gamma-user",
            webAppBaseUrl: "https://gamma.example.test",
            googleOAuthClientId: "gamma-google-client-id.apps.googleusercontent.com"
          }
        },
        "gamma"
      ),
    /must not include localhost, placeholder, or temporary dev extension redirect URLs/
  );
  assert.throws(
    () =>
      parseDeploymentConfigContext(
        {
          prod: {
            hostedZoneId: "Z1234567890ABC",
            hostedZoneName: "example.test",
            sseDomainName: "sse.example.test",
            productAuthHostedUiCallbackUrls: ["https://prod-release.chromiumapp.org/"],
            productAuthHostedUiLogoutUrls: ["https://prod-extension-id.chromiumapp.org/"],
            edgeJwtAuthEnabled: true,
            allowedProductUsers: [
              {
                authSubject: "cognito-subject-a",
                tenantId: "tenant-a",
                userId: "user-a",
                role: "owner",
                status: "active"
              }
            ],
            trustedUserTenantId: "prod-tenant",
            trustedUserUserId: "prod-user",
            trustedUserAuthSubject: "trusted-user:prod-user",
            webAppBaseUrl: "https://app.example.test",
            googleOAuthClientId: "prod-google-client-id.apps.googleusercontent.com"
          }
        },
        "prod"
      ),
    /must not include localhost, placeholder, or temporary dev extension redirect URLs/
  );
  for (const fieldName of ["productAuthHostedUiCallbackUrls", "productAuthHostedUiLogoutUrls"] as const) {
    assert.throws(
      () =>
        parseDeploymentConfigContext(
          {
            gamma: {
              hostedZoneId: "Z1234567890ABC",
              hostedZoneName: "example.test",
              sseDomainName: "sse.gamma.example.test",
              productAuthHostedUiCallbackUrls: fieldName === "productAuthHostedUiCallbackUrls" ? ["https://[::1]/"] : ["https://gamma-release.chromiumapp.org/"],
              productAuthHostedUiLogoutUrls: fieldName === "productAuthHostedUiLogoutUrls" ? ["https://[::1]/"] : ["https://gamma-release.chromiumapp.org/"],
              edgeJwtAuthEnabled: true,
              allowedProductUsers: [
                {
                  authSubject: "cognito-subject-a",
                  tenantId: "tenant-a",
                  userId: "user-a",
                  role: "owner",
                  status: "active"
                }
              ],
              trustedUserTenantId: "gamma-tenant",
              trustedUserUserId: "gamma-user",
              trustedUserAuthSubject: "trusted-user:gamma-user",
              webAppBaseUrl: "https://gamma.example.test",
              googleOAuthClientId: "gamma-google-client-id.apps.googleusercontent.com"
            }
          },
          "gamma"
        ),
      /must not include localhost, placeholder, or temporary dev extension redirect URLs/,
      `${fieldName} must reject IPv6 loopback for gamma`
    );
  }
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
    "POST /resource-sessions/{sessionId}/context-consent",
    "POST /resource-sessions/{sessionId}/actions",
    "GET /resource-sessions/{sessionId}/actions",
    "GET /resource-sessions/{sessionId}/actions/{actionId}",
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
  const requirementsByName = new Map(REQUIRED_RUNTIME_CONFIG.map((entry) => [entry.name, entry]));
  const requiredAuthRuntimeKeys = [
    "PRODUCT_AUTH_HMAC_SECRET",
    "OAUTH_STATE_SIGNING_SECRET",
    "TRUSTED_USER_TENANT_ID",
    "TRUSTED_USER_USER_ID",
    "TRUSTED_USER_AUTH_SUBJECT",
    "AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON",
    "TRUSTED_USER_BOOTSTRAP_SECRET"
  ];
  for (const key of requiredAuthRuntimeKeys) {
    assert.ok(requirementsByName.has(key), `${key} must be part of the runtime readiness inventory`);
  }
  for (const key of ["PRODUCT_AUTH_HMAC_SECRET", "OAUTH_STATE_SIGNING_SECRET", "TRUSTED_USER_BOOTSTRAP_SECRET"]) {
    assert.equal(requirementsByName.get(key)?.secret, true, `${key} must be marked secret`);
  }
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
  validConfig.AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON = JSON.stringify([
    {
      authSubject: "cognito-subject-a",
      tenantId: "tenant-a",
      userId: "user-a",
      role: "owner",
      status: "active"
    }
  ]);
  validConfig.PLATFORM_PROVIDER_QUOTA_MODE = "enforced";
  validConfig.PLATFORM_PROVIDER_AUDIT_MODE = "metadata";
  assert.equal(validateRuntimeConfig(validConfig).valid, true);

  const missingAuthRuntimeKey = validateRuntimeConfig({
    ...validConfig,
    OAUTH_STATE_SIGNING_SECRET: undefined
  });
  assert.equal(missingAuthRuntimeKey.valid, false);
  assert.equal(missingAuthRuntimeKey.setupStatus, "blocked");
  assert.deepEqual(missingAuthRuntimeKey.missing, ["OAUTH_STATE_SIGNING_SECRET"]);

  const invalid = validateRuntimeConfig({
    ...validConfig,
    GOOGLE_OAUTH_CLIENT_SECRET_REF: "super-secret-value",
    API_BASE_URL: "http://localhost:8080",
    GOOGLE_OAUTH_CALLBACK_URL: "https://api.example.test/auth/google/callback",
    ALLOWED_ORIGINS: "https://example.test,http://bad.example.test",
    SSE_HEARTBEAT_SECONDS: "soon",
    TRUSTED_USER_MODE: "false",
    PLATFORM_PROVIDER_QUOTA_MODE: "optional",
    PLATFORM_PROVIDER_AUDIT_MODE: "verbose"
  });

  assert.equal(invalid.valid, false);
  assert.equal(invalid.setupStatus, "blocked");
  assert.ok(invalid.safeMessages.some((message) => message.includes("API_BASE_URL must use https")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("GOOGLE_OAUTH_CALLBACK_URL must use /oauth/google/callback")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("ALLOWED_ORIGINS origin http://bad.example.test must use https")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("TRUSTED_USER_MODE must be true")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("PLATFORM_PROVIDER_QUOTA_MODE must be enforced")));
  assert.ok(invalid.safeMessages.some((message) => message.includes("PLATFORM_PROVIDER_AUDIT_MODE must be metadata")));
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
