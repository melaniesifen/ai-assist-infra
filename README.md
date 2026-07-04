# ai-assist-infra

TypeScript CDK infrastructure app for the AI Assist Platform.

This repo owns the deployable infrastructure shape plus the typed inventories
used by assertion tests. The previous dependency-light Node.js ESM bootstrap has
been superseded by a repo-local TypeScript CDK app while preserving the route,
DynamoDB, KMS, IAM boundary, and rate-limit contracts.

## Current Contents

- `bin/ai-assist-infra.ts`: CDK app entry point.
- `src/stacks/ai-assist-infra-stack.ts`: MVP stack with HTTP route integrations, a shared CDK-built dogfood Fargate runtime, a private API ALB for API Gateway VPC link traffic, a public HTTPS ALB for SSE, DynamoDB tables, one shared app KMS key per target, IAM roles, and default API throttling.
- `docker/python-service/`: shared Python service image build context. The image
  installs and compiles the selected service package, serves a metadata-only
  `/health` endpoint, and delegates product routes to a service-provided
  `http_app.handle_http_request` when present; otherwise unimplemented product
  routes return a safe `501`.
- `src/config/*.ts`: typed deployment target, runtime config, route, DynamoDB, KMS, rate-limit, IAM boundary, and operational guardrail inventories.
- `test/*.test.ts`: Node built-in tests plus CDK assertion tests.
- `cdk.json`, `tsconfig.json`, `package.json`, and `package-lock.json`: repo-local CDK and TypeScript tooling.

## Stack Scope

The current CDK app creates:

- One shared customer-managed KMS app key and alias per deployment target for OAuth tokens, session secrets, proposed actions, and future user secrets.
- DynamoDB tables for tenants, users, OAuth tokens, session secrets, consent grants, resource sessions, proposed actions, and optional session event replay metadata.
- HTTP API command routes with JWT authorizer wiring and VPC link integrations through an internal ALB to one shared dogfood ECS/Fargate runtime.
- Public HTTPS ALB hosting for browser `EventSource` SSE streams on the same runtime path.
- Service IAM roles with table and KMS grants derived from the IAM boundary matrix.
- Generated Secrets Manager secrets for dogfood product-session HMAC signing
  Google OAuth state signing, and trusted-user bootstrap login.
- A shared dogfood runtime task role with the union of current MVP service data-plane grants; per-service IAM roles remain synthesized for ownership boundaries and future runtime split-out.
- Default API Gateway throttling based on the route rate-limit tiers.

The only intentionally placeholder-backed route is `GET /health`. Trusted-user
MVP command routes synthesize with service integrations. The SSE stream route is
owned by the public ALB path instead of API Gateway so browser `EventSource`
can use long-lived responses.

This repo owns infrastructure shape, not application business logic. Service
repos remain responsible for safe logging, authentication checks, context
authorization, and secret-free responses.

The shared dogfood runtime role is a deliberate cost-control exception for this
single-task topology. It keeps service-owned IAM roles synthesized as boundary
documentation and future split-out targets, but the deployed dogfood task uses a
union of current MVP service data-plane grants. Revisit this before broad access
or when service-owned runtime isolation becomes more important than dev cost.

## Deployment Targets

The CDK app synthesizes exactly three initial targets from
`src/config/environments.ts`:

| Target | Region | Account Source | Stack | Default Removal Posture |
| --- | --- | --- | --- | --- |
| `dev` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistDevInfraStack` | cleanup-friendly |
| `gamma` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistGammaInfraStack` | retain/protect |
| `prod` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistProdInfraStack` | retain/protect |

`stage` and `staging` are accepted as aliases for `gamma`. Add later stages or
regions by editing the typed target list, not by copying stack code. Deployable
resource names include environment and region, for
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

- product auth/session: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`
- Google OAuth: `POST /oauth/google/start`, `GET /oauth/google/callback`,
  `GET /oauth/google/status`, `DELETE /oauth/google/connection`
- setup status: `GET /setup/status`
- provider availability and BYO session-secret status
- Google Docs resource listing
- resource-session create/read
- context mode and context preview
- command creation
- SSE events on the public ALB: `GET /sessions/{sessionId}/events`
- action review: `GET /resource-sessions/{sessionId}/actions`, approve, reject
- apply-action: `POST /resource-sessions/{sessionId}/apply-action`

