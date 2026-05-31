import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { DYNAMODB_TABLES, DynamoDbTableSpec, listDynamoDbTableSpecs } from "../config/dynamodb-tables";
import { buildEnvironmentResourceName, normalizeEnvironmentName } from "../config/environments";
import { DYNAMODB_ACCESS_LEVELS, IAM_BOUNDARY_MATRIX, KMS_ACCESS_LEVELS } from "../config/iam-boundaries";
import { KMS_PURPOSES, KmsPurpose, getKmsAlias, listKmsPurposeMappings } from "../config/kms-purposes";
import { buildDefaultRouteRateLimits } from "../config/rate-limits";
import { SERVICE_ROUTES } from "../config/service-routes";

export interface AiAssistInfraStackProps extends cdk.StackProps {
  readonly environmentName?: string;
}

export class AiAssistInfraStack extends cdk.Stack {
  public readonly tables: Readonly<Record<string, dynamodb.Table>>;
  public readonly keys: Readonly<Record<KmsPurpose, kms.Key>>;
  public readonly serviceRoles: Readonly<Record<string, iam.Role>>;

  public constructor(scope: Construct, id: string, props: AiAssistInfraStackProps = {}) {
    super(scope, id, props);

    const environmentName = normalizeEnvironmentName(props.environmentName ?? "dev");
    const keys = this.createKmsKeys(environmentName);
    const tables = this.createDynamoDbTables(environmentName, keys);
    const api = this.createHttpRouteInventory(environmentName);
    const serviceRoles = this.createServiceRoles(tables, keys);

    this.tables = tables;
    this.keys = keys;
    this.serviceRoles = serviceRoles;

    new cdk.CfnOutput(this, "HttpApiId", {
      value: api.ref
    });
  }

  private createKmsKeys(environmentName: string): Record<KmsPurpose, kms.Key> {
    const keys = {} as Record<KmsPurpose, kms.Key>;
    for (const mapping of listKmsPurposeMappings()) {
      const key = new kms.Key(this, keyId(mapping.purpose), {
        alias: getKmsAlias(environmentName, mapping.purpose),
        description: mapping.description,
        enableKeyRotation: true
      });

      cdk.Tags.of(key).add("ai-assist:environment", environmentName);
      cdk.Tags.of(key).add("ai-assist:kms-purpose", mapping.purpose);
      cdk.Tags.of(key).add("ai-assist:owning-service", mapping.owningService);
      if (mapping.optional) {
        cdk.Tags.of(key).add("ai-assist:optional", "true");
      }
      keys[mapping.purpose] = key;
    }
    return keys;
  }

  private createDynamoDbTables(environmentName: string, keys: Record<KmsPurpose, kms.Key>): Record<string, dynamodb.Table> {
    const tables: Record<string, dynamodb.Table> = {};
    for (const spec of listDynamoDbTableSpecs()) {
      const table = new dynamodb.Table(this, tableId(spec), {
        tableName: buildEnvironmentResourceName(environmentName, spec.name),
        partitionKey: {
          name: spec.partitionKey,
          type: dynamodb.AttributeType.STRING
        },
        sortKey: spec.sortKey
          ? {
              name: spec.sortKey,
              type: dynamodb.AttributeType.STRING
            }
          : undefined,
        timeToLiveAttribute: spec.ttlAttribute ?? undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: encryptionForTable(spec),
        encryptionKey: encryptionKeyForTable(spec, keys),
        removalPolicy: environmentName === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      });

      cdk.Tags.of(table).add("ai-assist:environment", environmentName);
      cdk.Tags.of(table).add("ai-assist:table-spec", spec.name);
      if (spec.optional) {
        cdk.Tags.of(table).add("ai-assist:optional", "true");
      }
      if (spec.defaultTtlHours !== null) {
        cdk.Tags.of(table).add("ai-assist:default-ttl-hours", String(spec.defaultTtlHours));
      }
      if (spec.encryptedFields.length > 0) {
        cdk.Tags.of(table).add("ai-assist:encrypted-fields", spec.encryptedFields.join(","));
      }
      tables[spec.name] = table;
    }
    return tables;
  }

