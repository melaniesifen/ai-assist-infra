from __future__ import annotations

import importlib
import json
import os
import re
import base64
import socket
import urllib.error
import urllib.request
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable


Handler = Callable[..., dict[str, Any]]
_AUTH_APP: Any | None = None
_GOOGLE_DOCS_APP: Any | None = None
_CONTEXT_APP: Any | None = None
_ACTION_SERVICE: Any | None = None
_CONTEXT_CONSENT_REPOSITORY: Any | None = None
_ORCHESTRATION_CONFIGURED = False
TRUSTED_IDENTITY_HEADERS = {
    "x-ai-assist-tenant-id",
    "x-ai-assist-user-id",
    "x-ai-assist-auth-subject",
}
DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV = "AI_ASSIST_DOGFOOD_CONTEXT_CONSENT_GRANT_JSON"
DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED_ENV = "AI_ASSIST_DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED"
CONSENT_GRANT_TABLE_NAME_ENV = "CONSENT_GRANT_TABLE_NAME"
TRUSTED_UPSTREAM_SSE_HEADERS_ENV = "AI_ASSIST_TRUSTED_UPSTREAM_SSE_HEADERS"
PLATFORM_PROVIDER_DEFAULT_ENV = "PLATFORM_PROVIDER_DEFAULT"
PLATFORM_PROVIDER_AUDIT_MODE_ENV = "PLATFORM_PROVIDER_AUDIT_MODE"
PLATFORM_PROVIDER_QUOTA_MODE_ENV = "PLATFORM_PROVIDER_QUOTA_MODE"
PLATFORM_PROVIDER_OWNER_DEV_ENABLED_ENV = "PLATFORM_PROVIDER_OWNER_DEV_ENABLED"
PLATFORM_PROVIDER_MODEL_PREFIX = "PLATFORM_PROVIDER_MODEL_"
PLATFORM_PROVIDER_SECRET_REF_PREFIX = "PLATFORM_PROVIDER_SECRET_REF_"
SUPPORTED_PLATFORM_PROVIDERS = ("openai", "anthropic")
COMMAND_ROUTE_RE = re.compile(r"^/resource-sessions/[^/]+/commands$")
ACTION_DEPENDENCY_ENV_KEYS = ("PROPOSED_ACTION_TABLE_NAME", "APP_KMS_KEY_ID")
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_PROVIDER_TIMEOUT_SECONDS = 30
SAFE_LOG_DETAIL_KEYS = {
    "category",
    "dependency",
    "dependencyStatus",
    "field",
    "operation",
    "provider",
    "reason",
    "reconnectRequired",
    "refreshRequired",
    "status",
    "target",
}
UNSAFE_LOG_PATTERNS = (
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"ya29\.[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9._-]+", re.IGNORECASE),
    re.compile(r"documents/[^/?\s]+", re.IGNORECASE),
)


@dataclass(frozen=True)
class RouteDispatch:
    method: str
    pattern: re.Pattern[str]
    owning_service: str
    package: str
    supports_sse: bool = False


def route(method: str, pattern: str, owning_service: str, package: str, *, supports_sse: bool = False) -> RouteDispatch:
    return RouteDispatch(method=method, pattern=re.compile(pattern), owning_service=owning_service, package=package, supports_sse=supports_sse)


