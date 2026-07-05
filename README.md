# ai-assist-infra

TypeScript CDK infrastructure app for the AI Assist Platform.

This repo owns the deployable infrastructure shape plus the typed inventories
used by assertion tests. The previous dependency-light Node.js ESM bootstrap has
been superseded by a repo-local TypeScript CDK app while preserving the route,
DynamoDB, KMS, IAM boundary, and rate-limit contracts.

## Current Contents

- `bin/ai-assist-infra.ts`: CDK app entry point.
- `src/stacks/ai-assist-product-auth-stack.ts`: target-scoped Cognito User Pool, public app client, owner/member groups, and product-auth outputs.
- `src/stacks/ai-assist-infra-stack.ts`: MVP runtime stack with HTTP route integrations, a shared CDK-built dogfood Fargate runtime, a private API ALB for API Gateway VPC link traffic, a public HTTPS ALB for SSE, DynamoDB tables, one shared app KMS key per target, IAM roles, and default API throttling.
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
- A target-scoped product-auth stack with Cognito User Pool, public app client, owner/member groups, issuer/audience/user-pool outputs, and HTTP API command routes in the runtime stack that import those values for Cognito/OIDC JWT authorizer wiring.
- A target-scoped Cognito Hosted UI domain and public OAuth app-client configuration for the browser extension login path, including callback/logout URL outputs for ignored extension runtime config.
- Public HTTPS ALB hosting for browser `EventSource` SSE streams on the same runtime path.
- Static web app hosting for the target `WebAppBaseUrl` host using a private S3
  assets bucket, CloudFront, a CloudFront ACM certificate, and Route 53 alias
  DNS. The bucket is intentionally empty until `ai-assist-web/dist` assets are
  built and uploaded as a deployment handoff.
- Service IAM roles with table and KMS grants derived from the IAM boundary matrix.
- Generated Secrets Manager secrets for dogfood product-session HMAC signing,
  Google OAuth state signing, trusted-user bootstrap login, and the Google
  OAuth client secret reference, plus platform provider credential references
  for OpenAI and Anthropic.
- A shared dogfood runtime task role with the union of current MVP service data-plane grants; per-service IAM roles remain synthesized for ownership boundaries and future runtime split-out.
- Default API Gateway throttling based on the route rate-limit tiers.

The only intentionally placeholder-backed route is `GET /health`. Trusted-user
MVP command routes synthesize with service integrations. The SSE stream route is
owned by the public ALB path instead of API Gateway so browser `EventSource`
can use long-lived responses.

This repo owns infrastructure shape, not application business logic. Service
repos remain responsible for safe logging, authentication checks, context
authorization, and secret-free responses.

## M10 Dogfood Product Surface

For M10, the primary owner dogfood UI is the Google Docs side-panel/browser
extension shell in `ai-assist-web/extension`, loaded while the owner is on a
real Google Docs document. The static web origin configured by `WebAppBaseUrl`,
including `https://dev.melsifen-ai-assist.com` for dev, is supporting
infrastructure for OAuth redirects, hosted assets, diagnostics, or fallback
setup. It is not the primary in-document dogfood UI.

The dev extension uses the deployed HTTP API output and public SSE base URL:

- HTTP: use the deployed dev HTTP API base URL from stack output or ignored local extension config.
- SSE: `https://sse.dev.melsifen-ai-assist.com`

Endpoint locations are public browser runtime metadata, not credentials, but
the concrete API Gateway host should stay out of tracked files. Do not place
bootstrap secrets, bearer tokens, OAuth tokens, provider keys, cookies, raw
document content, or local-only deployed endpoint values in CDK context,
frontend build variables, static assets, extension config, CloudFront objects,
or logs.

The shared dogfood runtime role is a deliberate cost-control exception for this
single-task topology. It keeps service-owned IAM roles synthesized as boundary
documentation and future split-out targets, but the deployed dogfood task uses a
union of current MVP service data-plane grants. Revisit this before broad access
or when service-owned runtime isolation becomes more important than dev cost.

## Deployment Targets

