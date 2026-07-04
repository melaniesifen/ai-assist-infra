from __future__ import annotations

import importlib
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable


Handler = Callable[..., dict[str, Any]]
_AUTH_APP: Any | None = None
_GOOGLE_DOCS_APP: Any | None = None
_CONTEXT_APP: Any | None = None
TRUSTED_IDENTITY_HEADERS = {
    "x-ai-assist-tenant-id",
    "x-ai-assist-user-id",
    "x-ai-assist-auth-subject",
}
DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV = "AI_ASSIST_DOGFOOD_CONTEXT_CONSENT_GRANT_JSON"


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
    route("GET", r"^/resource-sessions/[^/]+/actions$", "ai-assist-orchestration-service", "ai_assist_orchestration"),
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
    if dispatch.supports_sse:
        return sse_ready_response(dispatch.owning_service)

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
        )
    return _CONTEXT_APP


def dogfood_context_consent_grant(request: dict[str, Any], consent_grant_id: str | None) -> dict[str, Any] | None:
    del request
    raw_grant = os.environ.get(DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV)
    if not raw_grant:
        return None
    grant = json.loads(raw_grant)
    if not isinstance(grant, dict):
        raise ValueError(f"{DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENV} must be a JSON object.")
    if consent_grant_id and grant.get("grantId") != consent_grant_id:
        return None
    return grant


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
    product_session = dogfood_auth_app().product_session_codec.verify_bearer(header_value(headers, "authorization"))
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


def header_value(headers: dict[str, str], name: str) -> str | None:
    lowered = name.lower()
    for key, value in headers.items():
        if str(key).lower() == lowered:
            return value
    return None


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


def sse_ready_response(service: str) -> dict[str, Any]:
    return {
        "status": 200,
        "headers": {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
        "body": b": ai-assist dogfood runtime sse path ready\n\n",
    }


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