ROUTES: tuple[RouteDispatch, ...] = (
    route("POST", r"^/auth/login$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("POST", r"^/auth/logout$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("GET", r"^/auth/session$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("POST", r"^/oauth/google/start$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("GET", r"^/oauth/google/callback$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("GET", r"^/oauth/google/status$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("DELETE", r"^/oauth/google/connection$", "ai-assist-auth-service", "ai_assist_auth_service"),
    route("GET", r"^/setup/status$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("POST", r"^/provider-secrets/session$", "ai-assist-secrets-service", "ai_assist_secrets_service"),
    route("GET", r"^/provider-secrets/session/[^/]+/status$", "ai-assist-secrets-service", "ai_assist_secrets_service"),
    route("DELETE", r"^/provider-secrets/session/[^/]+$", "ai-assist-secrets-service", "ai_assist_secrets_service"),
    route("GET", r"^/providers$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("GET", r"^/resources$", "ai-assist-google-docs-adapter", "ai_assist_google_docs_adapter"),
    route("POST", r"^/resource-sessions$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("GET", r"^/resource-sessions/[^/]+$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("POST", r"^/resource-sessions/[^/]+/commands$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("GET", r"^/sessions/[^/]+/events$", "ai-assist-session-events-service", "ai_assist_session_events", supports_sse=True),
    route("GET", r"^/context-modes$", "ai-assist-context-service", "ai_assist_context_service"),
    route("PUT", r"^/resource-sessions/[^/]+/context-mode$", "ai-assist-context-service", "ai_assist_context_service"),
    route("POST", r"^/resource-sessions/[^/]+/context-preview$", "ai-assist-context-service", "ai_assist_context_service"),
    route("POST", r"^/resource-sessions/[^/]+/context-consent$", "ai-assist-context-service", "ai_assist_context_service"),
    route("POST", r"^/resource-sessions/[^/]+/actions$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("GET", r"^/resource-sessions/[^/]+/actions$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("GET", r"^/resource-sessions/[^/]+/actions/[^/]+$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("POST", r"^/resource-sessions/[^/]+/actions/[^/]+/approve$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("POST", r"^/resource-sessions/[^/]+/actions/[^/]+/reject$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
    route("POST", r"^/resource-sessions/[^/]+/apply-action$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
)


def handle_http_request(
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    query_string: str = "",
    body: bytes | None = None,
) -> dict[str, Any]:
    dispatch = find_route(method, path)
    if dispatch is None:
        return json_response(404, "DOGFOOD_ROUTE_NOT_FOUND", "No dogfood runtime route matches this request.", "unknown-service", path)

    package_handler = dogfood_package_handler(dispatch)
    if package_handler is None:
        return json_response(
            501,
            "DOGFOOD_ROUTE_HANDLER_NOT_IMPLEMENTED",
            "The shared dogfood runtime includes this service package, but the package does not expose http_app.handle_http_request yet.",
            dispatch.owning_service,
            path,
        )
    return normalize_package_response(
        package_handler(method=method, path=path, headers=headers, query_string=query_string, body=body)
    )


def find_route(method: str, path: str) -> RouteDispatch | None:
    normalized_method = method.upper()
    for dispatch in ROUTES:
        if dispatch.method == normalized_method and dispatch.pattern.match(path):
            return dispatch
    return None


def load_package_handler(package: str) -> Handler | None:
    try:
        module = importlib.import_module(f"{package}.http_app")
    except Exception:
        return None
    handler = getattr(module, "handle_http_request", None)
    return handler if callable(handler) else None


def dogfood_package_handler(dispatch: RouteDispatch) -> Handler | None:
    if dispatch.package == "ai_assist_orchestration":
        return orchestration_handler
    if dispatch.package == "ai_assist_session_events":
        return session_events_handler
    if dispatch.package == "ai_assist_google_docs_adapter":
        return google_docs_handler
    if dispatch.package == "ai_assist_context_service":
        return context_handler
    return load_package_handler(dispatch.package)


def google_docs_handler(
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    query_string: str = "",
    body: bytes | None = None,
) -> dict[str, Any]:
    del body
    try:
        app = dogfood_google_docs_app()
        return app.handle(
            method=method.upper(),
            path=path,
            headers=authenticated_downstream_headers(headers or {}),
            query=parse_query(query_string),
        )
    except Exception as error:
        return exception_response(error, "ai-assist-google-docs-adapter", path)


def context_handler(
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    query_string: str = "",
    body: bytes | None = None,
) -> dict[str, Any]:
    try:
        app = dogfood_context_app()
        return app.handle(
            method=method.upper(),
            path=path,
            headers=authenticated_downstream_headers(headers or {}),
            query=parse_query(query_string),
            body=body,
        )
    except Exception as error:
        return exception_response(error, "ai-assist-context-service", path)


def orchestration_handler(
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    query_string: str = "",
    body: bytes | None = None,
) -> dict[str, Any]:
    del query_string
    request_headers = headers or {}
    try:
        package_handler = load_package_handler("ai_assist_orchestration")
        if package_handler is None:
            return json_response(
                501,
                "DOGFOOD_ROUTE_HANDLER_NOT_IMPLEMENTED",
                "The shared dogfood runtime includes orchestration, but the package does not expose http_app.handle_http_request yet.",
                "ai-assist-orchestration-service",
                path,
            )
        configure_dogfood_orchestration_runtime()
        return normalize_package_response(
            package_handler(
                method=method.upper(),
                path=path,
                headers=authenticated_downstream_headers(request_headers),
                body=dogfood_orchestration_body(method.upper(), path, body),
            )
        )
    except Exception as error:
        return exception_response(error, "ai-assist-orchestration-service", path)


def session_events_handler(
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    query_string: str = "",
    body: bytes | None = None,
) -> dict[str, Any]:
    try:
        package_handler = load_package_handler("ai_assist_session_events")
        if package_handler is None:
            return json_response(
                501,
                "DOGFOOD_ROUTE_HANDLER_NOT_IMPLEMENTED",
                "The session-events package does not expose http_app.handle_http_request yet.",
                "ai-assist-session-events-service",
                path,
            )
        return normalize_package_response(
            package_handler(
                method=method,
                path=path,
                headers=session_events_auth_headers(headers or {}),
                query_string=query_string,
                body=body,
            )
        )
    except Exception as error:
        return exception_response(error, "ai-assist-session-events-service", path)


def dogfood_auth_app() -> Any:
    global _AUTH_APP
    if _AUTH_APP is None:
        module = importlib.import_module("ai_assist_auth_service.http_app")
        _AUTH_APP = module.create_app_from_env()
    return _AUTH_APP


def dogfood_google_docs_app() -> Any:
    global _GOOGLE_DOCS_APP
    if _GOOGLE_DOCS_APP is None:
        adapter_module = importlib.import_module("ai_assist_google_docs_adapter.adapter")
        client_module = importlib.import_module("ai_assist_google_docs_adapter.google_http_client")
        http_module = importlib.import_module("ai_assist_google_docs_adapter.http_app")
        _GOOGLE_DOCS_APP = http_module.GoogleDocsHttpApplication(
            adapter=adapter_module.GoogleDocsAdapter(
                google_client=client_module.GoogleDriveDocsHttpClient(),
                token_provider=AuthGoogleTokenProvider(dogfood_auth_app()),
            )
        )
    return _GOOGLE_DOCS_APP


def dogfood_context_app() -> Any:
    global _CONTEXT_APP
    if _CONTEXT_APP is None:
        http_module = importlib.import_module("ai_assist_context_service.http_app")
        _CONTEXT_APP = http_module.ContextHttpApplication(
            connector_read_context=dogfood_google_docs_read_context,
            load_consent_grant=dogfood_context_consent_grant,
            consent_grant_repository=dogfood_context_consent_repository(),
            require_google_oauth=dogfood_require_google_oauth,
        )
    return _CONTEXT_APP


def configure_dogfood_orchestration_runtime() -> None:
    global _ORCHESTRATION_CONFIGURED
    if _ORCHESTRATION_CONFIGURED:
        return
    orchestration_module = importlib.import_module("ai_assist_orchestration")
    configure_runtime = getattr(orchestration_module, "configure_http_runtime", None)
    if not callable(configure_runtime):
        _ORCHESTRATION_CONFIGURED = True
        return

    action_service = dogfood_action_service(orchestration_module)
    command_service = orchestration_module.create_command_service(
        context_service=DogfoodContextDependency(),
        provider_registry=DogfoodProviderRegistry(),
        event_publisher=dogfood_session_event_publisher(),
        policy_service=AllowTrustedUserPolicy(),
        prompt_builder=MetadataOnlyPromptBuilder(),
        action_service=action_service,
    )
    missing_actions = DogfoodMissingActionDependency()
    runtime = orchestration_module.OrchestrationHttpRuntime(
        boundary=orchestration_module.create_http_command_boundary(
            command_service=command_service,
            action_service=action_service or missing_actions,
        ),
        provider_status_service=DogfoodProviderStatusService(),
        resolve_auth=dogfood_orchestration_auth,
    )
    configure_runtime(runtime)
    _ORCHESTRATION_CONFIGURED = True


class DogfoodContextDependency:
    def resolve_context(self, request: dict[str, Any]) -> dict[str, Any]:
        context_mode = request.get("contextMode") or "ACTIVE_RESOURCE"
        resource_id = request.get("resourceId")
        if not isinstance(resource_id, str) or not resource_id.strip():
            return {
                "authorized": False,
                "reasonCode": "RESOURCE_ID_REQUIRED",
            }
        context_request = {
            "tenantId": request.get("tenantId"),
            "userId": request.get("userId"),
            "sessionId": request.get("sessionId"),
            "provider": "google_docs",
            "contextMode": context_mode,
            "resourceRef": {
                "provider": "google_docs",
                "resourceId": resource_id.strip(),
            },
            "requestId": request.get("requestId"),
            "explicitUserAction": True,
        }
        grant = dogfood_context_consent_grant(context_request, None)
        if grant is not None:
            context_request["consentGrant"] = grant
        try:
            result = importlib.import_module("ai_assist_context_service.read_path").read_context_with_consent(
                context_request,
                dogfood_google_docs_read_context,
            )
        except Exception as error:
            log_context_dependency_exception(error, context_request, grant)
            return {"authorized": False, "reasonCode": "CONTEXT_UNAVAILABLE"}
        context = result.get("context") if isinstance(result, dict) else None
        if not isinstance(context, dict):
            return {"authorized": False, "reasonCode": "CONTEXT_UNAVAILABLE"}
        return {
            **context,
            "authorized": True,
            "resourceRevision": result.get("resourceRevision") or context.get("resourceRevision"),
        }


class DogfoodProviderRegistry:
    def get(self, provider_name: str) -> Any | None:
        provider = normalize_provider_name(provider_name)
        if provider is None or provider not in SUPPORTED_PLATFORM_PROVIDERS:
            return None
        if provider_secret_ref(provider) is None:
            return None
        return DogfoodProviderDependency(provider)


class DogfoodProviderDependency:
    def __init__(self, provider: str) -> None:
        self.provider = provider

    async def stream(self, request: dict[str, Any]) -> Any:
        if not owner_dev_provider_enabled():
            yield provider_error_event(
                provider=self.provider,
                code="DOGFOOD_OWNER_DEV_PROVIDER_DISABLED",
                category="unavailable",
                message="Owner/dev platform provider calls are disabled.",
                dependency_status="disabled",
            )
            return
        if not owner_dev_provider_allowed(request):
            yield provider_error_event(
                provider=self.provider,
                code="DOGFOOD_OWNER_DEV_PROVIDER_OWNER_ONLY",
                category="authorization",
                message="Owner/dev platform provider calls are owner-only.",
                dependency_status="owner_required",
            )
            return
        access = request.get("providerAccess") if isinstance(request.get("providerAccess"), dict) else {}
        reference = access.get("reference")
        if not isinstance(reference, str) or not reference.strip():
            yield provider_error_event(
                provider=self.provider,
                code="PLATFORM_PROVIDER_SECRET_NOT_CONFIGURED",
                category="unavailable",
                message="Platform provider access is not configured.",
                dependency_status="not_configured",
            )
            return
        model = provider_model(self.provider)
        if model is None:
            yield provider_error_event(
                provider=self.provider,
                code="PLATFORM_PROVIDER_MODEL_NOT_CONFIGURED",
                category="unavailable",
                message="Platform provider model is not configured.",
                dependency_status="model_not_configured",
            )
            return
        if self.provider != "openai":
            yield provider_error_event(
                provider=self.provider,
                code="DOGFOOD_PROVIDER_CLIENT_UNAVAILABLE",
                category="unavailable",
                message="Dogfood runtime provider client is not configured for this provider.",
                dependency_status="provider_client_not_configured",
            )
            return
        messages = provider_messages(request)
        if not messages:
            yield provider_error_event(
                provider=self.provider,
                code="DOGFOOD_PROVIDER_MESSAGES_MISSING",
                category="invalid_request",
                message="Provider request messages are not available.",
                dependency_status="malformed",
            )
            return
        try:
            credential = platform_provider_credential(reference)
            result = openai_chat_client(credential).complete(
                {
                    "model": model,
                    "messages": messages,
                    "temperature": 0.2,
                    "maxOutputTokens": 700,
                    "requestId": request.get("requestId"),
                    "correlationId": request.get("correlationId"),
                }
            )
        except ProviderClientError as error:
            yield provider_error_event(
                provider=self.provider,
                code=error.code,
                category=error.category,
                message=error.safe_message,
                dependency_status=error.dependency_status,
                retry_after_seconds=error.retry_after_seconds,
            )
            return
        assistant_text = result.get("content")
        if isinstance(assistant_text, str) and assistant_text:
            yield {
                "type": "assistant.delta",
                "provider": self.provider,
                "model": result.get("model") or model,
                "delta": assistant_text,
            }
        yield {
            "type": "assistant.final",
            "provider": self.provider,
            "model": result.get("model") or model,
            "finishReason": result.get("finishReason") or "stop",
            "usage": result.get("usage"),
        }


class DogfoodProviderStatusService:
    def list_provider_status(self, _identity: dict[str, Any], _request: dict[str, Any]) -> dict[str, Any]:
        return platform_provider_status_payload()


class AllowTrustedUserPolicy:
    def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "decision": "ALLOW",
            "decisionId": request.get("requestId"),
            "reasonCode": "TRUSTED_USER_DOGFOOD",
        }


class DogfoodReadOnlySummarizePromptBuilder:
    def build_prompt(self, request: dict[str, Any]) -> dict[str, Any]:
        command = request.get("command") if isinstance(request.get("command"), dict) else {}
        context = request.get("context") if isinstance(request.get("context"), dict) else {}
        content = context.get("content")
        return {
            "messages": [
                {
                    "role": "system",
                    "content": "You are AI Assist in a Google Docs sidebar. Summarize the validated document context read-only. Do not propose document mutations.",
                },
                {"role": "user", "content": f"Summarize this Google Docs context:\n\n{content}"},
            ],
            "metadata": {
                "sessionId": command.get("sessionId"),
                "contextMode": command.get("contextMode"),
                "resourceProvider": context.get("provider") or "google_docs",
            },
        }


MetadataOnlyPromptBuilder = DogfoodReadOnlySummarizePromptBuilder


def dogfood_session_event_publisher() -> Any:
    try:
        session_events_http_app = importlib.import_module("ai_assist_session_events.http_app")
        publish_session_event = getattr(session_events_http_app, "publish_session_event", None)
        if callable(publish_session_event):
            return SessionEventsHttpAppPublisher(publish_session_event)
    except Exception:
        pass
    return NoopSessionEventPublisher()


class SessionEventsHttpAppPublisher:
    def __init__(self, publish_session_event: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self._publish_session_event = publish_session_event

    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        return self._publish_session_event(event)


class NoopSessionEventPublisher:
    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        return event


class DogfoodMissingActionDependency:
    async def create_proposed_action(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("create_action", input_data)

    async def list_actions(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("list_actions", input_data)

    async def get_action(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("get_action", input_data)

    async def approve_action(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("approve_action", input_data)

    async def reject_action(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("reject_action", input_data)

    async def apply_action(self, _identity: dict, input_data: dict) -> dict:
        raise dogfood_orchestration_dependency_missing("apply_action", input_data)


def dogfood_orchestration_dependency_missing(operation: str, payload: dict[str, Any]) -> Exception:
    return importlib.import_module("ai_assist_orchestration.http_app").deployed_dependencies_missing(operation, payload)


def dogfood_action_service(orchestration_module: Any | None = None) -> Any | None:
    global _ACTION_SERVICE
    if _ACTION_SERVICE is not None:
        return _ACTION_SERVICE
    missing = [key for key in ACTION_DEPENDENCY_ENV_KEYS if not os.environ.get(key)]
    if missing:
        return None
    orchestration_module = orchestration_module or importlib.import_module("ai_assist_orchestration")
    _ACTION_SERVICE = orchestration_module.create_action_service(
        action_store=DynamoDbActionStore(table_name=os.environ["PROPOSED_ACTION_TABLE_NAME"]),
        connector=dogfood_google_docs_action_connector(),
        event_publisher=dogfood_session_event_publisher(),
        consent_service=DogfoodApplyConsent(),
        payload_vault=KmsPayloadVault(key_id=os.environ["APP_KMS_KEY_ID"]),
        token_service=DogfoodApplyTokenService(AuthGoogleTokenProvider(dogfood_auth_app())),
    )
    return _ACTION_SERVICE


def dogfood_google_docs_action_connector() -> Any:
    connector_module = importlib.import_module("ai_assist_google_docs_adapter.orchestration_connector")
    return connector_module.GoogleDocsOrchestrationConnector(dogfood_google_docs_app().adapter)


class DogfoodApplyConsent:
    def validate_apply_consent(self, request: dict[str, Any]) -> dict[str, Any]:
        validation_request = {
            "tenantId": request.get("tenantId"),
            "userId": request.get("userId"),
            "sessionId": request.get("sessionId"),
            "provider": "google_docs",
            "contextMode": "ACTIVE_RESOURCE",
            "resourceRef": {
                "provider": "google_docs",
                "resourceId": request.get("resourceId"),
            },
        }
        grant = dogfood_context_consent_grant(validation_request, request.get("consentGrantId"))
        if not grant:
            return {"allowed": False, "reasonCode": "CONSENT_REQUIRED"}
        validation_request["consentGrant"] = grant
        try:
            importlib.import_module("ai_assist_context_service").validate_active_consent_for_apply_target(validation_request)
        except Exception:
            return {"allowed": False, "reasonCode": "CONSENT_DENIED"}
        return {"allowed": True}


class DogfoodApplyTokenService:
    def __init__(self, token_provider: Any) -> None:
        self.token_provider = token_provider

    def validate_apply_token(self, request: dict[str, Any]) -> dict[str, Any]:
        token_status = self.token_provider.get_access_token(
            {
                **request,
                "operation": "applyAction",
                "requiredScopes": ["https://www.googleapis.com/auth/documents"],
            }
        )
        if token_status.get("accessToken") or token_status.get("status") == "available":
            return {"valid": True}
        return {"valid": False, "reasonCode": "RECONNECT_REQUIRED"}


class KmsPayloadVault:
    def __init__(self, *, key_id: str) -> None:
        self.key_id = key_id
        self.client = boto3_client("kms")

    def encrypt(self, payload: dict | None) -> dict[str, str]:
        plaintext = json.dumps(payload or {}, separators=(",", ":"), sort_keys=True).encode("utf-8")
        response = self.client.encrypt(
            KeyId=self.key_id,
            Plaintext=plaintext,
            EncryptionContext={"purpose": "proposed-action-payload"},
        )
        return {"kmsCiphertext": base64.b64encode(response["CiphertextBlob"]).decode("ascii")}

    def decrypt(self, encrypted_payload: dict) -> dict:
        ciphertext = encrypted_payload.get("kmsCiphertext")
        if not isinstance(ciphertext, str) or not ciphertext:
            raise ValueError("encrypted payload ciphertext is required")
        response = self.client.decrypt(
            CiphertextBlob=base64.b64decode(ciphertext),
            EncryptionContext={"purpose": "proposed-action-payload"},
        )
        payload = json.loads(response["Plaintext"].decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("encrypted payload must decode to a JSON object")
        return payload


class DynamoDbActionStore:
    def __init__(self, *, table_name: str) -> None:
        self.table = boto3_resource("dynamodb").Table(table_name)

    def create(self, action: dict) -> dict:
        item = _action_to_item(action)
        self.table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(tenantId) AND attribute_not_exists(actionId)",
        )
        return deepcopy(action)

    def get(self, action_id: str) -> dict | None:
        for item in self._scan_actions():
            if item.get("actionId") == action_id:
                return _item_to_action(item)
        return None

    def list_for_session(self, *, tenant_id: str, user_id: str, session_id: str) -> list[dict]:
        actions = [
            _item_to_action(item)
            for item in self._scan_actions()
            if item.get("tenantId") == tenant_id
            and item.get("userId") == user_id
            and item.get("sessionId") == session_id
        ]
        return sorted(actions, key=lambda action: (action.get("createdAt", ""), action.get("actionId", "")))

    def update(self, action_id: str, updater: Callable[[dict], dict]) -> dict | None:
        current = self.get(action_id)
        if current is None:
            return None
        updated = updater(deepcopy(current))
        self.table.put_item(Item=_action_to_item(updated))
        return deepcopy(updated)

    def transition(
        self,
        action_id: str,
        *,
        allowed_statuses: set[str],
        patch: dict,
        reject_if_apply_locked: bool = False,
    ) -> dict:
        current = self.get(action_id)
        if current is None:
            return {"kind": "NOT_FOUND"}
        if reject_if_apply_locked and current.get("applyLock"):
            return {"kind": "APPLY_IN_PROGRESS", "action": current}
        if current.get("status") not in allowed_statuses:
            return {"kind": "STATUS_MISMATCH", "action": current}
        updated = {**current, **patch}
        condition = "attribute_exists(actionId) AND #status IN ({statuses})".format(
            statuses=", ".join(f":status{index}" for index, _status in enumerate(allowed_statuses))
        )
        expression_names = {"#status": "status"}
        expression_values = {f":status{index}": status for index, status in enumerate(allowed_statuses)}
        if reject_if_apply_locked:
            condition = f"{condition} AND attribute_not_exists(applyLock)"
        if not self._conditional_put(_action_to_item(updated), condition, expression_names, expression_values):
            latest = self.get(action_id)
            if latest is None:
                return {"kind": "NOT_FOUND"}
            if reject_if_apply_locked and latest.get("applyLock"):
                return {"kind": "APPLY_IN_PROGRESS", "action": latest}
            return {"kind": "STATUS_MISMATCH", "action": latest}
        return {"kind": "UPDATED", "action": deepcopy(updated)}

    def reserve_apply(self, action_id: str, idempotency_key: str, started_at: str) -> dict:
        current = self.get(action_id)
        if current is None:
            return {"kind": "NOT_FOUND"}
        if current.get("applyResult") and current.get("idempotencyKey") == idempotency_key:
            return {"kind": "REPLAY", "applyResult": current["applyResult"]}
        if current.get("applyLock"):
            return {
                "kind": "IN_PROGRESS" if current["applyLock"]["idempotencyKey"] == idempotency_key else "IN_PROGRESS_DIFFERENT_KEY",
                "action": current,
            }
        if current.get("status") != "APPROVED":
            return {"kind": "NOT_APPROVED", "action": current}
        reserved = {
            **current,
            "idempotencyKey": idempotency_key,
            "applyLock": {"idempotencyKey": idempotency_key, "startedAt": started_at},
            "updatedAt": started_at,
        }
        if not self._conditional_put(
            _action_to_item(reserved),
            "attribute_exists(actionId) AND #status = :approved AND attribute_not_exists(applyLock)",
            {"#status": "status"},
            {":approved": "APPROVED"},
        ):
            latest = self.get(action_id)
            if latest is None:
                return {"kind": "NOT_FOUND"}
            if latest.get("applyResult") and latest.get("idempotencyKey") == idempotency_key:
                return {"kind": "REPLAY", "applyResult": latest["applyResult"]}
            if latest.get("applyLock"):
                return {
                    "kind": "IN_PROGRESS" if latest["applyLock"]["idempotencyKey"] == idempotency_key else "IN_PROGRESS_DIFFERENT_KEY",
                    "action": latest,
                }
            if latest.get("status") != "APPROVED":
                return {"kind": "NOT_APPROVED", "action": latest}
            return {"kind": "IN_PROGRESS_DIFFERENT_KEY", "action": latest}
        return {"kind": "RESERVED", "action": deepcopy(reserved)}

    def complete_apply(self, action_id: str, idempotency_key: str, patch: dict) -> dict | None:
        current = self.get(action_id)
        if current is None:
            return None
        if current.get("applyLock", {}).get("idempotencyKey") != idempotency_key:
            return current
        updated = {**current, **patch}
        updated.pop("applyLock", None)
        if not self._conditional_put(
            _action_to_item(updated),
            "attribute_exists(actionId) AND #applyLock.#idempotencyKey = :idempotencyKey",
            {"#applyLock": "applyLock", "#idempotencyKey": "idempotencyKey"},
            {":idempotencyKey": idempotency_key},
        ):
            return self.get(action_id)
        return deepcopy(updated)

    def _conditional_put(
        self,
        item: dict,
        condition_expression: str,
        expression_attribute_names: dict[str, str],
        expression_attribute_values: dict[str, Any],
    ) -> bool:
        try:
            self.table.put_item(
                Item=item,
                ConditionExpression=condition_expression,
                ExpressionAttributeNames=expression_attribute_names,
                ExpressionAttributeValues=expression_attribute_values,
            )
            return True
        except Exception as error:
            if _is_conditional_check_failed(error):
                return False
            raise

    def _scan_actions(self) -> list[dict]:
        items: list[dict] = []
        kwargs: dict[str, Any] = {}
        while True:
            response = self.table.scan(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                return items
            kwargs["ExclusiveStartKey"] = last_key


def _action_to_item(action: dict) -> dict:
    item = deepcopy(action)
    expires_at = item.get("expiresAt")
    if isinstance(expires_at, str):
        item["ttl"] = _iso_epoch_seconds(expires_at)
    return item


def _item_to_action(item: dict) -> dict:
    action = deepcopy(item)
    action.pop("ttl", None)
    return action


def _is_conditional_check_failed(error: Exception) -> bool:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        return code == "ConditionalCheckFailedException"
    return error.__class__.__name__ == "ConditionalCheckFailedException"


def _iso_epoch_seconds(value: str) -> int:
    from datetime import datetime, timezone

    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def boto3_client(service_name: str) -> Any:
    import boto3

    return boto3.client(service_name)


def boto3_resource(service_name: str) -> Any:
    import boto3

    return boto3.resource(service_name)


def dogfood_context_consent_repository() -> Any | None:
    global _CONTEXT_CONSENT_REPOSITORY
    if _CONTEXT_CONSENT_REPOSITORY is not None:
        return _CONTEXT_CONSENT_REPOSITORY
    table_name = os.environ.get(CONSENT_GRANT_TABLE_NAME_ENV)
    if not table_name:
        return None
    context_module = importlib.import_module("ai_assist_context_service")
    _CONTEXT_CONSENT_REPOSITORY = context_module.DynamoDbContextConsentGrantRepository(
        boto3_resource("dynamodb").Table(table_name)
    )
    return _CONTEXT_CONSENT_REPOSITORY


def dogfood_context_consent_grant(request: dict[str, Any], consent_grant_id: str | None) -> dict[str, Any] | None:
    repository = dogfood_context_consent_repository()
    if repository is not None:
        return repository.load_grant_for_request(request, consent_grant_id)
    if os.environ.get(DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED_ENV) != "true":
        return None
    raw_grant = os.environ.get(DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV)
    if not raw_grant:
        return None
    grant = json.loads(raw_grant)
    if not isinstance(grant, dict):
        raise ValueError(f"{DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV} must be a JSON object.")
    if consent_grant_id and grant.get("grantId") != consent_grant_id:
        return None
    return grant


def dogfood_require_google_oauth(request: dict[str, Any]) -> None:
    token_status = AuthGoogleTokenProvider(dogfood_auth_app()).get_access_token(
        {
            **request,
            "operation": "readContext",
            "requiredScopes": ["https://www.googleapis.com/auth/documents.readonly"],
        }
    )
    if token_status.get("accessToken") or token_status.get("status") == "available":
        return
    context_module = importlib.import_module("ai_assist_context_service")
    raise context_module.ContextServiceError(
        "GOOGLE_OAUTH_REQUIRED",
        "Connect Google before granting document context.",
        http_status=403,
        category="AUTHORIZATION",
        details={
            "provider": "google",
            "reconnectRequired": bool(token_status.get("reconnectRequired")),
            "refreshRequired": bool(token_status.get("refreshRequired")),
        },
    )


def dogfood_google_docs_read_context(request: dict[str, Any]) -> dict[str, Any]:
    adapter = dogfood_google_docs_app().adapter
    resource_ref = request.get("resourceRef") or {}
    return adapter.read_context(
        {
            **request,
            "resourceId": resource_ref.get("resourceId"),
        }
    )


class AuthGoogleTokenProvider:
    def __init__(self, auth_app: Any) -> None:
        self.auth_app = auth_app

    def get_access_token(self, input_: dict[str, Any]) -> dict[str, Any]:
        identity = {
            "tenantId": input_.get("tenantId"),
            "userId": input_.get("userId"),
            "authSubject": input_.get("authSubject") or input_.get("userId"),
        }
        google_account_id = input_.get("googleAccountId") or self._single_google_account_id(identity, input_)
        if not google_account_id:
            return {
                "provider": "google",
                "status": "reconnect_required",
                "tenantId": identity["tenantId"],
                "userId": identity["userId"],
                "operation": input_.get("operation"),
                "scopes": [],
                "requiredScopes": input_.get("requiredScopes") or [],
                "reconnectRequired": True,
                "refreshRequired": False,
            }
        return self.auth_app.oauth_token_service.get_google_access_token(
            identity=identity,
            google_account_id=google_account_id,
            operation=input_.get("operation"),
            required_scopes=input_.get("requiredScopes") or [],
        )

    def _single_google_account_id(self, identity: dict[str, Any], input_: dict[str, Any]) -> str | None:
        status = self.auth_app.oauth_token_service.get_google_status(identity=identity)
        available = [account for account in status.get("accounts", []) if account.get("isAvailable")]
        if len(available) == 1:
            return available[0].get("googleAccountId")
        accounts = status.get("accounts", [])
        if len(accounts) == 1:
            return accounts[0].get("googleAccountId")
        if len(accounts) > 1:
            errors_module = importlib.import_module("ai_assist_google_docs_adapter.errors")
            raise errors_module.GoogleDocsAdapterError(
                code="VALIDATION_ERROR",
                message="googleAccountId is required when multiple Google accounts are connected.",
                http_status=400,
                details={"field": "googleAccountId"},
            )
        return None


def authenticated_downstream_headers(headers: dict[str, str]) -> dict[str, str]:
    product_session = dogfood_product_session(headers)
    identity = dogfood_auth_app().identity_service.derive_identity(product_session=product_session)
    sanitized = {
        key: value
        for key, value in headers.items()
        if str(key).lower() not in TRUSTED_IDENTITY_HEADERS
    }
    return {
        **sanitized,
        "X-Ai-Assist-Tenant-Id": identity["tenantId"],
        "X-Ai-Assist-User-Id": identity["userId"],
        "X-Ai-Assist-Auth-Subject": identity["authSubject"],
    }


def dogfood_orchestration_auth(request: dict[str, Any]) -> dict[str, str]:
    headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
    product_session = dogfood_product_session(headers)
    identity = dogfood_auth_app().identity_service.derive_identity(product_session=product_session)
    return {
        "tenantId": identity["tenantId"],
        "userId": identity["userId"],
    }


def dogfood_orchestration_body(method: str, path: str, body: bytes | None) -> bytes | None:
    if method != "POST" or not COMMAND_ROUTE_RE.match(path):
        return body
    payload = parse_json_body_bytes(body)
    provider = normalize_provider_name(payload.get("provider")) or default_platform_provider()
    if provider is not None:
        payload.setdefault("provider", provider)
        payload["providerAccess"] = platform_provider_access_payload(provider, payload.get("providerAccess"))
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def parse_json_body_bytes(body: bytes | str | None) -> dict[str, Any]:
    if body in {None, b"", ""}:
        return {}
    raw = body.decode("utf-8") if isinstance(body, bytes) else body
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("JSON request body must be an object.")
    return parsed


def platform_provider_access_payload(provider: str, existing: Any) -> dict[str, Any]:
    if isinstance(existing, dict) and existing.get("source") == "byo":
        return {
            "source": "byo",
            "secretRef": existing.get("secretRef"),
        }
    return {
        "source": "platform",
        "reference": provider_secret_ref(provider),
        "quotaDecision": platform_provider_quota_decision(provider),
        "auditDecision": platform_provider_audit_decision(provider),
    }


def platform_provider_status_payload() -> dict[str, Any]:
    return {
        "providers": [provider_status(provider) for provider in SUPPORTED_PLATFORM_PROVIDERS],
        "defaultProvider": default_platform_provider(),
    }


def provider_status(provider: str) -> dict[str, Any]:
    configured = provider_secret_ref(provider) is not None
    model_configured = provider_model(provider) is not None
    quota_decision = platform_provider_quota_decision(provider)
    audit_decision = platform_provider_audit_decision(provider)
    owner_dev_enabled = owner_dev_provider_enabled()
    ready = configured and model_configured and owner_dev_enabled and quota_decision["decision"] == "allow" and audit_decision["decision"] == "recorded"
    return {
        "provider": provider,
        "status": "available" if ready else "not_configured",
        "accessSource": "platform",
        "configured": configured,
        "available": ready,
        "default": provider == default_platform_provider(),
        "quotaReady": quota_decision["decision"] == "allow",
        "auditReady": audit_decision["decision"] == "recorded",
        "modelConfigured": model_configured,
        "ownerDevEnabled": owner_dev_enabled,
        **(
            {}
            if ready
            else {
                "reasonCode": provider_not_ready_reason(
                    configured=configured,
                    model_configured=model_configured,
                    owner_dev_enabled=owner_dev_enabled,
                    quota_decision=quota_decision,
                    audit_decision=audit_decision,
                )
            }
        ),
    }


def platform_provider_quota_decision(provider: str) -> dict[str, Any]:
    del provider
    if os.environ.get(PLATFORM_PROVIDER_QUOTA_MODE_ENV, "").strip().lower() == "enforced":
        return {"decision": "allow", "status": "ready"}
    return {
        "decision": "not_configured",
        "status": "quota_not_ready",
        "reasonCode": "PLATFORM_PROVIDER_QUOTA_NOT_CONFIGURED",
    }


def platform_provider_audit_decision(provider: str) -> dict[str, Any]:
    del provider
    if os.environ.get(PLATFORM_PROVIDER_AUDIT_MODE_ENV, "").strip().lower() == "metadata":
        return {"decision": "recorded", "status": "ready"}
    return {
        "decision": "not_configured",
        "status": "audit_not_ready",
        "reasonCode": "PLATFORM_PROVIDER_AUDIT_NOT_CONFIGURED",
    }


def provider_not_ready_reason(
    *,
    configured: bool,
    model_configured: bool,
    owner_dev_enabled: bool,
    quota_decision: dict[str, Any],
    audit_decision: dict[str, Any],
) -> str:
    if not configured:
        return "PLATFORM_PROVIDER_SECRET_REF_MISSING"
    if not model_configured:
        return "PLATFORM_PROVIDER_MODEL_NOT_CONFIGURED"
    if not owner_dev_enabled:
        return "DOGFOOD_OWNER_DEV_PROVIDER_DISABLED"
    if quota_decision.get("decision") != "allow":
        return str(quota_decision.get("reasonCode") or "PLATFORM_PROVIDER_QUOTA_NOT_CONFIGURED")
    if audit_decision.get("decision") != "recorded":
        return str(audit_decision.get("reasonCode") or "PLATFORM_PROVIDER_AUDIT_NOT_CONFIGURED")
    return "PLATFORM_PROVIDER_NOT_READY"


def provider_secret_ref(provider: str) -> str | None:
    value = os.environ.get(f"{PLATFORM_PROVIDER_SECRET_REF_PREFIX}{provider.upper()}")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def provider_model(provider: str) -> str | None:
    value = os.environ.get(f"{PLATFORM_PROVIDER_MODEL_PREFIX}{provider.upper()}")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def owner_dev_provider_enabled() -> bool:
    return os.environ.get(PLATFORM_PROVIDER_OWNER_DEV_ENABLED_ENV, "").strip().lower() == "true"


def owner_dev_provider_allowed(request: dict[str, Any]) -> bool:
    return allowed_product_user_role(request.get("tenantId"), request.get("userId")) == "owner"


def allowed_product_user_role(tenant_id: Any, user_id: Any) -> str | None:
    if not isinstance(tenant_id, str) or not isinstance(user_id, str):
        return None
    raw = os.environ.get("AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON")
    if not raw:
        return None
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("tenantId") == tenant_id and entry.get("userId") == user_id and entry.get("status") == "active":
            role = entry.get("role")
            return role if isinstance(role, str) else None
    return None


def default_platform_provider() -> str | None:
    configured = normalize_provider_name(os.environ.get(PLATFORM_PROVIDER_DEFAULT_ENV))
    if configured in SUPPORTED_PLATFORM_PROVIDERS:
        return configured
    for provider in SUPPORTED_PLATFORM_PROVIDERS:
        if provider_secret_ref(provider) is not None:
            return provider
    return None


def normalize_provider_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def platform_provider_credential(reference: str) -> str:
    try:
        response = boto3_client("secretsmanager").get_secret_value(SecretId=reference)
    except Exception as error:
        raise ProviderClientError(
            code="PROVIDER_ACCESS_UNAVAILABLE",
            category="unavailable",
            safe_message="Platform provider access is temporarily unavailable.",
            dependency_status="secret_unavailable",
        ) from error
    secret = response.get("SecretString")
    if not isinstance(secret, str) or not secret.strip():
        raise ProviderClientError(
            code="INVALID_CREDENTIAL",
            category="authentication",
            safe_message="Provider credential is invalid or expired.",
            dependency_status="invalid_secret",
        )
    credential = extract_provider_credential(secret)
    if credential is None:
        raise ProviderClientError(
            code="INVALID_CREDENTIAL",
            category="authentication",
            safe_message="Provider credential is invalid or expired.",
            dependency_status="invalid_secret",
        )
    return credential


def extract_provider_credential(secret: str) -> str | None:
    trimmed = secret.strip()
    try:
        parsed = json.loads(trimmed)
    except json.JSONDecodeError:
        return trimmed
    if not isinstance(parsed, dict):
        return None
    for key in ("apiKey", "openaiApiKey", "credential", "secret", "value"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def openai_chat_client(credential: str) -> "OpenAiChatClient":
    return OpenAiChatClient(credential=credential)


def provider_messages(request: dict[str, Any]) -> list[dict[str, str]]:
    prompt = request.get("prompt") if isinstance(request.get("prompt"), dict) else {}
    messages = prompt.get("messages")
    if not isinstance(messages, list):
        return []
    normalized = []
    for message in messages:
        if not isinstance(message, dict):
            return []
        role = message.get("role")
        content = message.get("content")
        if role not in {"system", "user", "assistant"} or not isinstance(content, str) or not content.strip():
            return []
        normalized.append({"role": role, "content": content})
    return normalized


class ProviderClientError(Exception):
    def __init__(
        self,
        *,
        code: str,
        category: str,
        safe_message: str,
        dependency_status: str,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(safe_message)
        self.code = code
        self.category = category
        self.safe_message = safe_message
        self.dependency_status = dependency_status
        self.retry_after_seconds = retry_after_seconds


class OpenAiChatClient:
    def __init__(self, *, credential: str, url: str = OPENAI_CHAT_COMPLETIONS_URL, timeout: int = OPENAI_PROVIDER_TIMEOUT_SECONDS) -> None:
        self.credential = credential
        self.url = url
        self.timeout = timeout

    def complete(self, request: dict[str, Any]) -> dict[str, Any]:
        body = {
            "model": request["model"],
            "messages": request["messages"],
            "temperature": request.get("temperature", 0.2),
            "max_tokens": request.get("maxOutputTokens", 700),
        }
        http_request = urllib.request.Request(
            self.url,
            data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.credential}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise normalize_provider_http_error(error) from error
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            raise ProviderClientError(
                code="PROVIDER_UNAVAILABLE",
                category="unavailable",
                safe_message="Provider is temporarily unavailable.",
                dependency_status="unavailable",
            ) from error
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise ProviderClientError(
                code="UNKNOWN_PROVIDER_ERROR",
                category="unavailable",
                safe_message="Provider request failed.",
                dependency_status="malformed",
            ) from error
        if not isinstance(payload, dict):
            raise ProviderClientError(
                code="UNKNOWN_PROVIDER_ERROR",
                category="unavailable",
                safe_message="Provider request failed.",
                dependency_status="malformed",
            )
        content = (((payload.get("choices") or [{}])[0].get("message") or {}).get("content")) if isinstance(payload.get("choices"), list) else None
        return {
            "model": payload.get("model") or request["model"],
            "content": content if isinstance(content, str) else "",
            "finishReason": ((payload.get("choices") or [{}])[0].get("finish_reason")) if isinstance(payload.get("choices"), list) else None,
            "usage": normalize_openai_usage(payload.get("usage")),
        }


def normalize_provider_http_error(error: urllib.error.HTTPError) -> ProviderClientError:
    retry_after = parse_retry_after(error.headers.get("Retry-After") if error.headers else None)
    signal = provider_error_signal(error)
    if error.code in {401, 403}:
        return ProviderClientError(
            code="INVALID_CREDENTIAL",
            category="authentication",
            safe_message="Provider credential is invalid or expired.",
            dependency_status="invalid_credential",
        )
    if error.code == 429 and signal in {"insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"}:
        return ProviderClientError(
            code="PROVIDER_QUOTA_EXCEEDED",
            category="quota",
            safe_message="Provider quota is exhausted.",
            dependency_status="quota_exceeded",
            retry_after_seconds=retry_after,
        )
    if error.code == 429:
        return ProviderClientError(
            code="PROVIDER_RATE_LIMITED",
            category="rate_limited",
            safe_message="Provider rate limit was reached.",
            dependency_status="rate_limited",
            retry_after_seconds=retry_after,
        )
    if error.code == 400:
        return ProviderClientError(
            code="PROVIDER_VALIDATION_ERROR",
            category="invalid_request",
            safe_message="Provider rejected the request shape.",
            dependency_status="invalid_request",
        )
    return ProviderClientError(
        code="PROVIDER_UNAVAILABLE" if error.code in {408, 500, 502, 503, 504, 529} else "UNKNOWN_PROVIDER_ERROR",
        category="unavailable",
        safe_message="Provider is temporarily unavailable." if error.code in {408, 500, 502, 503, 504, 529} else "Provider request failed.",
        dependency_status="unavailable",
        retry_after_seconds=retry_after,
    )


def provider_error_signal(error: urllib.error.HTTPError) -> str | None:
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    raw_error = payload.get("error")
    if not isinstance(raw_error, dict):
        return None
    value = raw_error.get("code") or raw_error.get("type")
    return str(value).lower() if value is not None else None


def normalize_openai_usage(usage: Any) -> dict[str, int] | None:
    if not isinstance(usage, dict):
        return None
    return {
        "inputTokens": int(usage.get("prompt_tokens") or 0),
        "outputTokens": int(usage.get("completion_tokens") or 0),
        "totalTokens": int(usage.get("total_tokens") or 0),
    }


def parse_retry_after(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def provider_error_event(
    *,
    provider: str,
    code: str,
    category: str,
    message: str,
    dependency_status: str,
    retry_after_seconds: int | None = None,
) -> dict[str, Any]:
    error = {
        "code": code,
        "category": category,
        "message": message,
        "retryable": category in {"quota", "rate_limited", "unavailable"},
        "dependencyStatus": dependency_status,
    }
    if retry_after_seconds is not None:
        error["retryAfterSeconds"] = retry_after_seconds
    return {
        "type": "error",
        "provider": provider,
        "error": error,
    }


def session_events_auth_headers(headers: dict[str, str]) -> dict[str, str]:
    if header_value(headers, "authorization"):
        product_session = dogfood_product_session(headers)
        identity = dogfood_auth_app().identity_service.derive_identity(product_session=product_session)
        sanitized = {
            key: value
            for key, value in headers.items()
            if str(key).lower() not in TRUSTED_IDENTITY_HEADERS
        }
        return {
            **sanitized,
            "X-Ai-Assist-Tenant-Id": identity["tenantId"],
            "X-Ai-Assist-User-Id": identity["userId"],
            "X-Ai-Assist-Auth-Subject": identity["authSubject"],
        }
    if trusted_upstream_sse_headers_enabled():
        return dict(headers)
    return {
        key: value
        for key, value in headers.items()
        if str(key).lower() not in TRUSTED_IDENTITY_HEADERS
    }


def trusted_upstream_sse_headers_enabled() -> bool:
    return os.environ.get(TRUSTED_UPSTREAM_SSE_HEADERS_ENV, "").strip().lower() == "true"


def header_value(headers: dict[str, str], name: str) -> str | None:
    lowered = name.lower()
    for key, value in headers.items():
        if str(key).lower() == lowered:
            return value
    return None


def dogfood_product_session(headers: dict[str, str]) -> dict[str, Any]:
    auth_app = dogfood_auth_app()
    normalized = normalize_headers(headers)
    product_session_from_headers = getattr(auth_app, "_product_session", None)
    if callable(product_session_from_headers):
        return product_session_from_headers(normalized)
    return auth_app.product_session_codec.verify_bearer(header_value(headers, "authorization"))


def normalize_headers(headers: dict[str, str]) -> dict[str, str]:
    return {str(key).lower(): value for key, value in headers.items()}


def parse_query(query_string: str) -> dict[str, list[str]]:
    from urllib.parse import parse_qs

    return parse_qs(query_string)


def exception_response(error: Exception, service: str, path: str) -> dict[str, Any]:
    status = int(getattr(error, "status", getattr(error, "http_status", 500)))
    code = str(getattr(error, "code", "DOGFOOD_RUNTIME_DEPENDENCY_FAILED"))
    message = str(getattr(error, "message", "Dogfood runtime dependency failed."))
    if status == 401:
        category = "AUTHENTICATION"
    elif status == 403:
        category = "AUTHORIZATION"
    elif status >= 500:
        category = "DEPENDENCY"
    else:
        category = "VALIDATION"
    return {
        "status": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(
            {
                "error": {
                    "code": code,
                    "category": category,
                    "message": message,
                    "retryable": bool(getattr(error, "retryable", False)),
                    "details": dict(getattr(error, "details", {}) or {}),
                },
                "service": service,
                "route": path,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8"),
    }


def log_context_dependency_exception(error: Exception, request: dict[str, Any], grant: dict[str, Any] | None) -> None:
    log_event = {
        "event": "dogfood.context.resolve.exception",
        "exceptionType": error.__class__.__name__,
        "exceptionMessage": safe_log_string(getattr(error, "message", None) or str(error)),
        "code": safe_log_string(getattr(error, "code", None)),
        "httpStatus": safe_log_int(getattr(error, "http_status", getattr(error, "status", None))),
        "category": safe_log_string(getattr(error, "category", None)),
        "retryable": bool(getattr(error, "retryable", False)),
        "details": safe_log_details(getattr(error, "details", {}) or {}),
        "hasTenantId": bool(request.get("tenantId")),
        "hasUserId": bool(request.get("userId")),
        "hasSessionId": bool(request.get("sessionId")),
        "hasResourceId": bool((request.get("resourceRef") or {}).get("resourceId")),
        "contextMode": safe_log_string(request.get("contextMode")),
        "provider": safe_log_string(request.get("provider")),
        "grantPresent": grant is not None,
        "grantStatus": safe_log_string((grant or {}).get("status")),
    }
    print(json.dumps(log_event, separators=(",", ":"), sort_keys=True), flush=True)


def safe_log_details(details: Any) -> dict[str, Any]:
    if not isinstance(details, dict):
        return {}
    return {
        key: safe_log_value(value)
        for key, value in details.items()
        if key in SAFE_LOG_DETAIL_KEYS and safe_log_value(value) is not None
    }


def safe_log_value(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return safe_log_string(value)
    return None


def safe_log_int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_log_string(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    redacted = value[:240]
    for pattern in UNSAFE_LOG_PATTERNS:
        redacted = pattern.sub("[redacted]", redacted)
    return redacted


def normalize_package_response(response: dict[str, Any]) -> dict[str, Any]:
    status = response.get("status", response.get("statusCode", 500))
    headers = response.get("headers", {})
    body = response.get("body", b"")
    if not isinstance(headers, dict):
        headers = {}
    if isinstance(body, (dict, list)):
        headers = {"Content-Type": "application/json", **headers}
        body = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {
        "status": status,
        "headers": headers,
        "body": body,
        **({"stream": response["stream"]} if response.get("stream") is not None else {}),
    }


def json_response(status: int, code: str, message: str, service: str, path: str) -> dict[str, Any]:
    return {
        "status": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(
            {
                "error": {
                    "code": code,
                    "category": "DEPENDENCY" if status >= 500 else "VALIDATION",
                    "message": message,
                    "retryable": False,
                },
                "service": service,
                "route": path,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8"),
    }
