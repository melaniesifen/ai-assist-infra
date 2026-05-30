import test from "node:test";
import assert from "node:assert/strict";
import { getDynamoDbTableSpec, listDynamoDbTableSpecs } from "../src/dynamodb-tables.js";

test("defines session secrets with ttl and encrypted secret field", () => {
  const spec = getDynamoDbTableSpec("SessionSecrets");

  assert.equal(spec.partitionKey, "tenantId");
  assert.equal(spec.sortKey, "userId#provider#secretId");
  assert.equal(spec.defaultTtlHours, 8);
  assert.deepEqual(spec.encryptedFields, ["encryptedSecret"]);
});

test("defines proposed actions with 24 hour ttl and encrypted payload", () => {
  const spec = getDynamoDbTableSpec("ProposedActions");

  assert.equal(spec.defaultTtlHours, 24);
  assert.ok(spec.attributes.includes("originalTextHash"));
  assert.ok(spec.encryptedFields.includes("encryptedPayload"));
});

test("can exclude optional session events table", () => {
  const names = listDynamoDbTableSpecs({ includeOptional: false }).map((spec) => spec.name);

  assert.equal(names.includes("SessionEvents"), false);
  assert.equal(names.includes("ResourceSessions"), true);
});
