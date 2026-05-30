import { DYNAMODB_TABLES } from "./dynamodb-tables.js";
import { KMS_PURPOSES } from "./kms-purposes.js";
import { SERVICES } from "./service-routes.js";

export const IAM_BOUNDARY_MATRIX = Object.freeze([
  boundary(SERVICES.AUTH, {
    tables: ["Tenants", "TenantUsers", "Users", "OAuthTokens"],
    kmsPurposes: [KMS_PURPOSES.OAUTH_TOKENS],
    notes: "Owns product identity and Google OAuth token lifecycle."
  }),
  boundary(SERVICES.SECRETS, {
    tables: ["SessionSecrets"],
    kmsPurposes: [KMS_PURPOSES.SESSION_SECRETS, KMS_PURPOSES.USER_SECRETS],
    notes: "Owns short-lived provider secret encryption and validation metadata."
  }),
  boundary(SERVICES.CONTEXT, {
    tables: ["ContextConsentGrants", "ResourceSessions"],
    kmsPurposes: [],
    notes: "Owns context consent checks and normalized context metadata."
  }),
  boundary(SERVICES.SESSION_EVENTS, {
    tables: ["SessionEvents"],
    kmsPurposes: [],
    notes: "Owns SSE delivery and optional short-lived event replay metadata."
  }),
  boundary(SERVICES.ORCHESTRATION, {
    tables: ["ResourceSessions", "ProposedActions"],
    kmsPurposes: [KMS_PURPOSES.PROPOSED_ACTIONS],
    notes: "Owns commands, proposed actions, approvals, and apply orchestration."
  }),
  boundary(SERVICES.GOOGLE_DOCS_ADAPTER, {
    tables: ["OAuthTokens"],
    kmsPurposes: [KMS_PURPOSES.OAUTH_TOKENS],
    notes: "Uses authorized Google tokens for connector reads and write-back."
  })
]);

function boundary(service, { tables, kmsPurposes, notes }) {
  return Object.freeze({
    service,
    tables: Object.freeze(tables),
    kmsPurposes: Object.freeze(kmsPurposes),
    notes
  });
}

export function listIamBoundaryDocuments() {
  return IAM_BOUNDARY_MATRIX.map((entry) => ({
    service: entry.service,
    tableAccess: entry.tables.map((tableName) => {
      const table = DYNAMODB_TABLES[tableName];
      return {
        tableName,
        partitionKey: table.partitionKey,
        sortKey: table.sortKey,
        optional: table.optional
      };
    }),
    kmsPurposes: [...entry.kmsPurposes],
    notes: entry.notes
  }));
}

export function formatIamBoundaryMarkdown() {
  const rows = listIamBoundaryDocuments().map((entry) => {
    const tables = entry.tableAccess.map((table) => table.tableName).join(", ") || "None";
    const keys = entry.kmsPurposes.join(", ") || "None";
    return `| ${entry.service} | ${tables} | ${keys} | ${entry.notes} |`;
  });

  return [
    "| Service | DynamoDB Tables | KMS Purposes | Notes |",
    "| --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}
