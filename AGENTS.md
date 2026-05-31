# AGENTS.md

## Repo Purpose

`ai-assist-infra` owns infrastructure definitions, environment configuration, service routes, DynamoDB table specs, KMS purposes, IAM boundaries, rate limits, and operational wiring.

## Agent Instructions

- Read `README.md`, `ai-assist-platform-context.md`, and `../ai-assist-architecture/lld-operations-safety.md` before changing behavior.
- Keep service IAM boundaries least-privilege by default.
- Do not add WebSocket infrastructure to MVP unless the product requirement changes.
- Include HTTP command APIs and SSE-capable session event routes for MVP.
- Keep `SessionSecrets` and `ProposedActions` TTL-bound and encrypted.
- Use metadata-only logging defaults. Do not configure request/response body logging for sensitive routes.
- Keep app-level tenant-aware counters documented as deferred until broader/public access.
- Add tests for environment validation, required routes, rate-limit configuration, KMS purpose mapping, DynamoDB table specs, and IAM boundary docs.

## Commands

- Run tests with `node --test`.
- `npm` may not be available in this environment; prefer the direct Node command.

## Review Notes

Before committing, review for overly broad IAM, missing rate limits, missing TTL/encryption fields, raw content logging, and infrastructure drift from the MVP architecture.

## Commit Messages

All commits in this repo must use this format:

```text
docs/feat/fix/(or another appropriate type): title of change

problem: <description of problem>
solution: <description of solution>
impact: <impact of this change>
reference: <reference to this change in the docs if applicable>
```
