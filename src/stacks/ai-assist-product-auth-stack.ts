import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { TargetDeploymentConfig } from "../config/deployment-config";
import { DeploymentTarget, ENVIRONMENTS, buildTargetResourceName, isProductionEnvironment, normalizeEnvironmentName } from "../config/environments";

export interface AiAssistProductAuthStackProps extends cdk.StackProps {
  readonly environmentName?: string;
  readonly deploymentTarget?: DeploymentTarget;
  readonly deploymentConfig?: Pick<TargetDeploymentConfig, "productAuthHostedUiCallbackUrls" | "productAuthHostedUiLogoutUrls" | "productAuthHostedUiDomainPrefix">;
}

export interface ProductAuthResources {
  readonly issuer: string;
  readonly audience: string;
  readonly userPoolId: string;
  readonly hostedUiOrigin: string;
  readonly callbackUrls: readonly string[];
  readonly logoutUrls: readonly string[];
}

const PRODUCT_AUTH_GROUPS = ["owner", "member"] as const;
const PRODUCT_AUTH_SCOPES = [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE] as const;

export class AiAssistProductAuthStack extends cdk.Stack {
  public readonly productAuth: ProductAuthResources;
  public readonly userPool: cognito.UserPool;
  public readonly appClient: cognito.UserPoolClient;

  public constructor(scope: Construct, id: string, props: AiAssistProductAuthStackProps = {}) {
    super(scope, id, props);

    const deploymentTarget = props.deploymentTarget ?? {
      environmentName: normalizeEnvironmentName(props.environmentName ?? ENVIRONMENTS.DEV),
      accountEnvVar: "CDK_DEFAULT_ACCOUNT",
      region: "us-west-2",
      runtimeResourceName: "dogfood-runtime",
      stackName: id,
      removalProtection: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV),
      logRetentionDays: isProductionEnvironment(props.environmentName ?? ENVIRONMENTS.DEV) ? 365 : 30
    };
    const environmentName = normalizeEnvironmentName(deploymentTarget.environmentName);
    const callbackUrls = props.deploymentConfig?.productAuthHostedUiCallbackUrls ?? [`https://replace-with-${environmentName}-extension-id.chromiumapp.org/`];
    const logoutUrls = props.deploymentConfig?.productAuthHostedUiLogoutUrls ?? callbackUrls;
    const hostedUiDomainPrefix = props.deploymentConfig?.productAuthHostedUiDomainPrefix ?? buildTargetResourceName(deploymentTarget, "product-auth");

    const userPool = new cognito.UserPool(this, "ProductAuthUserPool", {
      userPoolName: buildTargetResourceName(deploymentTarget, "product-auth-users"),
      selfSignUpEnabled: false,
      signInAliases: {
        email: true
      },
      removalPolicy: deploymentTarget.removalProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });
    const appClient = userPool.addClient("ProductAuthAppClient", {
      userPoolClientName: buildTargetResourceName(deploymentTarget, "product-auth-app-client"),
      generateSecret: false,
      authFlows: {
        userSrp: true
      },
      oAuth: {
        flows: {
          implicitCodeGrant: true
        },
        scopes: [...PRODUCT_AUTH_SCOPES],
        callbackUrls: [...callbackUrls],
        logoutUrls: [...logoutUrls]
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      authSessionValidity: cdk.Duration.minutes(15)
    });
    userPool.addDomain("ProductAuthHostedUiDomain", {
      cognitoDomain: {
        domainPrefix: hostedUiDomainPrefix
      }
    });
    const hostedUiOrigin = cdk.Fn.join("", ["https://", hostedUiDomainPrefix, ".auth.", cdk.Stack.of(this).region, ".amazoncognito.com"]);

    for (const groupName of PRODUCT_AUTH_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `${toPascalCase(groupName)}ProductAuthGroup`, {
        userPoolId: userPool.userPoolId,
        groupName,
        description: `AI Assist ${groupName} product-auth users for ${environmentName}.`
      });
    }

    this.userPool = userPool;
    this.appClient = appClient;
    this.productAuth = {
      issuer: cdk.Fn.join("", ["https://cognito-idp.", cdk.Stack.of(this).region, ".amazonaws.com/", userPool.userPoolId]),
      audience: appClient.userPoolClientId,
      userPoolId: userPool.userPoolId,
      hostedUiOrigin,
      callbackUrls,
      logoutUrls
    };

    cdk.Tags.of(this).add("ai-assist:environment", environmentName);
    cdk.Tags.of(this).add("ai-assist:region", deploymentTarget.region);

    new cdk.CfnOutput(this, "ProductAuthIssuer", {
      value: this.productAuth.issuer
    });
    new cdk.CfnOutput(this, "ProductAuthAudience", {
      value: this.productAuth.audience
    });
    new cdk.CfnOutput(this, "ProductAuthUserPoolId", {
      value: this.productAuth.userPoolId
    });
    new cdk.CfnOutput(this, "ProductAuthHostedUiOrigin", {
      value: this.productAuth.hostedUiOrigin
    });
    new cdk.CfnOutput(this, "ProductAuthAppClientId", {
      value: this.productAuth.audience
    });
    new cdk.CfnOutput(this, "ProductAuthOAuthScopes", {
      value: PRODUCT_AUTH_SCOPES.map((scope) => scope.scopeName).join(",")
    });
    new cdk.CfnOutput(this, "ProductAuthCallbackUrls", {
      value: cdk.Fn.join(",", [...callbackUrls])
    });
    new cdk.CfnOutput(this, "ProductAuthLogoutUrls", {
      value: cdk.Fn.join(",", [...logoutUrls])
    });
  }
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
