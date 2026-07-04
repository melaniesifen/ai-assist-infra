import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { TargetDeploymentConfig, getWebAppDomainName } from "../config/deployment-config";
import { DeploymentTarget, buildTargetResourceName } from "../config/environments";

export interface AiAssistWebCertificateStackProps extends cdk.StackProps {
  readonly deploymentTarget: DeploymentTarget;
  readonly deploymentConfig: TargetDeploymentConfig;
}

export class AiAssistWebCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: AiAssistWebCertificateStackProps) {
    super(scope, id, props);

    const webAppDomainName = getWebAppDomainName(props.deploymentConfig.webAppBaseUrl);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "WebAppHostedZone", {
      hostedZoneId: props.deploymentConfig.hostedZoneId,
      zoneName: props.deploymentConfig.hostedZoneName
    });

    this.certificate = new acm.Certificate(this, "WebAppCertificate", {
      certificateName: buildTargetResourceName(props.deploymentTarget, "web-app-certificate"),
      domainName: webAppDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone)
    });

    new cdk.CfnOutput(this, "WebAppCertificateArn", {
      value: this.certificate.certificateArn
    });
  }
}
