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

function synthTemplate(target: DeploymentTarget = listDeploymentTargets()[0]): Template {
  const app = new cdk.App();
  const stack = new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
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
    stackName: target.stackName,
    env: {
      account: "111111111111",
      region: target.region
    }
  });
}

test("synthesizes distinct dev and prod deployment targets", () => {
  const [devTarget, prodTarget] = listDeploymentTargets();
  const devTemplate = synthTemplate(devTarget);
  const prodTemplate = synthTemplate(prodTarget);

  assert.equal(synthStack(devTarget).stackName, "AiAssistDevInfraStack");
  assert.equal(synthStack(prodTarget).stackName, "AiAssistProdInfraStack");
  devTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "ai-assist-dev-us-west-2-http-api"
  });
  prodTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "ai-assist-prod-us-west-2-http-api"
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

test("synthesizes KMS keys and aliases for every configured purpose", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::KMS::Key", listKmsPurposeMappings().length);
  template.hasResourceProperties("AWS::KMS::Alias", {
    AliasName: "alias/ai-assist-dev-us-west-2-session-secrets-key"
  });
  template.hasResourceProperties("AWS::KMS::Key", {
    EnableKeyRotation: true
  });
});

test("synthesizes the HTTP and SSE route inventory", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::ApiGatewayV2::Route", SERVICE_ROUTES.length);
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /resource-sessions/{sessionId}/events"
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    AutoDeploy: true,
    RouteSettings: Match.objectLike({
      "POST /resource-sessions/{sessionId}/commands": {
        ThrottlingBurstLimit: 5,
        ThrottlingRateLimit: 20 / 60
      },
      "GET /resource-sessions/{sessionId}/events": {
        ThrottlingBurstLimit: 3,
        ThrottlingRateLimit: 10 / 60
      }
    }),
    AccessLogSettings: Match.objectLike({
      Format: Match.serializedJson(Match.objectLike({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status"
      }))
    })
  });
});

test("synthesizes operational alarms for guarded dependency paths", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::CloudWatch::Alarm", OPERATIONAL_ALARMS.length);
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "ai-assist-dev-us-west-2-OAuthErrorCount-alarm",
    TreatMissingData: "notBreaching"
  });
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

  assert.equal(Object.keys(roles).length, 6);
  assert.ok(JSON.stringify(policies).includes("dynamodb:PutItem"));
  assert.ok(JSON.stringify(policies).includes("kms:Decrypt"));
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
