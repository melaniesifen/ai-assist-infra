# ai-assist-infra

Dependency-light infrastructure configuration bootstrap for the AI Assist
Platform.

This repo intentionally does not install CDK yet. The current helpers capture
the environment, route, DynamoDB, KMS, rate-limit, and IAM boundary contracts in
plain Node modules with `node:test` coverage. That gives future IaC a tested
inventory to consume instead of retyping infrastructure constants in CDK stacks.

## Current Contents

- `src/environments.js`: canonical environment names and validation.
- `src/service-routes.js`: MVP HTTP/SSE route inventory and service ownership.
- `src/dynamodb-tables.js`: table key, TTL, and encryption metadata.
- `src/kms-purposes.js`: KMS purpose-to-alias mapping.
- `src/rate-limits.js`: default route rate limits and validation.
- `src/iam-boundaries.js`: least-privilege documentation matrix helpers.
- `test/*.test.js`: Node built-in tests.

## Future CDK and Amplify Migration

The architecture calls for Amplify Hosting, API Gateway HTTP APIs, an
SSE-capable route, Lambda or service compute, DynamoDB, KMS, IAM roles,
CloudWatch, and WAF/API Gateway throttling.

Recommended migration path:

1. Add CDK after package management is agreed for this repo.
2. Import these pure helpers from CDK stack code and treat tests here as the
   source of truth for route/table/key inventories.
3. Add Amplify hosting resources for `ai-assist-web`; never inject model
   provider keys or OAuth tokens into frontend config.
4. Convert the IAM boundary matrix into concrete service roles with table and
   KMS grants scoped by service ownership.
5. Keep app-level DynamoDB rate-limit counters deferred until public or broader
   tenant access requires them.

This repo owns infrastructure shape, not application business logic. Service
repos remain responsible for safe logging, authentication checks, context
authorization, and secret-free responses.

## Testing And Coverage

Run the unit tests with either command:

```sh
node --test
npm test
```

View the built-in coverage report in the terminal:

```sh
node --experimental-test-coverage --test
npm run coverage
```

The coverage command uses Node's built-in test runner and prints a text report. If later tooling writes HTML, LCOV, TAP, JUnit, or build output, those generated paths are ignored by `.gitignore`.