The CDK app synthesizes three initial runtime targets from
`src/config/environments.ts`. Each target has a product-auth stack, a runtime
stack, and a companion `us-east-1` certificate stack for the CloudFront web
alias:

| Target | Region | Account Source | Product Auth Stack | Runtime Stack | Web Certificate Stack | Default Removal Posture |
| --- | --- | --- | --- | --- | --- | --- |
| `dev` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistDevAuthStack` | `AiAssistDevInfraStack` | `AiAssistDevWebCertificateStack` | cleanup-friendly |
| `gamma` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistGammaAuthStack` | `AiAssistGammaInfraStack` | `AiAssistGammaWebCertificateStack` | retain/protect |
| `prod` | `us-west-2` | `CDK_DEFAULT_ACCOUNT` | `AiAssistProdAuthStack` | `AiAssistProdInfraStack` | `AiAssistProdWebCertificateStack` | retain/protect |

`stage` and `staging` are accepted as aliases for `gamma`. Add later stages or
regions by editing the typed target list, not by copying stack code. Deployable
resource names include environment and region, for
example `ai-assist-dev-us-west-2-http-api`, so KMS aliases, DynamoDB table
names, API names, log groups, IAM role names, outputs, and future global
resources have stage-safe and region-safe prefixes.

Runtime physical names are also target-owned. Dev keeps the deployed
`dogfood-runtime` suffix because dev is the dogfood environment and those
resources already exist. Gamma and prod use the neutral `shared-runtime` suffix
so their physical ECS, log, and load-balancer names do not include `dogfood`.
Keep this target-level mapping in `src/config/environments.ts` instead of
scattering stage-specific string conditionals through the stack.

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
HTTP listener. The target's product-auth stack provisions the Cognito User Pool
and public app client, exposes issuer/audience/user-pool outputs, and the
runtime stack configures API Gateway JWT authorizers from those imported stack
values. Authenticated integrations forward only the
validated JWT `sub` claim as `x-ai-assist-auth-subject`; backend services map
that subject to allowed product users before deriving `tenantId` and `userId`.
Route metadata still records the owning service. The only API Gateway product-route edge auth
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
fallbacks for packages whose route adapters are not implemented yet. The SSE
route delegates to the session-events package runtime, verifies product-session
bearer identity by default, supports trusted upstream identity headers only when
`AI_ASSIST_TRUSTED_UPSTREAM_SSE_HEADERS=true`, and the shared Python wrapper
preserves long-lived stream responses, keepalive frames, and close logging. The image
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
`GOOGLE_OAUTH_CLIENT_SECRET_REF` is injected as the name of a CDK-managed
Secrets Manager secret. CDK creates the secret with a generated placeholder
value so the stack can deploy without plaintext credentials; replace that value
after deploy with the real Google OAuth client secret. Do not place the Google
client secret value in `cdk.context.json`, `.env`, shell command history, or the
ECS task definition.
`GOOGLE_OAUTH_CALLBACK_URL` is derived from the generated HTTP API endpoint as
`${API_BASE_URL}/oauth/google/callback`.
`ALLOWED_ORIGINS` includes `WebAppBaseUrl` plus the target's CDK-owned
`ProductAuthHostedUiCallbackUrls`. The auth service uses the same allowlist for
Google OAuth `redirectTarget` validation, so the sidebar can start Google OAuth
with its extension identity redirect URL and return through the browser
extension flow without putting bearer or OAuth tokens in query strings.
`PRODUCT_AUTH_ISSUER` and `PRODUCT_AUTH_AUDIENCE` are injected from the
target's CDK-managed product-auth stack. The auth stack outputs issuer,
audience, and user pool id for local client/test configuration.
`AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON` is injected from ignored deployment
context and maps Cognito subjects to allowed product tenant/user identities.
The list may be empty while deploying the product-auth stack before real
Cognito users exist; that state is a fail-closed bootstrap posture and is not
valid dogfood proof.
`PLATFORM_PROVIDER_SECRET_REF_OPENAI` and
`PLATFORM_PROVIDER_SECRET_REF_ANTHROPIC` are injected as names of CDK-managed
Secrets Manager placeholder secrets. Replace only the provider secret values you
plan to use after deploy; the default dogfood provider is
`PLATFORM_PROVIDER_DEFAULT=openai`.
`PLATFORM_PROVIDER_QUOTA_MODE=enforced` and
`PLATFORM_PROVIDER_AUDIT_MODE=metadata` are also injected for M11 multi-user
trusted dev. If either readiness mode is missing or changed, provider status and
orchestration command creation fail closed before a platform provider credential
can be used.
The shared dogfood runtime exposes `/providers` from this platform provider
metadata after verifying the product-session bearer token and does not return
secret reference names or credential values. Orchestration command requests are
also adapted in-process to use the configured platform provider access reference,
quota/audit readiness, and product-session-derived tenant/user identity; until
an explicit provider client hook is supplied, the runtime returns a structured
provider dependency error instead of calling a real model provider.
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
CDK also creates the static hosting infrastructure and Route 53 alias for the
host in `WebAppBaseUrl`. The host must be a subdomain of `HostedZoneName` and
must be different from `SseDomainName`; otherwise synth fails instead of
claiming an unresolvable app URL.
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
`ProductAuthHostedUiCallbackUrls` and `ProductAuthHostedUiLogoutUrls` are
registered on the public Cognito app client for sidebar product login. Dev may
use the local Chrome identity redirect URL and the Firefox temporary add-on
redirect URL while dogfooding. Gamma and prod must use explicit release
redirect URLs and synth rejects localhost, placeholder, or Firefox temporary
add-on values for those targets.

