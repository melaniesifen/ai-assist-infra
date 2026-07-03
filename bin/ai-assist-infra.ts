#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DEPLOYMENT_CONFIG_CONTEXT_KEY, parseDeploymentConfigContext } from "../src/config/deployment-config";
import { listDeploymentTargets } from "../src/config/environments";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";

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
  new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    deploymentConfig,
    env: {
      account,
      region: target.region
    },
    stackName: target.stackName
  });
}
