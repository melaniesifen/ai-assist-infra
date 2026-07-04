from __future__ import annotations

import importlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse


SERVICE_NAME = os.environ.get("SERVICE_NAME", "unknown-service")
PYTHON_PACKAGE = os.environ.get("PYTHON_PACKAGE", "")
SERVICE_PORT = int(os.environ.get("SERVICE_PORT", "8080"))
SSE_HEARTBEAT_SECONDS = int(os.environ.get("SSE_HEARTBEAT_SECONDS", "25"))
SSE_POLL_SECONDS = 0.25
_SERVICE_HTTP_HANDLER = None


def package_status() -> dict[str, Any]:
    try:
        importlib.import_module(PYTHON_PACKAGE)
        return {"package": PYTHON_PACKAGE, "importable": True}
    except Exception as error:  # pragma: no cover - exercised inside container health checks.
        return {"package": PYTHON_PACKAGE, "importable": False, "errorType": type(error).__name__}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    def _handle(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            status = package_status()
            self._write_json(
                200 if status["importable"] else 503,
                {
                    "status": "ok" if status["importable"] else "unavailable",
                    "service": SERVICE_NAME,
                    "runtime": "python-service-container",
                    **status,
                },
            )
            return

        handler = service_http_handler()
        if handler is not None:
            try:
                content_length = int(self.headers.get("Content-Length", "0") or "0")
                body = self.rfile.read(content_length) if content_length else b""
                response = handler(
                    method=self.command,
                    path=parsed.path,
                    query_string=parsed.query,
                    headers={key: value for key, value in self.headers.items()},
                    body=body,
                )
                self._write_response(response)
                return
            except Exception as error:
                self._write_json(
                    500,
                    {
                        "error": {
                            "code": "SERVICE_HTTP_HANDLER_FAILED",
                            "category": "DEPENDENCY",
                            "message": "The service HTTP adapter failed before returning a response.",
                            "retryable": True,
                            "errorType": type(error).__name__,
                        },
                        "service": SERVICE_NAME,
                        "route": parsed.path,
                    },
                )
                return

        self._write_json(
            501,
            {
                "error": {
                    "code": "HTTP_ADAPTER_NOT_IMPLEMENTED",
                    "category": "DEPENDENCY",
                    "message": "The service container is deployable, but this route is not implemented by the service HTTP adapter yet.",
                    "retryable": False,
                },
                "service": SERVICE_NAME,
                "route": parsed.path,
            },
        )

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _write_json(self, status_code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        self._write_response(
            {
                "status": status_code,
                "headers": {"Content-Type": "application/json"},
                "body": body,
            }
        )

    def _write_response(self, response: dict[str, Any]) -> None:
        stream = response.get("stream")
        if stream is not None:
            self._write_stream_response(response, stream)
            return

        body = response.get("body", b"")
        if isinstance(body, str):
            body = body.encode("utf-8")
        status_code = int(response.get("status", 500))
        self.send_response(status_code)
        for key, value in response.get("headers", {}).items():
            self.send_header(key, str(value))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_stream_response(self, response: dict[str, Any], stream: Any) -> None:
        status_code = int(response.get("status", 500))
        self.send_response(status_code)
        for key, value in response.get("headers", {}).items():
            self.send_header(key, str(value))
        self.end_headers()

        last_heartbeat = time.monotonic()
        try:
            while True:
                for chunk in stream.pop_pending():
                    self.wfile.write(_encode_chunk(chunk))
                    self.wfile.flush()
                now = time.monotonic()
                if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    heartbeat = stream.heartbeat()
                    if heartbeat:
                        self.wfile.write(_encode_chunk(heartbeat))
                        self.wfile.flush()
                    last_heartbeat = now
                time.sleep(SSE_POLL_SECONDS)
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                close(disconnect_reason="client_disconnect")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", SERVICE_PORT), Handler)
    server.serve_forever()


def service_http_handler() -> Any:
    global _SERVICE_HTTP_HANDLER
    if _SERVICE_HTTP_HANDLER is not None:
        return _SERVICE_HTTP_HANDLER
    try:
        module = importlib.import_module(f"{PYTHON_PACKAGE}.http_app")
        handler = getattr(module, "handle_http_request", None)
        _SERVICE_HTTP_HANDLER = handler if callable(handler) else False
    except Exception:
        _SERVICE_HTTP_HANDLER = False
    return _SERVICE_HTTP_HANDLER or None


def _encode_chunk(chunk: Any) -> bytes:
    if isinstance(chunk, bytes):
        return chunk
    return str(chunk).encode("utf-8")


if __name__ == "__main__":
    main()