Copy `cdk.context.example.json` to ignored `cdk.context.json` and replace the
placeholder values for each target you plan to synthesize or deploy. CDK uses
the hosted zone values to request ACM certificates, create DNS validation, and
create Route 53 alias records for the public SSE load balancer and the static
web app CloudFront distribution. These values are not service secrets, but they
are account/environment-specific and should stay out of source control.

`edgeJwtAuthEnabled` defaults to `true`. It may be set to `false` only for the
`dev` target to run an infrastructure health deploy before real Cognito users
and allowed-user subject mappings are ready to be exercised. CDK still
provisions the product-auth stack and injects its issuer/audience into the
runtime, but the bypass removes the API Gateway JWT authorizer and leaves API Gateway routes
unauthenticated at the edge. It must not be used as evidence that the
trusted-user product loop is dogfood-ready; Cognito-backed product auth is still
required before personal end-to-end use.

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
      "productAuthHostedUiCallbackUrls": [
        "https://replace-with-chrome-extension-id.chromiumapp.org/",
        "https://replace-with-firefox-temporary-addon-id.extensions.allizom.org/"
      ],
      "productAuthHostedUiLogoutUrls": [
        "https://replace-with-chrome-extension-id.chromiumapp.org/",
        "https://replace-with-firefox-temporary-addon-id.extensions.allizom.org/"
      ],
      "edgeJwtAuthEnabled": false,
      "allowedProductUsers": [
        {
          "authSubject": "replace-with-dev-cognito-subject-a",
          "tenantId": "dev-tenant-a",
          "userId": "dev-user-a",
          "role": "owner",
          "status": "active"
        },
        {
          "authSubject": "replace-with-dev-cognito-subject-b",
          "tenantId": "dev-tenant-b",
          "userId": "dev-user-b",
          "role": "member",
          "status": "active"
        }
      ],
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
URI, auth, or certificate parameters. Deploy the target's product-auth stack
first so Cognito users can be created and their `sub` values can be copied into
ignored `cdk.context.json`; then deploy the runtime stack with its web
certificate stack so CloudFront receives a valid `us-east-1` certificate:

```sh
npm run build
npx cdk deploy AiAssistDevAuthStack
aws cognito-idp list-users \
  --user-pool-id "$(aws cloudformation describe-stacks \
    --stack-name AiAssistDevAuthStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ProductAuthUserPoolId`].OutputValue' \
    --output text)" \
  --query 'Users[].{Username:Username,Sub:Attributes[?Name==`sub`]|[0].Value,Status:UserStatus,Enabled:Enabled}' \
  --output table
