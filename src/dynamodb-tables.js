export const DYNAMODB_TABLES = Object.freeze({
  Tenants: table("Tenants", "tenantId", null, {
    attributes: ["tenantId", "name", "createdAt", "updatedAt", "status"]
  }),
  TenantUsers: table("TenantUsers", "tenantId", "userId", {
    attributes: ["tenantId", "userId", "role", "status", "createdAt", "updatedAt"]
  }),
  Users: table("Users", "userId", null, {
    attributes: ["userId", "email", "displayName", "createdAt", "updatedAt", "status", "defaultTenantId", "providerKeyMode"]
  }),
  OAuthTokens: table("OAuthTokens", "tenantId", "userId#provider", {
    attributes: ["tenantId", "userId", "provider", "encryptedAccessToken", "encryptedRefreshToken", "expiresAt", "scopes", "createdAt", "updatedAt"],
    encryptedFields: ["encryptedAccessToken", "encryptedRefreshToken"]
  }),
  SessionSecrets: table("SessionSecrets", "tenantId", "userId#provider#secretId", {
    attributes: ["tenantId", "userId", "provider", "secretId", "encryptedSecret", "fingerprint", "createdAt", "lastValidatedAt", "expiresAt", "ttl"],
    ttlAttribute: "ttl",
    defaultTtlHours: 8,
    encryptedFields: ["encryptedSecret"]
  }),
  ContextConsentGrants: table("ContextConsentGrants", "tenantId", "userId#provider#contextMode#grantId", {
    attributes: ["tenantId", "userId", "provider", "contextMode", "resourceRef", "workspaceBoundary", "scopes", "status", "grantedAt", "revokedAt", "expiresAt", "ttl"],
    ttlAttribute: "ttl"
  }),
  ResourceSessions: table("ResourceSessions", "tenantId", "sessionId", {
    attributes: ["sessionId", "userId", "tenantId", "provider", "resourceType", "resourceId", "title", "capabilities", "createdAt", "updatedAt", "lastActiveAt", "status"]
  }),
  ProposedActions: table("ProposedActions", "tenantId", "actionId", {
    attributes: ["actionId", "tenantId", "userId", "sessionId", "provider", "resourceId", "resourceRevision", "targetAnchor", "targetRange", "originalTextHash", "actionType", "encryptedPayload", "status", "idempotencyKey", "createdAt", "expiresAt", "ttl"],
    ttlAttribute: "ttl",
    defaultTtlHours: 24,
    encryptedFields: ["encryptedPayload"]
  }),
  SessionEvents: table("SessionEvents", "tenantId", "sessionId#createdAt#eventId", {
    optional: true,
    attributes: ["tenantId", "sessionId", "createdAt", "eventId", "eventType", "encryptedPayload", "ttl"],
    ttlAttribute: "ttl",
    encryptedFields: ["encryptedPayload"]
  })
});

function table(name, partitionKey, sortKey, options = {}) {
  return Object.freeze({
    name,
    partitionKey,
    sortKey,
    ttlAttribute: options.ttlAttribute ?? null,
    defaultTtlHours: options.defaultTtlHours ?? null,
    encryptedFields: Object.freeze(options.encryptedFields ?? []),
    attributes: Object.freeze(options.attributes ?? []),
    optional: options.optional === true
  });
}

export function listDynamoDbTableSpecs({ includeOptional = true } = {}) {
  return Object.values(DYNAMODB_TABLES)
    .filter((spec) => includeOptional || !spec.optional)
    .map((spec) => cloneSpec(spec));
}

export function getDynamoDbTableSpec(name) {
  const spec = DYNAMODB_TABLES[name];
  if (!spec) {
    throw new Error(`unknown DynamoDB table: ${name}`);
  }

  return cloneSpec(spec);
}

function cloneSpec(spec) {
  return {
    ...spec,
    encryptedFields: [...spec.encryptedFields],
    attributes: [...spec.attributes]
  };
}
