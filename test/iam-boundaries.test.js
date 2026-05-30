import test from "node:test";
import assert from "node:assert/strict";
import { formatIamBoundaryMarkdown, listIamBoundaryDocuments } from "../src/iam-boundaries.js";
import { SERVICES } from "../src/service-routes.js";

test("documents service table and KMS boundaries", () => {
  const docs = listIamBoundaryDocuments();
  const secrets = docs.find((entry) => entry.service === SERVICES.SECRETS);

  assert.deepEqual(secrets.tableAccess.map((table) => table.tableName), ["SessionSecrets"]);
  assert.ok(secrets.kmsPurposes.includes("session-secrets"));
});

test("formats IAM boundary matrix as markdown", () => {
  const markdown = formatIamBoundaryMarkdown();

  assert.match(markdown, /\| Service \| DynamoDB Tables \| KMS Purposes \| Notes \|/);
  assert.match(markdown, /ai-assist-orchestration-service/);
  assert.match(markdown, /ProposedActions/);
});
