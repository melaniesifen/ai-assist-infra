import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentTarget, listDeploymentTargets } from "../src/config/environments";
import { listDynamoDbTableSpecs } from "../src/config/dynamodb-tables";
import { listKmsPurposeMappings } from "../src/config/kms-purposes";
import { OPERATIONAL_ALARMS } from "../src/config/operational-guardrails";
import { SERVICE_ROUTES } from "../src/config/service-routes";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";

const TEST_DEPLOYMENT_CONFIG = {
  hostedZoneId: "Z1234567890ABC",
  hostedZoneName: "example.test",
  sseDomainName: "sse.dev.example.test",
  edgeJwtAuthEnabled: true,
  productAuthIssuer: "https://auth.test.example/",
  productAuthAudience: "ai-assist-test",
  trustedUserTenantId: "test-tenant",
  trustedUserUserId: "test-user"
};

const TEST_DEV_EDGE_AUTH_DISABLED_CONFIG = {
  ...TEST_DEPLOYMENT_CONFIG,
  edgeJwtAuthEnabled: false,
  productAuthIssuer: "",
  productAuthAudience: "ai-assist-dev"
};

function synthTemplate(target: DeploymentTarget = listDeploymentTargets()[0]): Template {
  const app = new cdk.App();
  const stack = new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    deploymentConfig: TEST_DEPLOYMENT_CONFIG,
    stackName: target.stackName,
    env: {
      account: "111111111111",
      region: target.region
    }
  });
  return Template.fromStack(stack);
}

function synthTemplateWithDeploymentConfig(deploymentConfig: typeof TEST_DEPLOYMENT_CONFIG, target: DeploymentTarget = listDeploymentTargets()[0]): Template {
  const app = new cdk.App();
  const stack = new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    deploymentConfig,
    stackName: target.stackName,
    env: {
      account: "111111111111",
      region: target.region
    }
  });
  return Template.fromStack(stack);
}

function synthStack(target: DeploymentTarget): cdk.Stack {
  const app = new cdk.App();
  return new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    deploymentConfig: TEST_DEPLOYMENT_CONFIG,
    stackName: target.stackName,
    env: {
      account: "111111111111",
      region: target.region
    }
  });
}

test("synthesizes distinct dev gamma and prod deployment targets", () => {
  const [devTarget, gammaTarget, prodTarget] = listDeploymentTargets();
  const devTemplate = synthTemplate(devTarget);
  const gammaTemplate = synthTemplate(gammaTarget);
  const prodTemplate = synthTemplate(prodTarget);

  assert.equal(synthStack(devTarget).stackName, "AiAssistDevInfraStack");
  assert.equal(synthStack(gammaTarget).stackName, "AiAssistGammaInfraStack");
  assert.equal(synthStack(prodTarget).stackName, "AiAssistProdInfraStack");
  devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "ai-assist-dev-us-west-2-http-api"
  });
  gammaTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "ai-assist-gamma-us-west-2-http-api"
  });
  prodTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "ai-assist-prod-us-west-2-http-api"
  });
  gammaTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "ai-assist-gamma-us-west-2-SessionSecrets",
    DeletionProtectionEnabled: true
  });
  prodTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "ai-assist-prod-us-west-2-SessionSecrets",
    DeletionProtectionEnabled: true
  });
});

test("synthesizes DynamoDB tables from the canonical table specs", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::DynamoDB::Table", listDynamoDbTableSpecs().length);
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "ai-assist-dev-us-west-2-SessionSecrets",
    KeySchema: [
      { AttributeName: "tenantId", KeyType: "HASH" },
      { AttributeName: "userId#provider#secretId", KeyType: "RANGE" }
    ],
    TimeToLiveSpecification: {
      AttributeName: "ttl",
      Enabled: true
    }
  });
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "ai-assist-dev-us-west-2-ProposedActions",
    SSESpecification: Match.objectLike({
      SSEEnabled: true,
      SSEType: "KMS"
    })
  });
  template.hasResource("AWS::DynamoDB::Table", {
    Properties: Match.objectLike({
      TableName: "ai-assist-dev-us-west-2-OAuthTokens",
      Tags: Match.arrayWith([
        {
          Key: "ai-assist:encrypted-fields",
          Value: "encryptedAccessToken+encryptedRefreshToken"
        }
      ])
    })
  });
});

