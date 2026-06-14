# ai-assist-infra

TypeScript CDK infrastructure app for the AI Assist Platform.

This repo owns the deployable infrastructure shape plus the typed inventories
used by assertion tests. The previous dependency-light Node.js ESM bootstrap has
been superseded by a repo-local TypeScript CDK app while preserving the route,
DynamoDB, KMS, IAM boundary, and rate-limit contracts.

## Current Contents

- `bin/ai-assist-infra.ts`: CDK app entry point.
- `src/stacks/ai-assist-infra-stack.ts`: MVP stack with HTTP route integrations, Fargate service runtimes, public ALB SSE hosting, DynamoDB tables, one shared app KMS key per target, IAM roles, and default API throttling.
- `src/config/*.ts`: typed deployment target, runtime config, route, DynamoDB, KMS, rate-limit, IAM boundary, and operational guardrail inventories.
- `test/*.test.ts`: Node built-in tests plus CDK assertion tests.
- `cdk.json`, `tsconfig.json`, `package.json`, and `package-lock.json`: repo-local CDK and TypeScript tooling.

## Stack Scope

The current CDK app creates:

- One shared customer-managed KMS app key and alias per deployment target for OAuth tokens, session secrets, proposed actions, and future user secrets.
- DynamoDB tables for tenants, users, OAuth tokens, session secrets, consent grants, resource sessions, proposed actions, and optional session event replay metadata.
- HTTP API command routes with JWT authorizer wiring and private ALB integrations to ECS/Fargate service runtimes.
- Public HTTPS ALB hosting for browser `EventSource` SSE streams to the session-events runtime.
- Service IAM roles with table and KMS grants derived from the IAM boundary matrix.
- Default API Gateway throttling based on the route rate-limit tiers.

The only intentionally placeholder-backed route is `GET /health`. Trusted-user
MVP command routes synthesize with service integrations. The SSE stream route is
owned by the public ALB path instead of API Gateway so browser `EventSource`
can use long-lived responses.

This repo owns infrastructure shape, not application business logic. Service
repos remain responsible for safe logging, authentication checks, context
authorization, and secret-free responses.

## Deployment Targets

The CDK app synthesizes exactly two initial targets from
`src/config/environments.ts`:

| Target | Region | Account Source | Stack | Default Removal Posture |
| --- | --- | --- | --- | --- |
| `dev` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistDevInfraStack` | cleanup-friendly |
| `prod` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistProdInfraStack` | retain/protect |

Add later stages or regions by editing the typed target list, not by copying
stack code. Deployable resource names include environment and region, for
example `ai-assist-dev-us-west-2-http-api`, so KMS aliases, DynamoDB table
names, API names, log groups, IAM role names, outputs, and future global
resources have stage-safe and region-safe prefixes.

KMS is intentionally cost-conscious for the trusted-user MVP: each deployment
target creates one rotated customer-managed key, for example
`alias/ai-assist-dev-us-west-2-app-key`. The typed KMS purpose inventory is
still retained for IAM boundary documentation and future split-key migration,
but all current encrypted tables and service grants resolve to the shared app
key.

## Route Inventory

The typed route inventory covers:

- product session: `GET /auth/session`
- Google OAuth: `GET /auth/google/start`, `GET /auth/google/callback`
- setup status: `GET /setup/status`
- provider availability and BYO session-secret status
- Google Docs resource listing
- resource-session create/read
- context mode and context preview
- command creation
- SSE events on the public ALB: `GET /resource-sessions/{sessionId}/events`
- action review: `GET /resource-sessions/{sessionId}/actions`, approve, reject
- apply-action: `POST /resource-sessions/{sessionId}/apply-action`

HTTP command routes synthesize with API Gateway JWT authorization, VPC link
integrations, request/correlation ID header propagation, and private ALB
listeners per owning service. Owning service repos still own command behavior,
service-side authZ, SSE event payloads, and action state transitions.

The public SSE ALB uses HTTPS, a 900 second idle timeout, session-events
Fargate tasks, service logs, health checks, and generic SSE config:
`SSE_HEARTBEAT_SECONDS=25` and `SSE_REPLAY_WINDOW_SECONDS=300`.

## Local Real-Flow Config

