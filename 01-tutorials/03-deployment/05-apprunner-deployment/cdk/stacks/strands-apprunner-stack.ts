import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";
import { envNameType, projectName, s3BucketProps, ssmParamDynamoDb, ssmParamKnowledgeBaseId } from "../constant";
import { setSecureTransport } from "../utility";

interface StrandsAppRunnerStackProps extends StackProps {
  envName: envNameType;
}

export class StrandsAppRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props: StrandsAppRunnerStackProps) {
    super(scope, id, props);

    // Retrieve SSM parameters set up by deploy_prereqs.sh
    const knowledgeBaseId = ssm.StringParameter.fromStringParameterName(
      this,
      `${projectName}-knowledge-base-id`,
      `/${ssmParamKnowledgeBaseId}`,
    );

    const dynamoDBName = ssm.StringParameter.fromStringParameterName(
      this,
      `${projectName}-dynamo-db-name`,
      `/${ssmParamDynamoDb}`,
    );

    // S3 access log bucket
    const accessLogBucket = new s3.Bucket(this, `${projectName}-access-bucket-access-logs`, {
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      ...s3BucketProps,
    });
    setSecureTransport(accessLogBucket);

    // S3 bucket for agent session state
    const agentBucket = new s3.Bucket(this, `${projectName}-agent-bucket`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: accessLogBucket,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsPrefix: `${projectName}-agent-bucket-access-logs`,
      ...s3BucketProps,
    });
    setSecureTransport(agentBucket);

    // CloudWatch log group for App Runner service logs
    const logGroup = new logs.LogGroup(this, `${projectName}-service-logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Build Docker image
    // The Dockerfile is in the parent directory — we're building the image in the docker/ folder
    const dockerAsset = new ecrAssets.DockerImageAsset(this, `${projectName}-image`, {
      directory: path.join(__dirname, "../../docker"),
      file: "./Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
      ...(props.envName === "sagemaker" && { networkMode: ecrAssets.NetworkMode.custom("sagemaker") }),
    });

    // ECR access role — allows App Runner to pull the container image from ECR
    const accessRole = new iam.Role(this, `${projectName}-apprunner-access-role`, {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSAppRunnerServicePolicyForECRAccess"),
      ],
    });

    // Instance role — permissions available to the running container
    const instanceRole = new iam.Role(this, `${projectName}-apprunner-instance-role`, {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
    });

    agentBucket.grantReadWrite(instanceRole);

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
      }),
    );

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve"],
        resources: [
          `arn:aws:bedrock:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:knowledge-base/${knowledgeBaseId.stringValue}`,
        ],
      }),
    );

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:ListTables",
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:GetRecords",
          "dynamodb:DeleteItem",
          "dynamodb:UpdateItem",
          "dynamodb:UpdateTable",
        ],
        resources: [
          `arn:aws:dynamodb:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:table/${dynamoDBName.stringValue}`,
        ],
      }),
    );

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${process.env.CDK_DEFAULT_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:parameter/${ssmParamDynamoDb}`,
        ],
      }),
    );

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );

    // App Runner service — replaces VPC + ECS Cluster + ALB + FargateService
    // App Runner manages networking, load balancing, TLS, and auto-scaling automatically
    const service = new apprunner.CfnService(this, `${projectName}-apprunner-service`, {
      serviceName: `${projectName.toLowerCase()}-apprunner-service`,
      sourceConfiguration: {
        // Tells App Runner how to authenticate to ECR to pull the image
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        imageRepository: {
          imageIdentifier: dockerAsset.imageUri,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: "8000",
            runtimeEnvironmentVariables: [
              { name: "KNOWLEDGE_BASE_ID", value: knowledgeBaseId.stringValue },
              { name: "AGENT_BUCKET", value: agentBucket.bucketName },
              { name: "LOG_LEVEL", value: "INFO" },
            ],
          },
        },
        // Disable auto-deployments on image push; deployments are triggered manually
        autoDeploymentsEnabled: false,
      },
      instanceConfiguration: {
        cpu: "1 vCPU",
        memory: "2 GB",
        instanceRoleArn: instanceRole.roleArn,
      },
      healthCheckConfiguration: {
        protocol: "HTTP",
        path: "/health",
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
    });

    // Output the App Runner service URL (HTTPS by default — no cert management needed)
    new CfnOutput(this, `${projectName}-service-url`, {
      value: service.attrServiceUrl,
      exportName: `${projectName}-apprunner-service-url`,
      description: "The HTTPS URL of the App Runner service",
    });

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${projectName}AppRunnerStack/${projectName}-apprunner-access-role/Resource`,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "AWSAppRunnerServicePolicyForECRAccess is the required managed policy for App Runner ECR access.",
        },
      ],
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${projectName}AppRunnerStack/${projectName}-apprunner-instance-role/DefaultPolicy/Resource`,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Wildcard on Bedrock InvokeModel is intentional to allow all foundation models.",
        },
      ],
    );
  }
}
