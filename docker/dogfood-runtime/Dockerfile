ARG PYTHON_BASE_IMAGE=python:3.13-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    SERVICE_PORT=8080 \
    PYTHON_PACKAGE=ai_assist_dogfood_runtime

WORKDIR /app

COPY --from=python_service health_server.py /app/health_server.py
COPY ai_assist_dogfood_runtime /app/ai_assist_dogfood_runtime

COPY --from=auth_service pyproject.toml /app/services/auth/pyproject.toml
COPY --from=auth_service src /app/services/auth/src
COPY --from=secrets_service pyproject.toml /app/services/secrets/pyproject.toml
COPY --from=secrets_service src /app/services/secrets/src
COPY --from=orchestration_service pyproject.toml /app/services/orchestration/pyproject.toml
COPY --from=orchestration_service src /app/services/orchestration/src
COPY --from=session_events_service pyproject.toml /app/services/session-events/pyproject.toml
COPY --from=session_events_service src /app/services/session-events/src
COPY --from=context_service pyproject.toml /app/services/context/pyproject.toml
COPY --from=context_service src /app/services/context/src
COPY --from=google_docs_adapter pyproject.toml /app/services/google-docs/pyproject.toml
COPY --from=google_docs_adapter src /app/services/google-docs/src

RUN for service_dir in /app/services/*; do \
      python -m pip install --no-cache-dir "$service_dir"; \
    done \
    && python -m compileall /app/ai_assist_dogfood_runtime /app/services

USER 65534:65534
EXPOSE 8080

CMD ["python", "/app/health_server.py"]