test("synthesizes one shared KMS app key for all configured purposes", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::KMS::Key", 1);
  template.resourceCountIs("AWS::KMS::Alias", 1);
  template.hasResourceProperties("AWS::KMS::Alias", {
    AliasName: "alias/ai-assist-dev-us-west-2-app-key"
  });
  template.hasResourceProperties("AWS::KMS::Key", {
    EnableKeyRotation: true,
    Tags: Match.arrayWith([
      {
        Key: "ai-assist:kms-purposes",
        Value: listKmsPurposeMappings().map((mapping) => mapping.purpose).join("+")
      }
    ])
  });
});

test("synthesizes the HTTP and SSE route inventory", () => {
  const template = synthTemplate();
  const apiGatewayRoutes = SERVICE_ROUTES.filter((route) => route.edgeSurface === "api-gateway");

  template.resourceCountIs("AWS::ApiGatewayV2::Route", apiGatewayRoutes.length);
  template.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /resource-sessions/{sessionId}/commands",
    AuthorizationType: "JWT",
    Target: Match.anyValue()
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /oauth/google/callback",
    AuthorizationType: "NONE",
    Target: Match.anyValue()
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /auth/login",
    AuthorizationType: "NONE",
    Target: Match.anyValue()
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /oauth/google/status",
    AuthorizationType: "JWT",
    Target: Match.anyValue()
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
    AuthorizerType: "JWT",
    IdentitySource: ["$request.header.Authorization"],
    JwtConfiguration: {
      Audience: ["ai-assist-test"],
      Issuer: "https://auth.test.example/"
    }
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    IntegrationType: "HTTP_PROXY",
    ConnectionType: "VPC_LINK",
    PayloadFormatVersion: "1.0",
    RequestParameters: Match.objectLike({
      "overwrite:header.x-request-id": "$context.requestId",
      "overwrite:header.x-correlation-id": "$context.requestId",
      "overwrite:header.x-ai-assist-tenant-id": "$context.authorizer.jwt.claims.tenant_id",
      "overwrite:header.x-ai-assist-user-id": "$context.authorizer.jwt.claims.user_id"
    })
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "ai-assist-dev-us-west-2-health-placeholder",
    Runtime: "nodejs20.x"
  });
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/lambda/ai-assist-dev-us-west-2-health-placeholder",
    RetentionInDays: 30
  });
  template.hasResourceProperties("AWS::Lambda::Permission", {
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com"
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    AutoDeploy: true,
    DefaultRouteSettings: Match.objectLike({
      ThrottlingBurstLimit: Match.anyValue(),
      ThrottlingRateLimit: Match.anyValue()
    }),
    AccessLogSettings: Match.objectLike({
      Format: Match.serializedJson(Match.objectLike({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status"
      }))
    })
  });
  const rendered = template.toJSON();
  const stageResource = Object.values(rendered.Resources as Record<string, { readonly Type: string; readonly Properties: Record<string, unknown> }>).find(
    (resource) => resource.Type === "AWS::ApiGatewayV2::Stage"
  );
  assert.ok(stageResource);
  assert.equal("RouteSettings" in stageResource.Properties, false);
});

test("can disable API Gateway edge JWT only for dev infra health deploys", () => {
  const template = synthTemplateWithDeploymentConfig(TEST_DEV_EDGE_AUTH_DISABLED_CONFIG);

  template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 0);
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /resource-sessions/{sessionId}/commands",
    AuthorizationType: "NONE",
    Target: Match.anyValue()
  });
});

