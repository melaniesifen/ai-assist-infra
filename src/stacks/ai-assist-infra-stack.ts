import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";
import { PYTHON_SERVICE_BASE_IMAGE, PYTHON_SERVICE_CONTAINER_ASSETS } from "../config/container-assets";
import { DEPLOYMENT_CONFIG_CONTEXT_KEY, TargetDeploymentConfig, getWebAppDomainName, parseDeploymentConfigContext } from "../config/deployment-config";
import { buildDogfoodRuntimeSourceHash } from "../config/dogfood-runtime-source-hash";
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
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");
const PYTHON_SERVICE_DOCKER_CONTEXT = path.join(WORKSPACE_ROOT, "ai-assist-infra/docker/python-service");
const DOGFOOD_RUNTIME_DOCKER_CONTEXT = path.join(WORKSPACE_ROOT, "ai-assist-infra/docker/dogfood-runtime");
const SERVICE_CONTAINER_CPU_ARCHITECTURE = ecs.CpuArchitecture.ARM64;
const SERVICE_CONTAINER_IMAGE_PLATFORM = ecrAssets.Platform.LINUX_ARM64;

export interface AiAssistInfraStackProps extends cdk.StackProps {
  readonly environmentName?: string;
  readonly deploymentTarget?: DeploymentTarget;
  readonly deploymentConfig?: TargetDeploymentConfig;
  readonly webAppCertificate?: acm.ICertificate;
}

interface ServiceRuntimeInfrastructure {
  readonly vpcLink: apigatewayv2.CfnVpcLink;
  readonly sharedHttpListener: elbv2.ApplicationListener;
}

interface ProductAuthResources {
  readonly issuer: string;
  readonly audience: string;
}

