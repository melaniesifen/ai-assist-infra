#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { listDeploymentTargets } from "../src/config/environments";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";

const app = new cdk.App();

for (const target of listDeploymentTargets()) {
  new AiAssistInfraStack(app, target.stackName, {
    deploymentTarget: target,
    env: {
      account: process.env[target.accountEnvVar] ?? target.fallbackAccount,
      region: target.region
    },
    stackName: target.stackName
  });
}
