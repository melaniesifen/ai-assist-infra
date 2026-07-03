import { EnvironmentName } from "./environments";

export const DEPLOYMENT_CONFIG_CONTEXT_KEY = "aiAssistDeploymentConfig";

export interface TargetDeploymentConfig {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly sseDomainName: string;
  readonly productAuthIssuer: string;
  readonly productAuthAudience: string;
}

export type DeploymentConfigByTarget = Partial<Record<EnvironmentName, TargetDeploymentConfig>>;

export function parseDeploymentConfigContext(contextValue: unknown, environmentName: EnvironmentName): TargetDeploymentConfig {
  const parsed = parseContextValue(contextValue);
  if (!isPlainObject(parsed)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY} context is required`);
  }

  const targetConfig = parsed[environmentName];
  if (!isPlainObject(targetConfig)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName} is required`);
  }

  return validateTargetDeploymentConfig(environmentName, targetConfig);
}

export function validateTargetDeploymentConfig(environmentName: EnvironmentName, value: Record<string, unknown>): TargetDeploymentConfig {
  const hostedZoneId = requireString(value.hostedZoneId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneId`);
  const hostedZoneName = normalizeDomainName(requireString(value.hostedZoneName, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneName`));
  const sseDomainName = normalizeDomainName(requireString(value.sseDomainName, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.sseDomainName`));
  const productAuthIssuer = requireString(value.productAuthIssuer, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.productAuthIssuer`);
  const productAuthAudience = requireString(value.productAuthAudience, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.productAuthAudience`);

  if (!/^Z[A-Z0-9]+$/.test(hostedZoneId)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneId must be a Route 53 hosted zone id`);
  }
  if (!isValidDnsName(hostedZoneName)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneName must be a valid DNS name`);
  }
  if (!isValidDnsName(sseDomainName) || !isSubdomainOf(sseDomainName, hostedZoneName)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.sseDomainName must be a subdomain of hostedZoneName`);
  }
  try {
    const issuer = new URL(productAuthIssuer);
    if (issuer.protocol !== "https:") {
      throw new Error("issuer must use https");
    }
  } catch {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.productAuthIssuer must be an https URL`);
  }

  return {
    hostedZoneId,
    hostedZoneName,
    sseDomainName,
    productAuthIssuer,
    productAuthAudience
  };
}

function parseContextValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY} context must be an object or JSON string`);
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function normalizeDomainName(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function isValidDnsName(value: string): boolean {
  return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(value);
}

function isSubdomainOf(domainName: string, parentDomainName: string): boolean {
  return domainName !== parentDomainName && domainName.endsWith(`.${parentDomainName}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
