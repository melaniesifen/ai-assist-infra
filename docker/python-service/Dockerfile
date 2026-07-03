ARG PYTHON_BASE_IMAGE=python:3.13-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ARG PYTHON_PACKAGE

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/service/src \
    SERVICE_PORT=8080 \
    PYTHON_PACKAGE=${PYTHON_PACKAGE}

WORKDIR /app

COPY health_server.py /app/health_server.py
COPY --from=service pyproject.toml /app/service/pyproject.toml
COPY --from=service src /app/service/src

RUN python -m compileall /app/service/src

USER 65534:65534
EXPOSE 8080

CMD ["python", "/app/health_server.py"]
