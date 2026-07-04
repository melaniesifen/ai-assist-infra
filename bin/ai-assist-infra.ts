#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DEPLOYMENT_CONFIG_CONTEXT_KEY, parseDeploymentConfigContext } from "../src/config/deployment-config";
import { listDeploymentTargets } from "../src/config/environments";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";
import { AiAssistProductAuthStack } from "../src/stacks/ai-assist-product-auth-stack";
import { AiAssistWebCertificateStack } from "../src/stacks/ai-assist-web-certificate-stack";

const CLOUDFRONT_CERTIFICATE_REGION = "us-east-1";

const app = new cdk.App();
const targets = listDeploymentTargets();

for (const target of targets) {
  const account = process.env[target.accountEnvVar] ?? target.fallbackAccount;
  if (account) {
    app.node.setContext(`availability-zones:account=${account}:region=${target.region}`, [`${target.region}a`, `${target.region}b`]);
  }
}

for (const target of targets) {
  const account = process.env[target.accountEnvVar] ?? target.fallbackAccount;
  const deploymentConfig = parseDeploymentConfigContext(app.node.tryGetContext(DEPLOYMENT_CONFIG_CONTEXT_KEY), target.environmentName);
  const authStack = new AiAssistProductAuthStack(app, authStackName(target.stackName), {
    deploymentTarget: target,
    deploymentConfig,
    env: {
      account,
      region: target.region
    },
    stackName: authStackName(target.stackName)
  });
  const certificateStack = new AiAssistWebCertificateStack(app, webCertificateStackName(target.stackName), {
    deploymentTarget: target,
    deploymentConfig,
    crossRegionReferences: true,
    env: {
      account,
      region: CLOUDFRONT_CERTIFICATE_REGION
    },
    stackName: webCertificateStackName(target.stackName)
  });
  const infraStack = new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    deploymentConfig,
    productAuth: authStack.productAuth,
    webAppCertificate: certificateStack.certificate,
    crossRegionReferences: true,
    env: {
      account,
      region: target.region
    },
    stackName: target.stackName
  });
  infraStack.addDependency(authStack);
  infraStack.addDependency(certificateStack);
}

function authStackName(infraStackName: string): string {
  return infraStackName.replace(/InfraStack$/, "AuthStack");
}

function webCertificateStackName(infraStackName: string): string {
  return infraStackName.replace(/InfraStack$/, "WebCertificateStack");
}
