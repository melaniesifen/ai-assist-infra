# ai-assist-infra

TypeScript CDK infrastructure app for the AI Assist Platform.

This repo owns the deployable infrastructure shape plus the typed inventories
used by assertion tests. The previous dependency-light Node.js ESM bootstrap has
been superseded by a repo-local TypeScript CDK app while preserving the route,
DynamoDB, KMS, IAM boundary, and rate-limit contracts.

## Current Contents

- `bin/ai-assist-infra.ts`: CDK app entry point.
- `src/stacks/ai-assist-infra-stack.ts`: MVP stack with HTTP/SSE route inventory, DynamoDB tables, KMS keys, IAM roles, and default API throttling.
- `src/config/*.ts`: typed deployment target, runtime config, route, DynamoDB, KMS, rate-limit, IAM boundary, and operational guardrail inventories.
- `test/*.test.ts`: Node built-in tests plus CDK assertion tests.
- `cdk.json`, `tsconfig.json`, `package.json`, and `package-lock.json`: repo-local CDK and TypeScript tooling.

## Stack Scope

The current CDK app creates:

- KMS keys and aliases for OAuth tokens, session secrets, proposed actions, and future user secrets.
- DynamoDB tables for tenants, users, OAuth tokens, session secrets, consent grants, resource sessions, proposed actions, and optional session event replay metadata.
- HTTP API route inventory for MVP command routes and the SSE session event route.
- Service IAM roles with table and KMS grants derived from the IAM boundary matrix.
- Default API Gateway throttling based on the route rate-limit tiers.

The route inventory intentionally does not wire service integrations or route
authorizers yet. Those remain pending tasks so service endpoints and auth
integration can be implemented with the owning services.

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
- SSE events: `GET /resource-sessions/{sessionId}/events`
- action review: `GET /resource-sessions/{sessionId}/actions`, approve, reject
- apply-action: `POST /resource-sessions/{sessionId}/apply-action`

Routes currently synthesize as deployable inventory without service integrations
or authorizers. Owning service repos still own auth semantics, command behavior,
SSE event payloads, and action state transitions.

## Local Real-Flow Config

`src/config/runtime-config.ts` defines the required env/config surface for the
trusted-user real-flow stack. Missing or invalid config must fail closed with
setup status `blocked` and safe messages that name only config keys, not values.

Required keys:

```text
AI_ASSIST_PRODUCT_AUTH_ISSUER
AI_ASSIST_PRODUCT_AUTH_AUDIENCE
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET_ARN
GOOGLE_OAUTH_REDIRECT_URI
AI_ASSIST_TOKEN_KMS_KEY_ALIAS
AI_ASSIST_PLATFORM_PROVIDER_SECRET_ARN
AI_ASSIST_AUTH_SERVICE_URL
AI_ASSIST_SECRETS_SERVICE_URL
AI_ASSIST_CONTEXT_SERVICE_URL
AI_ASSIST_ORCHESTRATION_SERVICE_URL
AI_ASSIST_SESSION_EVENTS_SERVICE_URL
AI_ASSIST_GOOGLE_DOCS_ADAPTER_URL
AI_ASSIST_ALLOWED_CORS_ORIGINS
AI_ASSIST_TRUSTED_USER_MODE
```

Service URL and redirect URI values must use HTTPS for deployable trusted-user
stacks. `AI_ASSIST_TRUSTED_USER_MODE` must be `true`. Secret-bearing values are
references such as ARNs or aliases, not plaintext credentials.

For local development:

1. Start the owning services with their repo-local commands.
2. Set the config keys above to local or deployed service endpoints as
   appropriate for the trusted-user run.
3. Run `npm test` to validate config inventory and stack assertions.
4. Run `npm run synth` to synthesize both `dev` and `prod`.

Deployment order for a real-flow environment:

1. Validate shared contracts and service route expectations.
2. Deploy or synth infra tables, KMS keys, route inventory, logs, metrics, and
   alarms.
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
