from __future__ import annotations

import importlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse


SERVICE_NAME = os.environ.get("SERVICE_NAME", "unknown-service")
PYTHON_PACKAGE = os.environ.get("PYTHON_PACKAGE", "")
SERVICE_PORT = int(os.environ.get("SERVICE_PORT", "8080"))


def package_status() -> dict[str, Any]:
    try:
        importlib.import_module(PYTHON_PACKAGE)
        return {"package": PYTHON_PACKAGE, "importable": True}
    except Exception as error:  # pragma: no cover - exercised inside container health checks.
        return {"package": PYTHON_PACKAGE, "importable": False, "errorType": type(error).__name__}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
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
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", SERVICE_PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
