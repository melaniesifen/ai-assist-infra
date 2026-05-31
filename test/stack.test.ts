import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import assert from "node:assert/strict";
import test from "node:test";
import { listDynamoDbTableSpecs } from "../src/config/dynamodb-tables";
import { listKmsPurposeMappings } from "../src/config/kms-purposes";
import { SERVICE_ROUTES } from "../src/config/service-routes";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new AiAssistInfraStack(app, "TestStack", {
    environmentName: "dev"
  });
  return Template.fromStack(stack);
}

test("synthesizes DynamoDB tables from the canonical table specs", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::DynamoDB::Table", listDynamoDbTableSpecs().length);
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "ai-assist-dev-SessionSecrets",
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
    TableName: "ai-assist-dev-ProposedActions",
    SSESpecification: Match.objectLike({
      SSEEnabled: true,
      SSEType: "KMS"
    })
  });
});

test("synthesizes KMS keys and aliases for every configured purpose", () => {
  const template = synthTemplate();

  template.resourceCountIs("AWS::KMS::Key", listKmsPurposeMappings().length);
  template.hasResourceProperties("AWS::KMS::Alias", {
    AliasName: "alias/ai-assist-dev-session-secrets-key"
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
    })
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
