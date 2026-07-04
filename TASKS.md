# Task Breakdown

Update this file as implementation progresses. Check off completed tasks in the same change that implements or verifies them.

Canonical source: `../ai-assist-architecture/implementation-task-breakdown.md`.

Relevant LLDs:

- `../ai-assist-architecture/lld-operations-safety.md`
- `../ai-assist-architecture/lld-auth-secrets-tenancy.md`
- `../ai-assist-architecture/lld-actions-writeback.md`
- `../ai-assist-architecture/lld-session-events-transport.md`

## Completed Local Bootstrap

- [x] Create dependency-light Node.js ESM infrastructure configuration package.
- [x] Define environment name helpers and validation.
- [x] EVT-001: Define MVP HTTP route inventory for auth, OAuth, provider secrets, resource sessions, commands, context preview, action approval/rejection, and apply-action.
- [x] EVT-003: Include authenticated SSE route inventory for session events.
- [x] ACTION-001: Define `ProposedActions` table spec with tenant scope, action metadata, 24-hour TTL, and encrypted payload field.
- [x] AUTH-004: Define `SessionSecrets` table spec with tenant/user/provider scope, encrypted secret field, fingerprint, validation timestamp, and 8-hour TTL.
- [x] CTX-002: Define `ContextConsentGrants` table spec with tenant/user/provider/context mode scope and expiry fields.
- [x] AUTH-006: Define KMS purpose mapping for session secrets, OAuth tokens, proposed actions, and optional user secrets; current deployable MVP maps those purposes to one shared app key per deployment target.
- [x] AUTH-006: Define least-privilege IAM boundary documentation helpers by service, table, and KMS purpose.
- [x] OPS-001: Define route rate-limit tiers and validation for required MVP routes.
- [x] INFRA-002: Define DynamoDB table specs for tenants, users, OAuth tokens, session secrets, consent grants, resource sessions, proposed actions, and optional session events.
- [x] INFRA-003: Define KMS alias strategy by environment. Current deployable MVP uses one rotated `app-key` alias per deployment target while retaining purpose metadata for IAM boundaries and future split-key migration.
- [x] Add unit tests for environments, route inventory, DynamoDB table specs, KMS purposes, rate-limit validation, and IAM boundary docs.
- [x] Reach at least 95% line coverage.
- [x] Document test and coverage commands in `README.md`.
- [x] Ignore local prompts, feedback, coverage output, dependencies, and build artifacts.

## Architecture Tasks Pending