HTTP command routes synthesize with API Gateway JWT authorization, VPC link
integrations, request/correlation ID header propagation, and one shared ALB
HTTP listener. Authenticated integrations overwrite trusted tenant and user
headers from validated JWT claims (`tenant_id` and `user_id`) before forwarding
to the runtime. Route metadata still records the owning service. The only API Gateway product-route edge auth
exceptions are `POST /auth/login` and `GET /oauth/google/callback`: login is
the trusted-user bootstrap boundary, and the Google callback cannot carry the
browser's bearer token from Google's redirect. The auth service must validate
the signed OAuth state, replay guard, tenant/user binding, and callback URL
before accepting callback traffic. `GET /health` is the only intentionally
placeholder-backed route.

The CDK JWT authorizer requires a product auth issuer and audience from ignored
deployment context. The issuer must be an HTTPS OIDC-compatible issuer whose
JWKS is discoverable by API Gateway from the issuer metadata; the audience must
match the bearer tokens used by trusted users. This repo only wires the edge
authorizer. Owning service repos still own command behavior, service-side
authZ, session validation, SSE event payloads, and action state transitions.

The API Gateway command path uses a private ALB listener reachable only from the
HTTP API VPC link security group. The public SSE path uses the public ALB HTTPS
listener, a 900 second idle
timeout, shared dogfood runtime service logs, health checks, and generic SSE config:
`SSE_HEARTBEAT_SECONDS=25` and `SSE_REPLAY_WINDOW_SECONDS=300`.

## Service Image Assets

Runtime images are CDK Docker image assets, not manually supplied image URI
parameters. `cdk deploy` builds and publishes images through the CDK asset
pipeline from the workspace source tree.

Current service image inputs are defined in `src/config/container-assets.ts`.
The dogfood runtime image uses `docker/dogfood-runtime/Dockerfile`, installs all
current MVP service packages from their workspace repos, and exposes the
`ai_assist_dogfood_runtime.http_app` dispatcher as the container HTTP adapter.
The dispatcher maps method/path to the owning service package, delegates to a
package `http_app.handle_http_request` when present, and returns explicit safe
fallbacks for packages whose route adapters are not implemented yet. The image
uses `python:3.13-slim-bookworm`, never `latest`, compiles source during image
build, runs as UID/GID `65534`, and exposes `SERVICE_PORT=8080`.

This removes the old deploy-time parameters:

```text
AiAssistAuthServiceImageUri
AiAssistSecretsServiceImageUri
AiAssistOrchestrationServiceImageUri
AiAssistSessionEventsServiceImageUri
AiAssistContextServiceImageUri
AiAssistGoogleDocsAdapterImageUri
SessionEventsSseImageUri
```

Environment identity/config values come from local CDK context, not
CloudFormation parameters:

```text
HostedZoneId
HostedZoneName
SseDomainName
EdgeJwtAuthEnabled
ProductAuthIssuer
ProductAuthAudience
TrustedUserTenantId
TrustedUserUserId
TrustedUserAuthSubject
WebAppBaseUrl
GoogleOAuthClientId
```

`ProductAuthAudience` is also injected into the shared dogfood runtime as
`PRODUCT_AUTH_AUDIENCE` so the auth adapter can issue and verify product-session
tokens for the target environment.

`PRODUCT_AUTH_HMAC_SECRET` is generated by CDK as a target-scoped Secrets
Manager secret and injected into the dogfood ECS task as an ECS secret. Do not
place the HMAC value in `cdk.context.json`, `.env`, or shell command history.
`OAUTH_STATE_SIGNING_SECRET` follows the same generated-secret pattern for
Google OAuth state signing.
`TRUSTED_USER_BOOTSTRAP_SECRET` is also generated and injected as an ECS secret;
retrieve it from Secrets Manager when you need to call `/auth/login` in the
trusted-user dev stack.
`TrustedUserTenantId` is injected as `TRUSTED_USER_TENANT_ID`; it is not a
secret, but it should be stable for a target so issued sessions and stored
tenant-scoped records agree on the same tenant identifier.
`TrustedUserUserId` is injected as `TRUSTED_USER_USER_ID` and should also remain
stable for the target's dogfood user.
`TrustedUserAuthSubject` is injected as `TRUSTED_USER_AUTH_SUBJECT`; in trusted
bootstrap mode it can be a stable local subject such as `trusted-user:dev-user`.
`WebAppBaseUrl` is injected as `WEB_APP_BASE_URL` and should be the HTTPS origin
where the target's web app is hosted, for example
`https://dev.example.test` for dev dogfood.
`ALLOWED_ORIGINS` is derived from `WebAppBaseUrl` for dogfood and injected into
the runtime to keep CORS/redirect origin checks aligned with the web app URL.
`API_BASE_URL` is not a local context value; CDK derives it from the generated
HTTP API endpoint and injects it into the dogfood runtime.
`SSE_BASE_URL` is also derived by CDK from `SseDomainName` and injected into the
dogfood runtime.
`GoogleOAuthClientId` is injected as `GOOGLE_OAUTH_CLIENT_ID`. It is OAuth app
configuration rather than a credential secret, but the real environment value
belongs in ignored `cdk.context.json`; committed examples should use
placeholders.

