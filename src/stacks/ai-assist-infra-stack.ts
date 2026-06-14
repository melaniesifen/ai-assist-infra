import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { DynamoDbTableSpec, listDynamoDbTableSpecs } from "../config/dynamodb-tables";
import { DeploymentTarget, ENVIRONMENTS, buildTargetResourceName, isProductionEnvironment, normalizeEnvironmentName } from "../config/environments";
import { DYNAMODB_ACCESS_LEVELS, IAM_BOUNDARY_MATRIX, KMS_ACCESS_LEVELS } from "../config/iam-boundaries";
import { KMS_PURPOSES, KmsPurpose, getTargetSharedKmsAlias, listKmsPurposeMappings } from "../config/kms-purposes";
import { OPERATIONAL_ALARMS, OPERATIONAL_METRICS } from "../config/operational-guardrails";
import { buildDefaultRouteRateLimits } from "../config/rate-limits";
import { SERVICE_ROUTES } from "../config/service-routes";

export interface AiAssistInfraStackProps extends cdk.StackProps {
  readonly environmentName?: string;
  readonly deploymentTarget?: DeploymentTarget;
}

export class AiAssistInfraStack extends cdk.Stack {
  public readonly tables: Readonly<Record<string, dynamodb.Table>>;
  public readonly keys: Readonly<Record<KmsPurpose, kms.Key>>;
  public readonly serviceRoles: Readonly<Record<string, iam.Role>>;