- Approved direction: migrate from the temporary Node.js ESM bootstrap to TypeScript CDK.
- Migration gate: Do not continue broad new feature work until the TypeScript CDK migration is completed or explicitly deferred.
- [x] REPO-001: Decide final infra language, CDK language, package manager, app layout, migration cost, deployment target, local workflow, and assertion-test strategy.
- [x] REPO-002: Migrate infrastructure to a TypeScript CDK app with equivalent route inventory, DynamoDB table specs, KMS purpose mapping, IAM boundary coverage, rate-limit configuration, assertion tests, synth workflow, and repo docs.
- [x] AUTH-006: Convert KMS purpose and IAM boundary helpers into deployable least-privilege IAM roles and KMS grants. Infra owns this slice because the workspace task requires deployable KMS key policy, IAM roles, and grants; service repos still own application authorization and typed dependency-error handling. Current MVP uses one shared customer-managed app key per target for cost control.
- [x] EVT-001: Implement API Gateway HTTP command routes with authentication integration and request/correlation ID propagation. Infra owns the edge route, authorizer wiring, and request/correlation ID propagation plumbing; command semantics remain owned by the service repos and shared contracts. Current M9-T2 state: HTTP command routes synthesize with JWT authorizer wiring, VPC link integrations, request/correlation ID header propagation, and private ALB listeners to ECS/Fargate service runtimes. `GET /health` is the only intentionally placeholder-backed route.
- [x] EVT-003: Implement SSE-capable service or Lambda path and edge route for session event streaming. Infra owns the deployable streaming path and edge route; session event payload contracts and publishing semantics remain owned by contracts, session-events, and orchestration repos. Current M9-T2 state: the browser SSE route is hosted by a public HTTPS ALB to the session-events Fargate runtime with 900 second idle timeout, heartbeat/replay env vars, health checks, logs, and IAM boundaries. Lambda is not used for primary SSE.
- [x] OPS-001: Implement API Gateway throttling and optional WAF rate-based rules for auth, OAuth, provider-key validation, command creation, context preview, SSE stream creation, and apply-action.
- [x] OPS-002: Keep app-level DynamoDB tenant-aware counters explicitly deferred for trusted-user MVP; add follow-up before public or untrusted access. Infra owns the deployment deferral and future counter infrastructure hooks because the workspace task avoids overbuilding DynamoDB TTL counters while preserving the public-launch path.
- [x] OPS-003: Configure metadata-only logging defaults and disable request/response body logging on sensitive routes.
- [x] OPS-004: Add CloudWatch metrics, dashboards, and alarms for latency, error categories, dependency failures, provider usage, throttling, KMS failures, OAuth failures, action conflicts, and apply failures.
- [x] OPS-005: Add runbook skeletons for provider outage/quota, Google OAuth revocation spike, KMS failure, SSE stream failure, rate-limit misconfiguration, and repeated action conflicts.
- [x] INFRA-001: Build AWS MVP stack with HTTP API, SSE-capable route, DynamoDB, one shared app KMS key per deployment target, CloudWatch logs/metrics, service IAM roles, configurable rate limits, configurable TTLs, and optional WAF. Infra owns this workspace definition task because it is the deployable AWS stack shape that assembles shared service prerequisites without owning service business logic.
- [x] INFRA-001: Exclude WebSocket API Gateway and connection registry from MVP infrastructure. Infra owns this negative requirement because the MVP stack must keep WebSocket resources out until a later transport decision adds them.
- [ ] INFRA-002: Document DynamoDB access patterns before creating tables.
- [x] INFRA-003: Document KMS key rotation strategy at least at a high level.
- [x] INFRA-004: Define deployment order across contracts, infra tables/keys/routes, auth/secrets/context services, adapters, session events, and orchestration E2E.
- [x] INFRA-005: Define local/dev environment config for service endpoints, tenant/user bootstrap, provider adapters, Google OAuth, AWS/KMS/DynamoDB, and stubbed services.
- [ ] E2E-005: Validate rate limits, expired secret behavior, revoked OAuth behavior, metadata-only logs, dependency metrics, throttles, token usage, and action conflict metrics.
- [x] Add integration tests or assertions for HTTP/SSE route auth, DynamoDB TTL tables, KMS grants, service IAM boundaries, and rate-limit configuration. Current M9-T2 state: assertion tests cover API Gateway JWT route auth, VPC link service integrations, public ALB SSE hosting, DynamoDB TTL tables, one shared KMS app key, ECS task roles, IAM/KMS/DynamoDB grants, rate limits, logs, alarms, and stage-safe names.
- [x] Define deployment pipeline tasks for synth/diff, environment parameter validation, least-privilege policy checks, migrations, smoke tests, and rollback notes.
- [x] Add failure-mode validation for KMS denial, DynamoDB throttling, SSE route failure, rate-limit misconfiguration, TTL expiry behavior, and alarm/runbook coverage.
- [x] Add repeatable CDK Docker image assets for Python service runtimes so deploys no longer require manually supplied service image URI parameters.
- [x] Add gamma as a first-class deployment target with stage-safe names between dev and prod.
- [x] Add container deployment guardrails for non-`latest` base image selection, CDK asset image publication, and Fargate `LATEST` platform version.
- [x] Move SSE domain, hosted zone, product auth issuer, and product auth audience from CloudFormation parameters to ignored local CDK context so standard deploys do not require manual parameters.
- [x] Let CDK create public SSE ACM certificates, DNS validation, and Route 53 alias records from the configured hosted zone for repeatable dev/gamma/prod deploys.
- [x] M9-T9 route/runtime contract slice: align the typed route inventory and assertions to canonical deployed-dev paths: `/oauth/google/*`, `/sessions/{sessionId}/events`, auth login/logout/session, resource-session commands/actions/apply, and `GET /health` as the only intentionally placeholder-backed route.
- [x] M9-T9 route/runtime contract slice: document the API Gateway JWT/OIDC issuer, audience, and JWKS discovery requirements plus the trusted-user login and OAuth callback edge-auth exceptions that must be validated by the auth service.
- [x] Add a dev-only `edgeJwtAuthEnabled=false` infra-health bypass for API Gateway JWT authorizer creation while keeping gamma/prod edge auth strict.
- [x] M9-T9 auth runtime slice: update the shared Python service container to install repo dependencies and delegate non-health requests to service-provided HTTP adapters, preserving safe `501` fallback for services that do not yet provide one.

## Future Production Tasks

- [ ] Add app-level tenant/user rate-limit counters before public or broader tenant access.
- [ ] Add multi-environment promotion pipeline after MVP stack shape is stable.
- [ ] Add cost, quota, and budget alarms once provider usage metrics are wired.
- [ ] Replace deployable health-only service containers with production HTTP adapters for each trusted-user MVP route before claiming real end-to-end smoke coverage.
