# ai-assist-infra

TypeScript CDK infrastructure app for the AI Assist Platform.

This repo owns the deployable infrastructure shape plus the typed inventories
used by assertion tests. The previous dependency-light Node.js ESM bootstrap has
been superseded by a repo-local TypeScript CDK app while preserving the route,
DynamoDB, KMS, IAM boundary, and rate-limit contracts.

## Current Contents

- `bin/ai-assist-infra.ts`: CDK app entry point.
- `src/stacks/ai-assist-infra-stack.ts`: MVP stack with HTTP/SSE route inventory, DynamoDB tables, KMS keys, IAM roles, and default API throttling.
- `src/config/*.ts`: typed environment, route, DynamoDB, KMS, rate-limit, and IAM boundary inventories.
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