npx cdk deploy AiAssistDevWebCertificateStack AiAssistDevInfraStack
```

The `aws cognito-idp list-users` command is metadata-only: it returns usernames,
subjects, status, and enabled state. Do not print, log, or commit passwords,
tokens, OAuth secrets, provider keys, or raw user credentials.

For live sidebar sign-in proof, deploy the target auth stack after
`productAuthHostedUiCallbackUrls` and `productAuthHostedUiLogoutUrls` contain
the actual extension identity redirect URLs:

```sh
npm run build
npx cdk deploy AiAssistDevAuthStack
```

Then copy these non-secret `AiAssistDevAuthStack` outputs into ignored
`ai-assist-web/extension/config.dev.json` and
`ai-assist-web/extension/firefox/config.dev.json`:

- `ProductAuthHostedUiOrigin` -> `cognitoAuthBaseUrl`
- `ProductAuthAppClientId` or `ProductAuthAudience` -> `cognitoClientId`
- one registered `ProductAuthCallbackUrls` value -> `cognitoRedirectUri`
- the matching `ProductAuthLogoutUrls` value -> `cognitoLogoutRedirectUri`
- `ProductAuthOAuthScopes` -> `cognitoScopes`
- `ProductAuthUserPoolId` and `ProductAuthIssuer` for local verification or
  diagnostics

Rebuild and reload the extension after updating ignored config:

```sh
cd ../ai-assist-web
npm run build:extension:firefox:dev
```

Load the rebuilt temporary add-on, open a Google Doc, open the AI Assist
sidebar, and sign in through Cognito Hosted UI. Google OAuth remains a separate
post-product-login step.

## Static Web App Hosting

For each deployment target, the stack creates:

- an encrypted private S3 bucket named
  `ai-assist-<target>-<region>-web-app-assets`
- a CloudFront distribution with origin access control, HTTPS redirect, security
  response headers, SPA fallback to `/index.html`, and the host from
  `WebAppBaseUrl`
- a companion ACM certificate stack in `us-east-1` for the CloudFront alias
- a Route 53 `A` alias record for the `WebAppBaseUrl` host
- outputs for `WebAppBaseUrl`, `WebAppAssetsBucketName`, and
  `WebAppDistributionId`

This slice does not build or upload frontend artifacts. After `ai-assist-web`
produces a production `dist/` directory, upload those files to the
`WebAppAssetsBucketName` output and invalidate the CloudFront distribution from
`WebAppDistributionId`. Until that handoff is performed, DNS resolves and
CloudFront is deployed, but the web app will not serve real UI assets.

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
PLATFORM_PROVIDER_QUOTA_MODE
PLATFORM_PROVIDER_AUDIT_MODE
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

The M12 owner/dev read-only summarize path has an additional disabled-by-default
provider gate. To run that path in dev, set deployment context
`platformProviderOwnerDevEnabled=true` and `platformProviderModelOpenai` to the
selected model; CDK injects those values as
`PLATFORM_PROVIDER_OWNER_DEV_ENABLED=true` and
`PLATFORM_PROVIDER_MODEL_OPENAI`. The owner/dev switch is rejected outside dev.
When either key is missing, `/providers` and command errors return
metadata-only blocker codes naming the missing configuration.

The dogfood runtime uses `CONSENT_GRANT_TABLE_NAME` as the normal source for
Google Docs active-resource context read and safe-apply consent. The old static
`AI_ASSIST_DOGFOOD_CONTEXT_CONSENT_GRANT_JSON` path is disabled by default and
is only accepted when `AI_ASSIST_DOGFOOD_CONTEXT_CONSENT_GRANT_JSON_ENABLED=true`
is set as an owner emergency override.

For the deployed dogfood runtime, CDK injects
`GOOGLE_OAUTH_CLIENT_SECRET_REF=ai-assist-<target>-<region>-google-oauth-client-secret`
and grants the task role permission to read that secret at runtime. It also
injects provider credential refs named
`ai-assist-<target>-<region>-platform-provider-openai-secret` and
`ai-assist-<target>-<region>-platform-provider-anthropic-secret`, with runtime
read access granted to the same task role.

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
