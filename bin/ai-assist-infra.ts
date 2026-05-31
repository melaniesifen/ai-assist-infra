#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiAssistInfraStack } from "../src/stacks/ai-assist-infra-stack";

const app = new cdk.App();
const environmentName = app.node.tryGetContext("environment") ?? process.env.AI_ASSIST_ENVIRONMENT ?? "dev";

new AiAssistInfraStack(app, "AiAssistInfraStack", {
  environmentName
});