`src/config/runtime-config.ts` defines the required env/config surface for the
trusted-user real-flow stack. Missing or invalid config must fail closed with
setup status `blocked` and safe messages that name only config keys, not values.

Required keys:

```text
PRODUCT_AUTH_ISSUER
PRODUCT_AUTH_AUDIENCE
WEB_APP_BASE_URL
API_BASE_URL
SSE_BASE_URL
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET_REF
GOOGLE_OAUTH_CALLBACK_URL
APP_KMS_KEY_ID
TENANT_TABLE_NAME
OAUTH_TOKEN_TABLE_NAME
SESSION_SECRET_TABLE_NAME
CONSENT_GRANT_TABLE_NAME
RESOURCE_SESSION_TABLE_NAME
PROPOSED_ACTION_TABLE_NAME
SESSION_EVENT_TABLE_NAME
PLATFORM_PROVIDER_SECRET_REF_OPENAI
PLATFORM_PROVIDER_SECRET_REF_ANTHROPIC
PLATFORM_PROVIDER_DEFAULT
SESSION_SECRET_TTL_HOURS
PROPOSED_ACTION_TTL_HOURS
SSE_HEARTBEAT_SECONDS
SSE_REPLAY_WINDOW_SECONDS
ALLOWED_ORIGINS
TRUSTED_USER_MODE
```

Public URL and callback URL values must use HTTPS for deployable trusted-user
stacks. `TRUSTED_USER_MODE` must be `true`. Secret-bearing values are
references such as ARNs or aliases, not plaintext credentials. Service task
definitions receive resource-derived table names and the shared app KMS key
reference from the stack.

For local development:

1. Start the owning services with their repo-local commands.
2. Set the config keys above to local or deployed service endpoints as
   appropriate for the trusted-user run.
3. Run `npm test` to validate config inventory and stack assertions.
4. Run `npm run synth` to synthesize both `dev` and `prod`.

Deployment order for a real-flow environment:

1. Validate shared contracts and service route expectations.
2. Deploy or synth infra tables, the shared KMS app key, HTTP route
   integrations, SSE ALB, service runtimes, logs, metrics, and alarms.
3. Start or deploy auth, secrets, context, Google Docs adapter, session events,
   orchestration, and provider adapter services with the config keys above.
4. Run service repo checks and the deterministic integration harness.
5. Run opt-in live smoke only with controlled trusted-user credentials and a
   controlled Google Doc.

Pipeline task shape:

- synth and diff each deployment target from the typed target list
- validate environment parameters before deployment
- check least-privilege IAM/KMS policies and stage-safe resource names
- run migrations only after table/key changes are visible
- run deterministic smoke checks before any live dependency checks
- keep rollback notes tied to stack names, resource prefixes, and runbooks

## Operational Guardrails

The stack config includes:

- API Gateway throttling for auth/OAuth, provider, command, context preview,
  SSE, action review, and apply paths.
- Metadata-only API access logs. Request/response bodies are not configured for
  logging.
- Safe audit event inventories for OAuth, provider, Google Docs, SSE, and apply
  paths.
- CloudWatch metric and alarm inventory for OAuth errors, provider
  availability, provider token usage, Google Docs errors, SSE errors, apply
  conflicts, apply failures, KMS failures, DynamoDB throttling, and rate-limit
  decisions.
- Runbook notes for OAuth reconnect spikes, provider quota/unavailability,
  Google Docs connector errors, SSE failures, repeated apply conflicts, KMS
  failure, DynamoDB throttling, and rate-limit misconfiguration.

Forbidden log material includes prompts, document text, selected text, model
responses, provider keys, OAuth tokens, authorization headers, cookies, and
decrypted action payloads.

## Task Breakdown

Implementation tasks are tracked in [TASKS.md](TASKS.md). Update the checkboxes there in the same change that implements or verifies a task.

## Testing And Coverage

Install repo-local tooling:

```sh
npm install
```

Run the TypeScript build and assertion tests:

```sh
npm test
```

Run a local CDK synth:

```sh
npm run synth
```

View the built-in coverage report in the terminal:

```sh
npm run coverage
```

The coverage command uses Node's built-in test runner and prints a text report. If later tooling writes HTML, LCOV, TAP, JUnit, or build output, those generated paths are ignored by `.gitignore`.
