import { DYNAMODB_TABLES, DynamoDbTableSpec } from "./dynamodb-tables";
import { KMS_PURPOSES, KmsPurpose } from "./kms-purposes";
import { SERVICES, ServiceName } from "./service-routes";

export const DYNAMODB_ACCESS_LEVELS = Object.freeze({
  READ: "read",
  WRITE: "write"
} as const);

export type DynamoDbAccessLevel = (typeof DYNAMODB_ACCESS_LEVELS)[keyof typeof DYNAMODB_ACCESS_LEVELS];

export const KMS_ACCESS_LEVELS = Object.freeze({
  DESCRIBE: "describe",
  ENCRYPT: "encrypt",
  DECRYPT: "decrypt",
  GENERATE_DATA_KEY: "generate-data-key",
  REENCRYPT: "reencrypt"
} as const);

export type KmsAccessLevel = (typeof KMS_ACCESS_LEVELS)[keyof typeof KMS_ACCESS_LEVELS];

export interface TableAccessBoundary {
  readonly table: string;
  readonly access: readonly DynamoDbAccessLevel[];
}

export interface KmsAccessBoundary {
  readonly purpose: KmsPurpose;
  readonly access: readonly KmsAccessLevel[];
}

export interface IamBoundary {
  readonly service: ServiceName;
  readonly tableAccess: readonly TableAccessBoundary[];
  readonly kmsAccess: readonly KmsAccessBoundary[];
  readonly notes: string;
}

export interface IamBoundaryDocument {
  readonly service: ServiceName;
  readonly tableAccess: Array<Pick<DynamoDbTableSpec, "partitionKey" | "sortKey" | "optional"> & { readonly tableName: string; readonly access: readonly DynamoDbAccessLevel[] }>;
  readonly kmsPurposes: readonly KmsPurpose[];
  readonly kmsAccess: readonly KmsAccessBoundary[];
  readonly notes: string;
}

export const IAM_BOUNDARY_MATRIX: readonly IamBoundary[] = Object.freeze([
  boundary(SERVICES.AUTH, {
    tableAccess: [
      readWriteTable("Tenants"),
      readWriteTable("TenantUsers"),
      readWriteTable("Users"),
      readWriteTable("OAuthTokens")
    ],
    kmsAccess: [encryptDecryptKey(KMS_PURPOSES.OAUTH_TOKENS)],
    notes: "Owns product identity and Google OAuth token lifecycle."
  }),
  boundary(SERVICES.SECRETS, {
    tableAccess: [readWriteTable("SessionSecrets")],
    kmsAccess: [encryptDecryptKey(KMS_PURPOSES.SESSION_SECRETS), encryptDecryptKey(KMS_PURPOSES.USER_SECRETS)],
    notes: "Owns short-lived provider secret encryption and validation metadata."
  }),
  boundary(SERVICES.CONTEXT, {
    tableAccess: [readWriteTable("ContextConsentGrants"), readWriteTable("ResourceSessions")],
    kmsAccess: [],
    notes: "Owns context consent checks and normalized context metadata."
  }),
  boundary(SERVICES.SESSION_EVENTS, {
    tableAccess: [readWriteTable("SessionEvents")],
    kmsAccess: [],
    notes: "Owns SSE delivery and optional short-lived event replay metadata."
  }),
  boundary(SERVICES.ORCHESTRATION, {
    tableAccess: [readWriteTable("ResourceSessions"), readWriteTable("ProposedActions")],
    kmsAccess: [encryptDecryptKey(KMS_PURPOSES.PROPOSED_ACTIONS)],
    notes: "Owns commands, proposed actions, approvals, and apply orchestration."
  }),
  boundary(SERVICES.GOOGLE_DOCS_ADAPTER, {
    tableAccess: [readOnlyTable("OAuthTokens")],
    kmsAccess: [decryptOnlyKey(KMS_PURPOSES.OAUTH_TOKENS)],
    notes: "Uses authorized Google tokens for connector reads and write-back."
  })
]);

function boundary(service: ServiceName, { tableAccess, kmsAccess, notes }: Omit<IamBoundary, "service">): IamBoundary {
  return Object.freeze({
    service,
    tableAccess: Object.freeze([...tableAccess]),
    kmsAccess: Object.freeze([...kmsAccess]),
    notes
  });
}

export function listIamBoundaryDocuments(): IamBoundaryDocument[] {
  return IAM_BOUNDARY_MATRIX.map((entry) => ({
    service: entry.service,
    tableAccess: entry.tableAccess.map((accessBoundary) => {
      const table = DYNAMODB_TABLES[accessBoundary.table as keyof typeof DYNAMODB_TABLES];
      return {
        tableName: accessBoundary.table,
        access: [...accessBoundary.access],
        partitionKey: table.partitionKey,
        sortKey: table.sortKey,
        optional: table.optional
      };
    }),
    kmsPurposes: entry.kmsAccess.map((accessBoundary) => accessBoundary.purpose),
    kmsAccess: entry.kmsAccess.map((accessBoundary) => ({ purpose: accessBoundary.purpose, access: [...accessBoundary.access] })),
    notes: entry.notes
  }));
}

export function formatIamBoundaryMarkdown(): string {
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

function readOnlyTable(table: string): TableAccessBoundary {
  return Object.freeze({ table, access: Object.freeze([DYNAMODB_ACCESS_LEVELS.READ]) });
}

function readWriteTable(table: string): TableAccessBoundary {
  return Object.freeze({ table, access: Object.freeze([DYNAMODB_ACCESS_LEVELS.READ, DYNAMODB_ACCESS_LEVELS.WRITE]) });
}

function decryptOnlyKey(purpose: KmsPurpose): KmsAccessBoundary {
  return Object.freeze({ purpose, access: Object.freeze([KMS_ACCESS_LEVELS.DESCRIBE, KMS_ACCESS_LEVELS.DECRYPT]) });
}

function encryptDecryptKey(purpose: KmsPurpose): KmsAccessBoundary {
  return Object.freeze({
    purpose,
    access: Object.freeze([
      KMS_ACCESS_LEVELS.DESCRIBE,
      KMS_ACCESS_LEVELS.ENCRYPT,
      KMS_ACCESS_LEVELS.DECRYPT,
      KMS_ACCESS_LEVELS.GENERATE_DATA_KEY,
      KMS_ACCESS_LEVELS.REENCRYPT
    ])
  });
}
