import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
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
import { SERVICE_ROUTES, SERVICES, ServiceName } from "../config/service-routes";

const SERVICE_CONTAINER_PORT = 8080;
const SSE_IDLE_TIMEOUT_SECONDS = 900;
const DEFAULT_SSE_HEARTBEAT_SECONDS = 25;
const DEFAULT_SSE_REPLAY_WINDOW_SECONDS = 300;

export interface AiAssistInfraStackProps extends cdk.StackProps {
  readonly environmentName?: string;
  readonly deploymentTarget?: DeploymentTarget;
}

interface ServiceRuntimeInfrastructure {
  readonly vpcLink: apigatewayv2.CfnVpcLink;
  readonly serviceListeners: Record<ServiceName, elbv2.ApplicationListener>;
  readonly publicSseLoadBalancer: elbv2.ApplicationLoadBalancer;
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
    const serviceRoles = this.createServiceRoles(tables, keys);
    const runtime = this.createServiceRuntimeInfrastructure(deploymentTarget, tables, keys, serviceRoles);
    const api = this.createHttpRouteInventory(deploymentTarget, runtime);
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
    new cdk.CfnOutput(this, "SseBaseUrl", {
      value: `https://${runtime.publicSseLoadBalancer.loadBalancerDnsName}`
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

  private createHttpRouteInventory(deploymentTarget: DeploymentTarget, runtime: ServiceRuntimeInfrastructure): apigatewayv2.CfnApi {
    const api = new apigatewayv2.CfnApi(this, "HttpApi", {
      name: buildTargetResourceName(deploymentTarget, "http-api"),
      protocolType: "HTTP",
      description: "Trusted-user HTTP command routes wired to service runtimes for AI Assist."
    });
    const authIssuer = new cdk.CfnParameter(this, "ProductAuthIssuer", {
      type: "String",
      description: "Product auth token issuer for HTTP API JWT authorization."
    });
    const authAudience = new cdk.CfnParameter(this, "ProductAuthAudience", {
      type: "String",
      description: "Product auth token audience for HTTP API JWT authorization."
    });
    const authorizer = new apigatewayv2.CfnAuthorizer(this, "ProductSessionJwtAuthorizer", {
      apiId: api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: buildTargetResourceName(deploymentTarget, "product-session-authorizer"),
      jwtConfiguration: {
        issuer: authIssuer.valueAsString,
        audience: [authAudience.valueAsString]
      }
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
        Object.entries(defaultLimits)
          .filter(([routeKey]) => SERVICE_ROUTES.some((route) => route.routeKey === routeKey && route.edgeSurface === "api-gateway"))
          .map(([routeKey, limit]) => [
          routeKey,
          {
            ThrottlingBurstLimit: limit.burst,
            ThrottlingRateLimit: limit.requestsPerMinute / 60
          }
        ])
      )
    });

    const placeholderFunction = this.createHealthPlaceholderFunction(deploymentTarget);
    const placeholderIntegration = new apigatewayv2.CfnIntegration(this, "RoutePlaceholderIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: placeholderFunction.functionArn,
      payloadFormatVersion: "2.0",
      description: "Metadata-safe placeholder integration for the explicitly out-of-scope health route."
    });
    new lambda.CfnPermission(this, "RoutePlaceholderInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: placeholderFunction.functionName,
      principal: "apigateway.amazonaws.com",
      sourceArn: cdk.Fn.sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/*", {
        ApiId: api.ref
      })
    });

    for (const route of SERVICE_ROUTES.filter((candidate) => candidate.edgeSurface === "api-gateway")) {
      const targetIntegration = route.intentionallyPlaceholder
        ? placeholderIntegration
        : this.createHttpServiceIntegration(api, runtime.vpcLink, runtime.serviceListeners[route.service], route);
      const routeResource = new apigatewayv2.CfnRoute(this, routeConstructId(route.routeKey), {
        apiId: api.ref,
        routeKey: route.routeKey,
        authorizationType: route.requiresAuthentication ? "JWT" : "NONE",
        authorizerId: route.requiresAuthentication ? authorizer.ref : undefined,
        target: `integrations/${targetIntegration.ref}`
      });
      routeResource.cfnOptions.metadata = {
        owningService: route.service,
        rateLimitTier: route.rateLimitTier,
        requiresAuthentication: route.requiresAuthentication,
        integration: route.intentionallyPlaceholder ? "health-placeholder" : "service-runtime",
        edgeSurface: route.edgeSurface
      };
    }

    return api;
  }

  private createHttpServiceIntegration(
    api: apigatewayv2.CfnApi,
    vpcLink: apigatewayv2.CfnVpcLink,
    listener: elbv2.ApplicationListener,
    route: { readonly routeKey: string; readonly method: string; readonly path: string; readonly service: ServiceName }
  ): apigatewayv2.CfnIntegration {
    return new apigatewayv2.CfnIntegration(this, `${routeConstructId(route.routeKey)}Integration`, {
      apiId: api.ref,
      integrationType: "HTTP_PROXY",
      integrationMethod: route.method,
      integrationUri: listener.listenerArn,
      connectionType: "VPC_LINK",
      connectionId: vpcLink.ref,
      payloadFormatVersion: "1.0",
      description: `Private ALB integration for ${route.service}.`,
      requestParameters: {
        "overwrite:header.x-request-id": "$context.requestId",
        "overwrite:header.x-correlation-id": "$context.requestId"
      }
    });
  }

  private createHealthPlaceholderFunction(deploymentTarget: DeploymentTarget): lambda.Function {
    const functionName = buildTargetResourceName(deploymentTarget, "health-placeholder");
    const logGroup = new logs.LogGroup(this, "HealthPlaceholderLogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    return new lambda.Function(this, "HealthPlaceholderFunction", {
      functionName,
      description: "Metadata-safe health fallback. Trusted-user MVP routes are wired to service runtimes.",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(5),
      logGroup,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const routeKey = event && typeof event.routeKey === "string" ? event.routeKey : "UNKNOWN";
  const requestId = event && event.requestContext ? event.requestContext.requestId : undefined;
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ok", routeKey, requestId })
  };
};
`)
    });
  }

  private createServiceRuntimeInfrastructure(
    deploymentTarget: DeploymentTarget,
    tables: Record<string, dynamodb.Table>,
    keys: Record<KmsPurpose, kms.Key>,
    serviceRoles: Record<string, iam.Role>
  ): ServiceRuntimeInfrastructure {
    const vpc = new ec2.Vpc(this, "ServiceVpc", {
      vpcName: buildTargetResourceName(deploymentTarget, "service-vpc"),
      availabilityZones: [`${deploymentTarget.region}a`, `${deploymentTarget.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC
        }
      ]
    });
    const cluster = new ecs.Cluster(this, "ServiceCluster", {
      clusterName: buildTargetResourceName(deploymentTarget, "service-cluster"),
      vpc
    });
    const vpcLinkSecurityGroup = new ec2.SecurityGroup(this, "HttpApiVpcLinkSecurityGroup", {
      vpc,
      description: "Allows HTTP API VPC link traffic to internal service load balancers.",
      allowAllOutbound: true
    });
    const vpcLink = new apigatewayv2.CfnVpcLink(this, "HttpApiVpcLink", {
      name: buildTargetResourceName(deploymentTarget, "http-vpc-link"),
      subnetIds: vpc.publicSubnets.map((subnet) => subnet.subnetId),
      securityGroupIds: [vpcLinkSecurityGroup.securityGroupId]
    });
    const sharedEnvironment = this.buildSharedServiceEnvironment(deploymentTarget, tables, keys);
    const serviceListeners: Partial<Record<ServiceName, elbv2.ApplicationListener>> = {};

    for (const service of Object.values(SERVICES)) {
      const runtime = this.createFargateHttpService(deploymentTarget, vpc, cluster, service, serviceRoles[service], sharedEnvironment, vpcLinkSecurityGroup);
      serviceListeners[service] = runtime.listener;
    }

    const publicSseLoadBalancer = this.createPublicSseLoadBalancer(deploymentTarget, vpc, cluster, serviceRoles[SERVICES.SESSION_EVENTS], sharedEnvironment);

    return {
      vpcLink,
      serviceListeners: serviceListeners as Record<ServiceName, elbv2.ApplicationListener>,
      publicSseLoadBalancer
    };
  }

  private createFargateHttpService(
    deploymentTarget: DeploymentTarget,
    vpc: ec2.Vpc,
    cluster: ecs.Cluster,
    service: ServiceName,
    taskRole: iam.Role,
    sharedEnvironment: Record<string, string>,
    vpcLinkSecurityGroup: ec2.SecurityGroup
  ): { readonly service: ecs.FargateService; readonly listener: elbv2.ApplicationListener } {
    const serviceId = toPascalCase(service);
    const imageUri = new cdk.CfnParameter(this, `${serviceId}ImageUri`, {
      type: "String",
      description: `Container image URI for ${service}.`
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${serviceId}TaskDefinition`, {
      family: buildTargetResourceName(deploymentTarget, `${service}-task`),
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole
    });
    const logGroup = new logs.LogGroup(this, `${serviceId}LogGroup`, {
      logGroupName: `/aws/ecs/${buildTargetResourceName(deploymentTarget, service)}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const container = taskDefinition.addContainer(`${serviceId}Container`, {
      image: ecs.ContainerImage.fromRegistry(imageUri.valueAsString),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: service,
        logGroup
      }),
      environment: {
        ...sharedEnvironment,
        SERVICE_NAME: service,
        SERVICE_PORT: String(SERVICE_CONTAINER_PORT)
      },
      healthCheck: {
        command: ["CMD-SHELL", `python - <<'PY'\nimport urllib.request\nurllib.request.urlopen('http://127.0.0.1:${SERVICE_CONTAINER_PORT}/health', timeout=2)\nPY`],
        interval: cdk.Duration.seconds(30),
        retries: 3,
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(30)
      }
    });
    container.addPortMappings({
      containerPort: SERVICE_CONTAINER_PORT
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}ServiceSecurityGroup`, {
      vpc,
      description: `Ingress to ${service} tasks from service load balancers only.`,
      allowAllOutbound: true
    });
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}LoadBalancerSecurityGroup`, {
      vpc,
      description: `Ingress to ${service} internal load balancer from HTTP API VPC link.`,
      allowAllOutbound: true
    });
    loadBalancerSecurityGroup.addIngressRule(vpcLinkSecurityGroup, ec2.Port.tcp(80), "HTTP API VPC link to service listener.");
    serviceSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(SERVICE_CONTAINER_PORT), "Service load balancer to container.");

    const fargateService = new ecs.FargateService(this, `${serviceId}Service`, {
      serviceName: buildTargetResourceName(deploymentTarget, service),
      cluster,
      taskDefinition,
      desiredCount: 1,
      circuitBreaker: {
        rollback: true
      },
      minHealthyPercent: 100,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${serviceId}InternalLoadBalancer`, {
      loadBalancerName: loadBalancerName(deploymentTarget, service, "int"),
      vpc,
      internetFacing: false,
      securityGroup: loadBalancerSecurityGroup
    });
    const listener = loadBalancer.addListener(`${serviceId}Listener`, {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    });
    listener.addTargets(`${serviceId}Targets`, {
      port: SERVICE_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [fargateService],
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200-399",
        interval: cdk.Duration.seconds(30)
      },
      deregistrationDelay: cdk.Duration.seconds(30)
    });

    return { service: fargateService, listener };
  }

  private createPublicSseLoadBalancer(
    deploymentTarget: DeploymentTarget,
    vpc: ec2.Vpc,
    cluster: ecs.Cluster,
    taskRole: iam.Role,
    sharedEnvironment: Record<string, string>
  ): elbv2.ApplicationLoadBalancer {
    const service = SERVICES.SESSION_EVENTS;
    const serviceId = "SessionEventsSse";
    const imageUri = new cdk.CfnParameter(this, `${serviceId}ImageUri`, {
      type: "String",
      description: "Container image URI for the public SSE session-events runtime."
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${serviceId}TaskDefinition`, {
      family: buildTargetResourceName(deploymentTarget, `${service}-sse-task`),
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole
    });
    const logGroup = new logs.LogGroup(this, `${serviceId}LogGroup`, {
      logGroupName: `/aws/ecs/${buildTargetResourceName(deploymentTarget, `${service}-sse`)}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const container = taskDefinition.addContainer(`${serviceId}Container`, {
      image: ecs.ContainerImage.fromRegistry(imageUri.valueAsString),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${service}-sse`,
        logGroup
      }),
      environment: {
        ...sharedEnvironment,
        SERVICE_NAME: service,
        SERVICE_PORT: String(SERVICE_CONTAINER_PORT),
        SSE_HEARTBEAT_SECONDS: String(DEFAULT_SSE_HEARTBEAT_SECONDS),
        SSE_REPLAY_WINDOW_SECONDS: String(DEFAULT_SSE_REPLAY_WINDOW_SECONDS)
      }
    });
    container.addPortMappings({
      containerPort: SERVICE_CONTAINER_PORT
    });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}ServiceSecurityGroup`, {
      vpc,
      description: "Ingress to public SSE tasks from the public SSE load balancer only.",
      allowAllOutbound: true
    });
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}LoadBalancerSecurityGroup`, {
      vpc,
      description: "Public HTTPS load balancer for browser EventSource SSE streams.",
      allowAllOutbound: true
    });
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Browser EventSource HTTPS.");
    serviceSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(SERVICE_CONTAINER_PORT), "SSE load balancer to container.");
    const fargateService = new ecs.FargateService(this, `${serviceId}Service`, {
      serviceName: buildTargetResourceName(deploymentTarget, `${service}-sse`),
      cluster,
      taskDefinition,
      desiredCount: 1,
      circuitBreaker: {
        rollback: true
      },
      minHealthyPercent: 100,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });
    const certificateArn = new cdk.CfnParameter(this, "SseCertificateArn", {
      type: "String",
      description: "ACM certificate ARN for the public SSE HTTPS listener."
    });
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${serviceId}LoadBalancer`, {
      loadBalancerName: loadBalancerName(deploymentTarget, "session-events", "sse"),
      vpc,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
      idleTimeout: cdk.Duration.seconds(SSE_IDLE_TIMEOUT_SECONDS)
    });
    const listener = loadBalancer.addListener(`${serviceId}HttpsListener`, {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn.valueAsString)]
    });
    listener.addTargets(`${serviceId}Targets`, {
      port: SERVICE_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [fargateService],
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200-399",
        interval: cdk.Duration.seconds(30)
      },
      deregistrationDelay: cdk.Duration.seconds(30)
    });
    return loadBalancer;
  }

  private buildSharedServiceEnvironment(
    deploymentTarget: DeploymentTarget,
    tables: Record<string, dynamodb.Table>,
    keys: Record<KmsPurpose, kms.Key>
  ): Record<string, string> {
    const tableName = (name: string): string => tables[name]?.tableName ?? "";
    return {
      APP_ENV: deploymentTarget.environmentName,
      AWS_REGION: deploymentTarget.region,
      TRUSTED_USER_MODE: "true",
      APP_KMS_KEY_ID: keys[KMS_PURPOSES.OAUTH_TOKENS].keyArn,
      TENANT_TABLE_NAME: tableName("Tenants"),
      OAUTH_TOKEN_TABLE_NAME: tableName("OAuthTokens"),
      SESSION_SECRET_TABLE_NAME: tableName("SessionSecrets"),
      CONSENT_GRANT_TABLE_NAME: tableName("ContextConsentGrants"),
      RESOURCE_SESSION_TABLE_NAME: tableName("ResourceSessions"),
      PROPOSED_ACTION_TABLE_NAME: tableName("ProposedActions"),
      SESSION_EVENT_TABLE_NAME: tableName("SessionEvents"),
      SESSION_SECRET_TTL_HOURS: "8",
      PROPOSED_ACTION_TTL_HOURS: "24",
      SSE_HEARTBEAT_SECONDS: String(DEFAULT_SSE_HEARTBEAT_SECONDS),
      SSE_REPLAY_WINDOW_SECONDS: String(DEFAULT_SSE_REPLAY_WINDOW_SECONDS)
    };
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
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
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

function loadBalancerName(deploymentTarget: DeploymentTarget, service: string, suffix: string): string {
  const serviceToken = service
    .replace(/^ai-assist-/, "")
    .replace(/-service$/, "")
    .replace(/-adapter$/, "")
    .split("-")
    .map((part) => part.charAt(0))
    .join("");
  return `aa-${deploymentTarget.environmentName}-${deploymentTarget.region.replace(/-/g, "")}-${serviceToken}-${suffix}`.slice(0, 32);
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