  private createHttpRouteInventory(environmentName: string): apigatewayv2.CfnApi {
    const api = new apigatewayv2.CfnApi(this, "HttpApi", {
      name: buildEnvironmentResourceName(environmentName, "http-api"),
      protocolType: "HTTP",
      description: "MVP HTTP command and SSE route inventory for AI Assist."
    });

    const defaultLimits = buildDefaultRouteRateLimits();
    new apigatewayv2.CfnStage(this, "HttpApiDefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: Math.max(...Object.values(defaultLimits).map((limit) => limit.burst)),
        throttlingRateLimit: Math.max(...Object.values(defaultLimits).map((limit) => limit.requestsPerMinute)) / 60
      },
      routeSettings: Object.fromEntries(
        Object.entries(defaultLimits).map(([routeKey, limit]) => [
          routeKey,
          {
            ThrottlingBurstLimit: limit.burst,
            ThrottlingRateLimit: limit.requestsPerMinute / 60
          }
        ])
      )
    });

    for (const route of SERVICE_ROUTES) {
      const routeResource = new apigatewayv2.CfnRoute(this, routeConstructId(route.routeKey), {
        apiId: api.ref,
        routeKey: route.routeKey,
        authorizationType: "NONE"
      });
      routeResource.cfnOptions.metadata = {
        owningService: route.service,
        rateLimitTier: route.rateLimitTier,
        requiresAuthentication: route.requiresAuthentication
      };
    }

    return api;
  }

  private createServiceRoles(tables: Record<string, dynamodb.Table>, keys: Record<KmsPurpose, kms.Key>): Record<string, iam.Role> {
    const roles: Record<string, iam.Role> = {};
    for (const boundary of IAM_BOUNDARY_MATRIX) {
      const role = new iam.Role(this, serviceRoleId(boundary.service), {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description: boundary.notes
      });

      for (const accessBoundary of boundary.tableAccess) {
        const table = tables[accessBoundary.table];
        if (table) {
          role.addToPolicy(new iam.PolicyStatement({
            actions: dynamoDbActionsForAccess(accessBoundary.access),
            resources: [table.tableArn]
          }));
        }
      }

      for (const accessBoundary of boundary.kmsAccess) {
        const key = keys[accessBoundary.purpose];
        if (key) {
          role.addToPolicy(new iam.PolicyStatement({
            actions: kmsActionsForAccess(accessBoundary.access),
            resources: [key.keyArn]
          }));
        }
      }

      roles[boundary.service] = role;
    }
    return roles;
  }
}

function dynamoDbActionsForAccess(access: readonly string[]): string[] {
  const actions = new Set<string>();
  if (access.includes(DYNAMODB_ACCESS_LEVELS.READ)) {
    actions.add("dynamodb:BatchGetItem");
    actions.add("dynamodb:DescribeTable");
    actions.add("dynamodb:GetItem");
    actions.add("dynamodb:Query");
  }
  if (access.includes(DYNAMODB_ACCESS_LEVELS.WRITE)) {
    actions.add("dynamodb:BatchWriteItem");
    actions.add("dynamodb:ConditionCheckItem");
    actions.add("dynamodb:DeleteItem");
    actions.add("dynamodb:PutItem");
    actions.add("dynamodb:UpdateItem");
  }
  return [...actions].sort();
}

function kmsActionsForAccess(access: readonly string[]): string[] {
  const actions = new Set<string>();
  if (access.includes(KMS_ACCESS_LEVELS.DESCRIBE)) {
    actions.add("kms:DescribeKey");
  }
  if (access.includes(KMS_ACCESS_LEVELS.ENCRYPT)) {
    actions.add("kms:Encrypt");
  }
  if (access.includes(KMS_ACCESS_LEVELS.DECRYPT)) {
    actions.add("kms:Decrypt");
  }
  if (access.includes(KMS_ACCESS_LEVELS.GENERATE_DATA_KEY)) {
    actions.add("kms:GenerateDataKey*");
  }
  if (access.includes(KMS_ACCESS_LEVELS.REENCRYPT)) {
    actions.add("kms:ReEncrypt*");
  }
  return [...actions].sort();
}

function encryptionForTable(spec: DynamoDbTableSpec): dynamodb.TableEncryption {
  return encryptionKeyPurposeForTable(spec) ? dynamodb.TableEncryption.CUSTOMER_MANAGED : dynamodb.TableEncryption.AWS_MANAGED;
}

function encryptionKeyForTable(spec: DynamoDbTableSpec, keys: Record<KmsPurpose, kms.Key>): kms.Key | undefined {
  const purpose = encryptionKeyPurposeForTable(spec);
  return purpose ? keys[purpose] : undefined;
}

function encryptionKeyPurposeForTable(spec: DynamoDbTableSpec): KmsPurpose | null {
  if (spec.name === "OAuthTokens") {
    return KMS_PURPOSES.OAUTH_TOKENS;
  }
  if (spec.name === "SessionSecrets") {
    return KMS_PURPOSES.SESSION_SECRETS;
  }
  if (spec.name === "ProposedActions" || spec.name === "SessionEvents") {
    return KMS_PURPOSES.PROPOSED_ACTIONS;
  }
  return null;
}

function keyId(purpose: string): string {
  return `${toPascalCase(purpose)}Key`;
}

function tableId(spec: DynamoDbTableSpec): string {
  return `${spec.name}Table`;
}

function serviceRoleId(service: string): string {
  return `${toPascalCase(service.replace("ai-assist-", ""))}Role`;
}

function routeConstructId(routeKey: string): string {
  return `${toPascalCase(routeKey.replace(/[{}]/g, ""))}Route`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}
