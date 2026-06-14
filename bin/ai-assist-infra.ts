#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
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
  new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    env: {
      account,
      region: target.region
    },
    stackName: target.stackName
  });
}