type RuntimeSecretName =
  | "productAuthHmac"
  | "oauthStateSigning"
  | "trustedUserBootstrap"
  | "googleOAuthClientSecret"
  | "platformProviderOpenai"
  | "platformProviderAnthropic";

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
      runtimeResourceName: "dogfood-runtime",
      stackName: id,
      removalProtection: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV),
      logRetentionDays: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV) ? 365 : 30
    };
    const deploymentConfig = props.deploymentConfig ?? parseDeploymentConfigContext(this.node.tryGetContext(DEPLOYMENT_CONFIG_CONTEXT_KEY), deploymentTarget.environmentName);
    if (!props.webAppCertificate) {
      throw new Error("webAppCertificate is required for CloudFront static web app hosting");
    }
    const environmentName = normalizeEnvironmentName(deploymentTarget.environmentName);
    const keys = this.createKmsKeys(deploymentTarget);
    const tables = this.createDynamoDbTables(deploymentTarget, keys);
    const secrets = this.createRuntimeSecrets(deploymentTarget);
    const serviceRoles = this.createServiceRoles(tables, keys);
    const api = this.createHttpApi(deploymentTarget);
    const productAuth = this.createProductAuthResources(deploymentTarget, deploymentConfig);
    const webAppHosting = this.createWebAppHosting(deploymentTarget, deploymentConfig, props.webAppCertificate);
    const runtime = this.createServiceRuntimeInfrastructure(deploymentTarget, tables, keys, secrets, api.attrApiEndpoint, deploymentConfig, productAuth);
    this.createHttpRouteInventory(api, deploymentTarget, runtime, deploymentConfig, productAuth);
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
      value: `https://${deploymentConfig.sseDomainName}`
    });
    new cdk.CfnOutput(this, "WebAppBaseUrl", {
      value: deploymentConfig.webAppBaseUrl
    });
    new cdk.CfnOutput(this, "WebAppAssetsBucketName", {
      value: webAppHosting.assetsBucket.bucketName
    });
    new cdk.CfnOutput(this, "WebAppDistributionId", {
      value: webAppHosting.distribution.distributionId
    });
    new cdk.CfnOutput(this, "ProductAuthIssuer", {
      value: productAuth.issuer
    });
    new cdk.CfnOutput(this, "ProductAuthAudience", {
      value: productAuth.audience
    });
  }

  private createProductAuthResources(deploymentTarget: DeploymentTarget, deploymentConfig: TargetDeploymentConfig): ProductAuthResources {
    void deploymentConfig;
    const userPool = new cognito.UserPool(this, "ProductAuthUserPool", {
      userPoolName: buildTargetResourceName(deploymentTarget, "product-auth-users"),
      selfSignUpEnabled: false,
      signInAliases: {
        email: true
      },
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const appClient = userPool.addClient("ProductAuthAppClient", {
      userPoolClientName: buildTargetResourceName(deploymentTarget, "product-auth-app-client"),
      generateSecret: false,
      authFlows: {
        userSrp: true
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1)
    });
    return {
      issuer: cdk.Fn.join("", ["https://cognito-idp.", cdk.Stack.of(this).region, ".amazonaws.com/", userPool.userPoolId]),
      audience: appClient.userPoolClientId
    };
  }

  private createWebAppHosting(
    deploymentTarget: DeploymentTarget,
    deploymentConfig: TargetDeploymentConfig,
    certificate: acm.ICertificate
  ): { readonly assetsBucket: s3.Bucket; readonly distribution: cloudfront.Distribution } {
    const webAppDomainName = getWebAppDomainName(deploymentConfig.webAppBaseUrl);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "WebAppHostedZone", {
      hostedZoneId: deploymentConfig.hostedZoneId,
      zoneName: deploymentConfig.hostedZoneName
    });
    const assetsBucket = new s3.Bucket(this, "WebAppAssetsBucket", {
      bucketName: buildTargetResourceName(deploymentTarget, "web-app-assets"),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const distribution = new cloudfront.Distribution(this, "WebAppDistribution", {
      comment: `AI Assist ${deploymentTarget.environmentName} static web app hosting.`,
      defaultRootObject: "index.html",
      domainNames: [webAppDomainName],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5)
        }
      ]
    });

    new route53.ARecord(this, "WebAppDnsRecord", {
      zone: hostedZone,
      recordName: webAppDomainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });

    cdk.Tags.of(assetsBucket).add("ai-assist:environment", deploymentTarget.environmentName);
    cdk.Tags.of(assetsBucket).add("ai-assist:region", deploymentTarget.region);
    cdk.Tags.of(distribution).add("ai-assist:environment", deploymentTarget.environmentName);
    cdk.Tags.of(distribution).add("ai-assist:region", deploymentTarget.region);

    return { assetsBucket, distribution };
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

  private createRuntimeSecrets(deploymentTarget: DeploymentTarget): Record<RuntimeSecretName, secretsmanager.Secret> {
    return {
      productAuthHmac: new secretsmanager.Secret(this, "ProductAuthHmacSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "product-auth-hmac-secret"),
        description: "Generated HMAC signing secret for dogfood product-session tokens.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      }),
      oauthStateSigning: new secretsmanager.Secret(this, "OauthStateSigningSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "oauth-state-signing-secret"),
        description: "Generated signing secret for dogfood Google OAuth state.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      }),
      trustedUserBootstrap: new secretsmanager.Secret(this, "TrustedUserBootstrapSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "trusted-user-bootstrap-secret"),
        description: "Generated bootstrap login secret for trusted-user dogfood auth.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      }),
      googleOAuthClientSecret: new secretsmanager.Secret(this, "GoogleOAuthClientSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "google-oauth-client-secret"),
        description: "Google OAuth client secret placeholder for dogfood auth token exchange. Replace the generated value after deploy.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      }),
      platformProviderOpenai: new secretsmanager.Secret(this, "PlatformProviderOpenaiSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "platform-provider-openai-secret"),
        description: "OpenAI platform provider credential placeholder for dogfood runtime. Replace the generated value after deploy when OpenAI is enabled.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      }),
      platformProviderAnthropic: new secretsmanager.Secret(this, "PlatformProviderAnthropicSecret", {
        secretName: buildTargetResourceName(deploymentTarget, "platform-provider-anthropic-secret"),
        description: "Anthropic platform provider credential placeholder for dogfood runtime. Replace the generated value after deploy when Anthropic is enabled.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true
        },
        removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
      })
    };
  }

  private createHttpApi(deploymentTarget: DeploymentTarget): apigatewayv2.CfnApi {
    return new apigatewayv2.CfnApi(this, "HttpApi", {
      name: buildTargetResourceName(deploymentTarget, "http-api"),
      protocolType: "HTTP",
      description: "Trusted-user HTTP command routes wired to the shared dogfood runtime for AI Assist."
    });
  }

  private createHttpRouteInventory(api: apigatewayv2.CfnApi, deploymentTarget: DeploymentTarget, runtime: ServiceRuntimeInfrastructure, deploymentConfig: TargetDeploymentConfig, productAuth: ProductAuthResources): void {
    const authorizer = deploymentConfig.edgeJwtAuthEnabled
      ? new apigatewayv2.CfnAuthorizer(this, "ProductSessionJwtAuthorizer", {
          apiId: api.ref,
          authorizerType: "JWT",
          identitySource: ["$request.header.Authorization"],
            name: buildTargetResourceName(deploymentTarget, "product-session-authorizer"),
            jwtConfiguration: {
            issuer: productAuth.issuer,
            audience: [productAuth.audience]
          }
        })
      : null;
    const accessLogGroup = new logs.LogGroup(this, "HttpApiAccessLogGroup", {
      logGroupName: `/aws/apigateway/${buildTargetResourceName(deploymentTarget, "http-api-access")}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    const defaultLimits = buildDefaultRouteRateLimits();
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

    const routeResources: apigatewayv2.CfnRoute[] = [];
    for (const route of SERVICE_ROUTES.filter((candidate) => candidate.edgeSurface === "api-gateway")) {
      const targetIntegration = route.intentionallyPlaceholder
        ? placeholderIntegration
        : this.createHttpServiceIntegration(api, runtime.vpcLink, runtime.sharedHttpListener, route, deploymentConfig.edgeJwtAuthEnabled);
      const routeResource = new apigatewayv2.CfnRoute(this, routeConstructId(route.routeKey), {
        apiId: api.ref,
        routeKey: route.routeKey,
        authorizationType: route.requiresAuthentication && authorizer ? "JWT" : "NONE",
        authorizerId: route.requiresAuthentication && authorizer ? authorizer.ref : undefined,
        target: `integrations/${targetIntegration.ref}`
      });
      routeResource.cfnOptions.metadata = {
        owningService: route.service,
        rateLimitTier: route.rateLimitTier,
        requiresAuthentication: route.requiresAuthentication,
        edgeJwtAuthEnabled: deploymentConfig.edgeJwtAuthEnabled,
        integration: route.intentionallyPlaceholder ? "health-placeholder" : "service-runtime",
        edgeSurface: route.edgeSurface
      };
      routeResources.push(routeResource);
    }

    const defaultStage = new apigatewayv2.CfnStage(this, "HttpApiDefaultStage", {
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
      }
    });
    for (const routeResource of routeResources) {
      defaultStage.addDependency(routeResource);
    }

  }

  private createHttpServiceIntegration(
    api: apigatewayv2.CfnApi,
    vpcLink: apigatewayv2.CfnVpcLink,
    listener: elbv2.ApplicationListener,
    route: { readonly routeKey: string; readonly method: string; readonly path: string; readonly service: ServiceName; readonly requiresAuthentication: boolean },
    edgeJwtAuthEnabled: boolean
  ): apigatewayv2.CfnIntegration {
    return new apigatewayv2.CfnIntegration(this, `${routeConstructId(route.routeKey)}Integration`, {
      apiId: api.ref,
      integrationType: "HTTP_PROXY",
      integrationMethod: route.method,
      integrationUri: listener.listenerArn,
      connectionType: "VPC_LINK",
      connectionId: vpcLink.ref,
      payloadFormatVersion: "1.0",
      description: `Shared dogfood runtime ALB integration for ${route.service}.`,
      requestParameters: integrationRequestParameters(route, edgeJwtAuthEnabled)
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
      description: "Metadata-safe health fallback. Trusted-user MVP routes are wired to the shared dogfood runtime.",
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
    secrets: Record<RuntimeSecretName, secretsmanager.Secret>,
    apiBaseUrl: string,
    deploymentConfig: TargetDeploymentConfig,
    productAuth: ProductAuthResources
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
      description: "Allows HTTP API VPC link traffic to the shared runtime load balancer.",
      allowAllOutbound: true
    });
    const vpcLink = new apigatewayv2.CfnVpcLink(this, "HttpApiVpcLink", {
      name: buildTargetResourceName(deploymentTarget, "http-vpc-link"),
      subnetIds: vpc.publicSubnets.map((subnet) => subnet.subnetId),
      securityGroupIds: [vpcLinkSecurityGroup.securityGroupId]
    });
    const sharedEnvironment = this.buildSharedServiceEnvironment(deploymentTarget, tables, keys, apiBaseUrl, deploymentConfig, productAuth);
    const dogfoodRuntimeRole = this.createDogfoodRuntimeRole(tables, keys);
    const runtime = this.createDogfoodRuntimeService(deploymentTarget, vpc, cluster, dogfoodRuntimeRole, sharedEnvironment, secrets, vpcLinkSecurityGroup, deploymentConfig);

    return {
      vpcLink,
      sharedHttpListener: runtime.httpListener
    };
  }

  private createDogfoodRuntimeService(
    deploymentTarget: DeploymentTarget,
    vpc: ec2.Vpc,
    cluster: ecs.Cluster,
    taskRole: iam.Role,
    sharedEnvironment: Record<string, string>,
    secrets: Record<RuntimeSecretName, secretsmanager.Secret>,
    vpcLinkSecurityGroup: ec2.SecurityGroup,
    deploymentConfig: TargetDeploymentConfig
  ): { readonly service: ecs.FargateService; readonly httpListener: elbv2.ApplicationListener; readonly httpsListener: elbv2.ApplicationListener; readonly publicLoadBalancer: elbv2.ApplicationLoadBalancer; readonly privateLoadBalancer: elbv2.ApplicationLoadBalancer } {
    const serviceId = "DogfoodRuntime";
    const runtimeResourceName = deploymentTarget.runtimeResourceName;
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${serviceId}TaskDefinition`, {
      family: buildTargetResourceName(deploymentTarget, `${runtimeResourceName}-task`),
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: SERVICE_CONTAINER_CPU_ARCHITECTURE,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });
    const logGroup = new logs.LogGroup(this, `${serviceId}LogGroup`, {
      logGroupName: `/aws/ecs/${buildTargetResourceName(deploymentTarget, runtimeResourceName)}`,
      retention: retentionDays(deploymentTarget.logRetentionDays),
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const container = taskDefinition.addContainer(`${serviceId}Container`, {
      image: this.createDogfoodRuntimeContainerImage(serviceId),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: runtimeResourceName,
        logGroup
      }),
      environment: {
        ...sharedEnvironment,
        GOOGLE_OAUTH_CLIENT_SECRET_REF: buildTargetResourceName(deploymentTarget, "google-oauth-client-secret"),
        PLATFORM_PROVIDER_SECRET_REF_OPENAI: buildTargetResourceName(deploymentTarget, "platform-provider-openai-secret"),
        PLATFORM_PROVIDER_SECRET_REF_ANTHROPIC: buildTargetResourceName(deploymentTarget, "platform-provider-anthropic-secret"),
        PLATFORM_PROVIDER_QUOTA_MODE: "enforced",
        PLATFORM_PROVIDER_AUDIT_MODE: "metadata",
        SERVICE_NAME: runtimeResourceName,
        SERVICE_PORT: String(SERVICE_CONTAINER_PORT),
        ROUTE_OWNING_SERVICES: formatRouteOwnershipEnvironment()
      },
      secrets: {
        PRODUCT_AUTH_HMAC_SECRET: ecs.Secret.fromSecretsManager(secrets.productAuthHmac),
        OAUTH_STATE_SIGNING_SECRET: ecs.Secret.fromSecretsManager(secrets.oauthStateSigning),
        TRUSTED_USER_BOOTSTRAP_SECRET: ecs.Secret.fromSecretsManager(secrets.trustedUserBootstrap)
      },
      healthCheck: {
        command: ["CMD-SHELL", `python - <<'PY'\nimport urllib.request\nurllib.request.urlopen('http://127.0.0.1:${SERVICE_CONTAINER_PORT}/health', timeout=2)\nPY`],
        interval: cdk.Duration.seconds(30),
        retries: 3,
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(30)
      }
    });
    secrets.productAuthHmac.grantRead(taskDefinition.executionRole!);
    secrets.oauthStateSigning.grantRead(taskDefinition.executionRole!);
    secrets.trustedUserBootstrap.grantRead(taskDefinition.executionRole!);
    secrets.googleOAuthClientSecret.grantRead(taskRole);
    secrets.platformProviderOpenai.grantRead(taskRole);
    secrets.platformProviderAnthropic.grantRead(taskRole);
    container.addPortMappings({
      containerPort: SERVICE_CONTAINER_PORT
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}ServiceSecurityGroup`, {
      vpc,
      description: "Ingress to shared dogfood runtime tasks from dogfood load balancers only.",
      allowAllOutbound: true
    });
    const privateLoadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}PrivateLoadBalancerSecurityGroup`, {
      vpc,
      description: "Internal ALB for API Gateway VPC link traffic to the shared dogfood runtime.",
      allowAllOutbound: true
    });
    const publicLoadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${serviceId}PublicLoadBalancerSecurityGroup`, {
      vpc,
      description: "Public ALB for browser EventSource SSE streams.",
      allowAllOutbound: true
    });
    privateLoadBalancerSecurityGroup.addIngressRule(vpcLinkSecurityGroup, ec2.Port.tcp(80), "HTTP API VPC link to shared runtime listener.");
    publicLoadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Browser EventSource HTTPS.");
    serviceSecurityGroup.addIngressRule(privateLoadBalancerSecurityGroup, ec2.Port.tcp(SERVICE_CONTAINER_PORT), "Private API load balancer to dogfood runtime container.");
    serviceSecurityGroup.addIngressRule(publicLoadBalancerSecurityGroup, ec2.Port.tcp(SERVICE_CONTAINER_PORT), "Public SSE load balancer to dogfood runtime container.");

    const fargateService = new ecs.FargateService(this, `${serviceId}Service`, {
      serviceName: buildTargetResourceName(deploymentTarget, runtimeResourceName),
      cluster,
      taskDefinition,
      desiredCount: 1,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
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
    const privateLoadBalancer = new elbv2.ApplicationLoadBalancer(this, `${serviceId}PrivateLoadBalancer`, {
      loadBalancerName: loadBalancerName(deploymentTarget, runtimeResourceName, "api"),
      vpc,
      internetFacing: false,
      securityGroup: privateLoadBalancerSecurityGroup
    });
    const httpListener = privateLoadBalancer.addListener(`${serviceId}HttpListener`, {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false
    });
    httpListener.addTargets(`${serviceId}HttpTargets`, {
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

    const publicLoadBalancer = new elbv2.ApplicationLoadBalancer(this, `${serviceId}LoadBalancer`, {
      loadBalancerName: loadBalancerName(deploymentTarget, runtimeResourceName, "pub"),
      vpc,
      internetFacing: true,
      securityGroup: publicLoadBalancerSecurityGroup,
      idleTimeout: cdk.Duration.seconds(SSE_IDLE_TIMEOUT_SECONDS)
    });
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "PublicHostedZone", {
      hostedZoneId: deploymentConfig.hostedZoneId,
      zoneName: deploymentConfig.hostedZoneName
    });
    const certificate = new acm.Certificate(this, `${serviceId}Certificate`, {
      domainName: deploymentConfig.sseDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone)
    });
    const listener = publicLoadBalancer.addListener(`${serviceId}HttpsListener`, {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(certificate)],
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "application/json",
        messageBody: JSON.stringify({
          error: {
            code: "ROUTE_NOT_FOUND",
            category: "VALIDATION",
            message: "Route not found.",
            retryable: false
          }
        })
      })
    });
    listener.addTargets(`${serviceId}SseTargets`, {
      conditions: [elbv2.ListenerCondition.pathPatterns(["/sessions/*/events"])],
      priority: 10,
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
    new route53.ARecord(this, "SessionEventsSseDnsRecord", {
      zone: hostedZone,
      recordName: deploymentConfig.sseDomainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(publicLoadBalancer))
    });
    return { service: fargateService, httpListener, httpsListener: listener, publicLoadBalancer, privateLoadBalancer };
  }

  private createDogfoodRuntimeContainerImage(constructId: string): ecs.ContainerImage {
    return ecs.ContainerImage.fromDockerImageAsset(
      new ecrAssets.DockerImageAsset(this, `${constructId}ImageAsset`, {
        directory: DOGFOOD_RUNTIME_DOCKER_CONTEXT,
        buildArgs: {
          PYTHON_BASE_IMAGE: PYTHON_SERVICE_BASE_IMAGE
        },
        buildContexts: dogfoodRuntimeBuildContexts(),
        extraHash: buildDogfoodRuntimeSourceHash(WORKSPACE_ROOT, DOGFOOD_RUNTIME_DOCKER_CONTEXT),
        platform: SERVICE_CONTAINER_IMAGE_PLATFORM
      })
    );
  }

  private buildSharedServiceEnvironment(
    deploymentTarget: DeploymentTarget,
    tables: Record<string, dynamodb.Table>,
    keys: Record<KmsPurpose, kms.Key>,
    apiBaseUrl: string,
    deploymentConfig: TargetDeploymentConfig,
    productAuth: ProductAuthResources
  ): Record<string, string> {
    const tableName = (name: string): string => tables[name]?.tableName ?? "";
    return {
      APP_ENV: deploymentTarget.environmentName,
      AWS_REGION: deploymentTarget.region,
      WEB_APP_BASE_URL: deploymentConfig.webAppBaseUrl,
      ALLOWED_ORIGINS: deploymentConfig.webAppBaseUrl,
      API_BASE_URL: apiBaseUrl,
      SSE_BASE_URL: `https://${deploymentConfig.sseDomainName}`,
      GOOGLE_OAUTH_CALLBACK_URL: cdk.Fn.join("", [apiBaseUrl, "/oauth/google/callback"]),
      GOOGLE_OAUTH_CLIENT_ID: deploymentConfig.googleOAuthClientId,
      TRUSTED_USER_MODE: "true",
      TRUSTED_USER_TENANT_ID: deploymentConfig.trustedUserTenantId,
      TRUSTED_USER_USER_ID: deploymentConfig.trustedUserUserId,
      TRUSTED_USER_AUTH_SUBJECT: deploymentConfig.trustedUserAuthSubject,
      PRODUCT_AUTH_ISSUER: productAuth.issuer,
      PRODUCT_AUTH_AUDIENCE: productAuth.audience,
      AI_ASSIST_ALLOWED_PRODUCT_USERS_JSON: JSON.stringify(deploymentConfig.allowedProductUsers),
      PLATFORM_PROVIDER_DEFAULT: "openai",
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
    if (deploymentTarget.environmentName === ENVIRONMENTS.DEV) {
      return;
    }

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

  private createDogfoodRuntimeRole(tables: Record<string, dynamodb.Table>, keys: Record<KmsPurpose, kms.Key>): iam.Role {
    const role = new iam.Role(this, "DogfoodRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Shared dogfood runtime role with the union of current MVP service data-plane grants."
    });
    const tableAccess = new Map<string, Set<string>>();
    const kmsAccess = new Map<KmsPurpose, Set<string>>();

    for (const boundary of IAM_BOUNDARY_MATRIX) {
      for (const accessBoundary of boundary.tableAccess) {
        const access = tableAccess.get(accessBoundary.table) ?? new Set<string>();
        accessBoundary.access.forEach((item) => access.add(item));
        tableAccess.set(accessBoundary.table, access);
      }
      for (const accessBoundary of boundary.kmsAccess) {
        const access = kmsAccess.get(accessBoundary.purpose) ?? new Set<string>();
        accessBoundary.access.forEach((item) => access.add(item));
        kmsAccess.set(accessBoundary.purpose, access);
      }
    }

    for (const [tableName, access] of [...tableAccess.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const table = tables[tableName];
      if (table) {
        role.addToPolicy(new iam.PolicyStatement({
          actions: dynamoDbActionsForAccess([...access]),
          resources: [table.tableArn]
        }));
      }
    }

    for (const [purpose, access] of [...kmsAccess.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const key = keys[purpose];
      if (key) {
        role.addToPolicy(new iam.PolicyStatement({
          actions: kmsActionsForAccess([...access]),
          resources: [key.keyArn]
        }));
      }
    }

    cdk.Tags.of(role).add("ai-assist:runtime-topology", "shared-dogfood");
    cdk.Tags.of(role).add("ai-assist:preserves-service-boundary-roles", "true");
    return role;
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

function formatRouteOwnershipEnvironment(): string {
  return SERVICE_ROUTES.map((route) => `${route.method} ${route.path}=${route.service}`).join(",");
}

function integrationRequestParameters(route: { readonly requiresAuthentication: boolean }, edgeJwtAuthEnabled: boolean): Record<string, string> {
  const parameters: Record<string, string> = {
    "overwrite:header.x-request-id": "$context.requestId",
    "overwrite:header.x-correlation-id": "$context.requestId"
  };

  if (route.requiresAuthentication && edgeJwtAuthEnabled) {
    parameters["overwrite:header.x-ai-assist-auth-subject"] = "$context.authorizer.jwt.claims.sub";
  }

  return parameters;
}

function dogfoodRuntimeBuildContexts(): Record<string, string> {
  const serviceContexts = Object.fromEntries(
    PYTHON_SERVICE_CONTAINER_ASSETS.map((asset) => [dogfoodBuildContextName(asset.service), path.join(WORKSPACE_ROOT, asset.sourceDirectory)])
  );
  return {
    python_service: PYTHON_SERVICE_DOCKER_CONTEXT,
    ...serviceContexts
  };
}

function dogfoodBuildContextName(service: ServiceName): string {
  if (service === SERVICES.AUTH) {
    return "auth_service";
  }
  if (service === SERVICES.SECRETS) {
    return "secrets_service";
  }
  if (service === SERVICES.ORCHESTRATION) {
    return "orchestration_service";
  }
  if (service === SERVICES.SESSION_EVENTS) {
    return "session_events_service";
  }
  if (service === SERVICES.CONTEXT) {
    return "context_service";
  }
  if (service === SERVICES.GOOGLE_DOCS_ADAPTER) {
    return "google_docs_adapter";
  }
  throw new Error(`unsupported dogfood runtime service context: ${service}`);
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
