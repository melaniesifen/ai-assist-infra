from __future__ import annotations

import importlib
import json
import re
from dataclasses import dataclass
from typing import Any, Callable


Handler = Callable[..., dict[str, Any]]


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

    package_handler = load_package_handler(dispatch.package)
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