  public constructor(scope: Construct, id: string, props: AiAssistInfraStackProps = {}) {
    super(scope, id, props);

    const deploymentTarget = props.deploymentTarget ?? {
      environmentName: normalizeEnvironmentName(props.environmentName ?? ENVIRONMENTS.DEV),
      accountEnvVar: "CDK_DEFAULT_ACCOUNT",
      region: "us-west-2",
      stackName: id,
      removalProtection: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV),
      logRetentionDays: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV) ? 365 : 30
    };
    const environmentName = normalizeEnvironmentName(deploymentTarget.environmentName);
    const keys = this.createKmsKeys(deploymentTarget);
    const tables = this.createDynamoDbTables(deploymentTarget, keys);
    const api = this.createHttpRouteInventory(deploymentTarget);
    const serviceRoles = this.createServiceRoles(tables, keys);
    this.createOperationalAlarms(deploymentTarget);

    cdk.Tags.of(this).add("ai-assist:environment", environmentName);
    cdk.Tags.of(this).add("ai-assist:region", deploymentTarget.region);

    this.tables = tables;
    this.keys = keys;
    this.serviceRoles = serviceRoles;

    new cdk.CfnOutput(this, "HttpApiId", {
      value: api.ref
    });
    new cdk.CfnOutput(this, "EnvironmentName", {
      value: environmentName
    });
  }

  private createKmsKeys(deploymentTarget: DeploymentTarget): Record<KmsPurpose, kms.Key> {
    const mappings = listKmsPurposeMappings();
    const coveredPurposes = mappings.map((mapping) => mapping.purpose);
    const owningServices = [...new Set(mappings.map((mapping) => mapping.owningService))].sort();
    const sharedKey = new kms.Key(this, "AppKey", {
      alias: getTargetSharedKmsAlias(deploymentTarget),
      description: "Shared AI Assist app encryption key for OAuth tokens, session secrets, proposed actions, and opt-in user secrets.",
      enableKeyRotation: true,
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    cdk.Tags.of(sharedKey).add("ai-assist:environment", deploymentTarget.environmentName);
    cdk.Tags.of(sharedKey).add("ai-assist:region", deploymentTarget.region);
    cdk.Tags.of(sharedKey).add("ai-assist:kms-purposes", formatTagListValue(coveredPurposes));
    cdk.Tags.of(sharedKey).add("ai-assist:owning-services", formatTagListValue(owningServices));

    return Object.fromEntries(coveredPurposes.map((purpose) => [purpose, sharedKey])) as Record<KmsPurpose, kms.Key>;
  }

  private createDynamoDbTables(deploymentTarget: DeploymentTarget, keys: Record<KmsPurpose, kms.Key>): Record<string, dynamodb.Table> {
    const tables: Record<string, dynamodb.Table> = {};
    for (const spec of listDynamoDbTableSpecs()) {
      const table = new dynamodb.Table(this, tableId(spec), {
        tableName: buildTargetResourceName(deploymentTarget, spec.name),
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
        deletionProtection: deploymentTarget.removalProtection,
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      });

      cdk.Tags.of(table).add("ai-assist:environment", deploymentTarget.environmentName);
      cdk.Tags.of(table).add("ai-assist:region", deploymentTarget.region);
      cdk.Tags.of(table).add("ai-assist:table-spec", spec.name);
      if (spec.optional) {
        cdk.Tags.of(table).add("ai-assist:optional", "true");
      }
      if (spec.defaultTtlHours !== null) {
        cdk.Tags.of(table).add("ai-assist:default-ttl-hours", String(spec.defaultTtlHours));
      }
      if (spec.encryptedFields.length > 0) {
        cdk.Tags.of(table).add("ai-assist:encrypted-fields", formatTagListValue(spec.encryptedFields));
      }
      tables[spec.name] = table;
    }
    return tables;
  }

  private createHttpRouteInventory(deploymentTarget: DeploymentTarget): apigatewayv2.CfnApi {
    const api = new apigatewayv2.CfnApi(this, "HttpApi", {
      name: buildTargetResourceName(deploymentTarget, "http-api"),
      protocolType: "HTTP",
      description: "MVP HTTP command and SSE route inventory for AI Assist."
    });
    const accessLogGroup = new logs.LogGroup(this, "HttpApiAccessLogGroup", {
      logGroupName: `/aws/apigateway/${buildTargetResourceName(deploymentTarget, "http-api-access")}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
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
      accessLogSettings: {
        destinationArn: accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          routeKey: "$context.routeKey",
          status: "$context.status",
          responseLatency: "$context.responseLatency",
          integrationStatus: "$context.integrationStatus",
          errorMessage: "$context.error.message"
        })
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

    const placeholderFunction = this.createRoutePlaceholderFunction(deploymentTarget);
    const placeholderIntegration = new apigatewayv2.CfnIntegration(this, "RoutePlaceholderIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: placeholderFunction.functionArn,
      payloadFormatVersion: "2.0",
      description: "Metadata-safe placeholder integration until service routes are wired."
    });
    new lambda.CfnPermission(this, "RoutePlaceholderInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: placeholderFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: cdk.Fn.sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/*", {
        ApiId: api.ref
      })
    });

    for (const route of SERVICE_ROUTES) {
      const routeResource = new apigatewayv2.CfnRoute(this, routeConstructId(route.routeKey), {
        apiId: api.ref,
        routeKey: route.routeKey,
        authorizationType: "NONE",
        target: `integrations/${placeholderIntegration.ref}`
      });
      routeResource.cfnOptions.metadata = {
        owningService: route.service,
        rateLimitTier: route.rateLimitTier,
        requiresAuthentication: route.requiresAuthentication
      };
    }

    return api;
  }

  private createRoutePlaceholderFunction(deploymentTarget: DeploymentTarget): lambda.Function {
    const functionName = buildTargetResourceName(deploymentTarget, "route-placeholder");
    const logGroup = new logs.LogGroup(this, "RoutePlaceholderLogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    return new lambda.Function(this, "RoutePlaceholderFunction", {
      functionName,
      description: "Metadata-safe placeholder for deployable API routes before service integrations are wired.",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(5),
      logGroup,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const routeKey = event && typeof event.routeKey === "string" ? event.routeKey : "UNKNOWN";
  const requestId = event && event.requestContext ? event.requestContext.requestId : undefined;
  if (routeKey === "GET /health") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ok", routeKey, requestId })
    };
  }
  return {
    statusCode: 501,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "ROUTE_NOT_IMPLEMENTED",
      message: "Route integration is not wired yet.",
      routeKey,
      requestId
    })
  };
};
`)
    });
  }

  private createOperationalAlarms(deploymentTarget: DeploymentTarget): void {
    const dashboard = new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: buildTargetResourceName(deploymentTarget, "operations-dashboard")
    });
    const dashboardMetrics: cloudwatch.Metric[] = [];
    for (const alarmConfig of OPERATIONAL_ALARMS) {
      const metricConfig = OPERATIONAL_METRICS.find((candidate) => candidate.metricName === alarmConfig.metricName);
      const metric = new cloudwatch.Metric({
        namespace: "AiAssist",
        metricName: alarmConfig.metricName,
        dimensionsMap: {
          Environment: deploymentTarget.environmentName,
          Path: alarmConfig.path
        },
        unit: metricConfig?.unit === "Milliseconds" ? cloudwatch.Unit.MILLISECONDS : cloudwatch.Unit.COUNT,
        period: cdk.Duration.minutes(5)
      });
      dashboardMetrics.push(metric);
      new cloudwatch.Alarm(this, alarmId(alarmConfig.metricName), {
        alarmName: buildTargetResourceName(deploymentTarget, `${alarmConfig.metricName}-alarm`),
        metric,
        threshold: alarmConfig.threshold,
        evaluationPeriods: alarmConfig.evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });
    }
    dashboard.addWidgets(new cloudwatch.GraphWidget({
      title: "Trusted-user operational guardrails",
      left: dashboardMetrics
    }));
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

function formatTagListValue(values: readonly string[]): string {
  return values.join("+");
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

function alarmId(metricName: string): string {
  return `${toPascalCase(metricName)}Alarm`;
}

function retentionDays(days: number): logs.RetentionDays {
  if (days >= 365) {
    return logs.RetentionDays.ONE_YEAR;
  }
  return logs.RetentionDays.ONE_MONTH;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}