test("synthesizes one shared Fargate runtime with private API ALB and public SSE ALB", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::ECS::Cluster", 1);
  template.resourceCountIs("AWS::ECS::Service", 1);
  template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
  template.resourceCountIs("AWS::SecretsManager::Secret", 2);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 2);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 2);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::ListenerRule", 1);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::TargetGroup", 2);
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internet-facing",
    LoadBalancerAttributes: Match.arrayWith([
      {
        Key: "idle_timeout.timeout_seconds",
        Value: "900"
      }
    ])
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internal"
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    Port: 80,
    Protocol: "HTTP"
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    Port: 443,
    Protocol: "HTTPS",
    DefaultActions: Match.arrayWith([
      Match.objectLike({
        Type: "fixed-response"
      })
    ])
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
    Priority: 10,
    Conditions: Match.arrayWith([
      Match.objectLike({
        Field: "path-pattern",
        PathPatternConfig: {
          Values: ["/sessions/*/events"]
        }
      })
    ]),
    Actions: Match.arrayWith([
      Match.objectLike({
        Type: "forward"
      })
    ])
  });
  const renderedResources = template.toJSON().Resources as Record<string, { readonly Type: string; readonly Properties: Record<string, unknown> }>;
  const publicHttpIngressRules = Object.values(renderedResources).filter((resource) =>
    resource.Type === "AWS::EC2::SecurityGroupIngress" &&
    resource.Properties.CidrIp === "0.0.0.0/0" &&
    resource.Properties.FromPort === 80 &&
    resource.Properties.ToPort === 80
  );
  assert.deepEqual(publicHttpIngressRules, [], "dogfood runtime API listener must not be publicly reachable on HTTP");
  template.hasResourceProperties("AWS::CertificateManager::Certificate", {
    DomainName: "sse.dev.example.test",
    DomainValidationOptions: Match.arrayWith([
      Match.objectLike({
        DomainName: "sse.dev.example.test",
        HostedZoneId: "Z1234567890ABC"
      })
    ]),
    ValidationMethod: "DNS"
  });
  template.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "sse.dev.example.test.",
    Type: "A",
    HostedZoneId: "Z1234567890ABC"
  });
  assert.ok(
    "SessionEventsSseDnsRecordD5FFBB2B" in (template.toJSON().Resources as Record<string, unknown>),
    "SSE DNS record must keep the old logical id so dev updates do not create a duplicate Route53 record"
  );
  template.hasResourceProperties("AWS::ECS::Service", {
    ServiceName: "ai-assist-dev-us-west-2-dogfood-runtime",
    PlatformVersion: "LATEST"
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    RuntimePlatform: {
      CpuArchitecture: "ARM64",
      OperatingSystemFamily: "LINUX"
    },
    RequiresCompatibilities: ["FARGATE"]
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Image: Match.anyValue(),
        Environment: Match.arrayWith([
          {
            Name: "TRUSTED_USER_TENANT_ID",
            Value: "test-tenant"
          },
          {
            Name: "TRUSTED_USER_USER_ID",
            Value: "test-user"
          },
          {
            Name: "PRODUCT_AUTH_AUDIENCE",
            Value: "ai-assist-test"
          },
          {
            Name: "SSE_HEARTBEAT_SECONDS",
            Value: "25"
          },
          {
            Name: "SSE_REPLAY_WINDOW_SECONDS",
            Value: "300"
          },
          {
            Name: "SERVICE_NAME",
            Value: "dogfood-runtime"
          },
          {
            Name: "ROUTE_OWNING_SERVICES",
            Value: Match.stringLikeRegexp("POST /auth/login=ai-assist-auth-service")
          }
        ]),
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: "PRODUCT_AUTH_HMAC_SECRET"
          }),
          Match.objectLike({
            Name: "OAUTH_STATE_SIGNING_SECRET"
          })
        ])
      })
    ])
  });
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "ai-assist-dev-us-west-2-product-auth-hmac-secret",
    GenerateSecretString: {
      PasswordLength: 48,
      ExcludePunctuation: true
    }
  });
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "ai-assist-dev-us-west-2-oauth-state-signing-secret",
    GenerateSecretString: {
      PasswordLength: 48,
      ExcludePunctuation: true
    }
  });
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/ecs/ai-assist-dev-us-west-2-dogfood-runtime",
    RetentionInDays: 30
  });
  template.hasResourceProperties("AWS::IAM::Role", {
    Description: "Shared dogfood runtime role with the union of current MVP service data-plane grants.",
    Tags: Match.arrayWith([
      {
        Key: "ai-assist:runtime-topology",
        Value: "shared-dogfood"
      }
    ])
  });
  assert.ok(JSON.stringify(template.toJSON()).includes("ai-assist:preserves-service-boundary-roles"));
});

test("does not require service image or auth/certificate parameters after switching to assets and local context", () => {
  const template = synthTemplate().toJSON();
  const parameterNames = Object.keys((template.Parameters ?? {}) as Record<string, unknown>);

  assert.equal(parameterNames.some((name) => name.endsWith("ImageUri")), false);
  assert.equal(parameterNames.includes("SseCertificateArn"), false);
  assert.equal(parameterNames.includes("ProductAuthIssuer"), false);
  assert.equal(parameterNames.includes("ProductAuthAudience"), false);
  assert.equal(JSON.stringify(template).includes("sseCertificateArn"), false);
});

