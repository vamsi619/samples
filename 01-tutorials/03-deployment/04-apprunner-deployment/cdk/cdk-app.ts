#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib";
import { StrandsAppRunnerStack } from "./stacks/strands-apprunner-stack";
import { AwsSolutionsChecks } from "cdk-nag";
import { projectName, envNameType } from "./constant";

const app = new App();

const envName: envNameType = app.node.tryGetContext("envName") || "sagemaker";

new StrandsAppRunnerStack(app, `${projectName}AppRunnerStack`, {
  /* Uncomment to pin to a specific account/region:
   * env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }, */
  envName: envName,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