Copy `cdk.context.example.json` to ignored `cdk.context.json` and replace the
placeholder values for each target you plan to synthesize or deploy. CDK uses
the hosted zone values to request an ACM certificate, create DNS validation, and
create the Route 53 alias record for the public SSE load balancer. These values
are not service secrets, but they are account/environment-specific and should
stay out of source control.

`edgeJwtAuthEnabled` defaults to `true`. It may be set to `false` only for the
`dev` target to run an infrastructure health deploy before a real product auth
issuer exists. `productAuthAudience` is still required because the dogfood auth
runtime uses it for product-session tokens. That bypass removes the API Gateway
JWT authorizer and leaves API Gateway routes unauthenticated at the edge. It
must not be used as evidence that the trusted-user product loop is dogfood-ready;
Cognito or another real product auth issuer is still required before personal
end-to-end use.

Security notes:

- CDK image assets use content-addressed asset tags instead of mutable
  hand-picked ECR image tags.
- Fargate services synthesize with platform version `LATEST`.
- Enable ECR enhanced scanning on the account/region bootstrap repository
  before deploying trusted-user stacks.
- Do not deploy from stale local worktrees; rebuild and synth from the current
  commit.

Example local context shape:

```json
{
  "aiAssistDeploymentConfig": {
    "dev": {
      "hostedZoneId": "Z1234567890ABC",
      "hostedZoneName": "example.test",
      "sseDomainName": "sse.dev.example.test",
      "edgeJwtAuthEnabled": false,
      "productAuthIssuer": "https://auth.dev.example.test/",
      "productAuthAudience": "ai-assist-dev",
      "trustedUserTenantId": "dev-tenant",
      "trustedUserUserId": "dev-user",
      "trustedUserAuthSubject": "trusted-user:dev-user",
      "webAppBaseUrl": "https://dev.example.test",
      "googleOAuthClientId": "dev-google-client-id.apps.googleusercontent.com"
    }
  }
}
```

After local context is populated, the deploy command does not need service image
URI, auth, or certificate parameters:

```sh
npm run build
npx cdk deploy AiAssistDevInfraStack
```

## Local Real-Flow Config

`src/config/runtime-config.ts` defines the required env/config surface for the
trusted-user real-flow stack. Missing or invalid config must fail closed with
setup status `blocked` and safe messages that name only config keys, not values.

Required keys:

```text
PRODUCT_AUTH_ISSUER
PRODUCT_AUTH_AUDIENCE
PRODUCT_AUTH_HMAC_SECRET
TRUSTED_USER_BOOTSTRAP_SECRET
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
stacks, and `GOOGLE_OAUTH_CALLBACK_URL` must resolve to
`${API_BASE_URL}/oauth/google/callback`. `TRUSTED_USER_MODE` must be `true`.
Secret-bearing values are references such as ARNs or aliases, not plaintext
credentials. Service task definitions receive resource-derived table names and
the shared app KMS key reference from the stack.

For local development:

1. Start the owning services with their repo-local commands.
2. Set the config keys above to local or deployed service endpoints as
   appropriate for the trusted-user run.
3. Run `npm test` to validate config inventory and stack assertions.
4. Run `npm run synth` to synthesize `dev`, `gamma`, and `prod`.

Deployment order for a real-flow environment:

1. Validate shared contracts and service route expectations.
2. Deploy or synth infra tables, the shared KMS app key, HTTP route
   integrations, shared ALB/runtime path, logs, metrics, and alarms.
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
- Dashboard and alarm resources are omitted in `dev` to keep the baseline
  cheaper. `gamma` and `prod` synthesize the full dashboard and alarm guardrails.
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