test("omits optional CloudWatch dashboard and alarms in dev", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/apigateway/ai-assist-dev-us-west-2-http-api-access",
    RetentionInDays: 30
  });
});

test("preserves gamma and prod CloudWatch guardrails", () => {
  const [, gammaTarget, prodTarget] = listDeploymentTargets();
  const gammaTemplate = synthTemplate(gammaTarget);
  const prodTemplate = synthTemplate(prodTarget);

  gammaTemplate.resourceCountIs("AWS::CloudWatch::Alarm", OPERATIONAL_ALARMS.length);
  gammaTemplate.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  prodTemplate.resourceCountIs("AWS::CloudWatch::Alarm", OPERATIONAL_ALARMS.length);
  prodTemplate.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  gammaTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "ai-assist-gamma-us-west-2-OAuthErrorCount-alarm",
    TreatMissingData: "notBreaching"
  });
  prodTemplate.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "ai-assist-prod-us-west-2-OAuthErrorCount-alarm",
    TreatMissingData: "notBreaching"
  });
});

test("synthesizes operational access logs for guarded dependency paths", () => {
  const template = synthTemplate();

  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/apigateway/ai-assist-dev-us-west-2-http-api-access",
    RetentionInDays: 30
  });
});

test("synthesizes service roles and scoped IAM policy statements", () => {
  const template = synthTemplate();
  const roles = template.findResources("AWS::IAM::Role");
  const policies = template.findResources("AWS::IAM::Policy");
  const rendered = template.toJSON();
  const googleDocsPolicy = findPolicyForRole(rendered, "GoogleDocsAdapterRole");
  const authPolicy = findPolicyForRole(rendered, "AuthServiceRole");

  assert.ok(Object.keys(roles).length >= 6);
  assert.ok(JSON.stringify(policies).includes("dynamodb:PutItem"));
  assert.ok(JSON.stringify(policies).includes("kms:Decrypt"));
  assert.equal(JSON.stringify(policies).includes("session-secrets-key"), false);
  assert.equal(JSON.stringify(policies).includes("oauth-tokens-key"), false);
  assert.equal(JSON.stringify(policies).includes("proposed-actions-key"), false);
  assert.ok(JSON.stringify(rendered).includes("app-key"));
  assert.ok(JSON.stringify(policies).includes("SessionSecretsTable"));
  assert.ok(JSON.stringify(authPolicy).includes("dynamodb:PutItem"));
  assert.ok(JSON.stringify(authPolicy).includes("kms:Encrypt"));
  assert.equal(JSON.stringify(googleDocsPolicy).includes("dynamodb:PutItem"), false);
  assert.equal(JSON.stringify(googleDocsPolicy).includes("dynamodb:UpdateItem"), false);
  assert.equal(JSON.stringify(googleDocsPolicy).includes("dynamodb:DeleteItem"), false);
  assert.equal(JSON.stringify(googleDocsPolicy).includes("kms:Encrypt"), false);
  assert.equal(JSON.stringify(googleDocsPolicy).includes("kms:GenerateDataKey"), false);
  assert.ok(JSON.stringify(googleDocsPolicy).includes("dynamodb:GetItem"));
  assert.ok(JSON.stringify(googleDocsPolicy).includes("kms:Decrypt"));
});

function findPolicyForRole(template: Record<string, unknown>, rolePrefix: string): unknown {
  const resources = (template.Resources ?? {}) as Record<string, { readonly Type: string; readonly Properties: Record<string, unknown> }>;
  const roleId = Object.keys(resources).find((id) => id.startsWith(rolePrefix) && resources[id].Type === "AWS::IAM::Role");
  assert.ok(roleId, `expected role with prefix ${rolePrefix}`);

  const policy = Object.values(resources).find((resource) => {
    const roles = resource.Properties?.Roles;
    return resource.Type === "AWS::IAM::Policy" && Array.isArray(roles) && roles.some((role) => typeof role === "object" && role !== null && "Ref" in role && role.Ref === roleId);
  });
  assert.ok(policy, `expected policy for role ${roleId}`);
  return policy;
}
