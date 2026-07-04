import { EnvironmentName } from "./environments";

export const DEPLOYMENT_CONFIG_CONTEXT_KEY = "aiAssistDeploymentConfig";

export interface TargetDeploymentConfig {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly sseDomainName: string;
  readonly productAuthIssuer: string;
  readonly productAuthAudience: string;
  readonly allowedProductUsers: readonly AllowedProductUserConfig[];
  readonly trustedUserTenantId: string;
  readonly trustedUserUserId: string;
  readonly trustedUserAuthSubject: string;
  readonly webAppBaseUrl: string;
  readonly googleOAuthClientId: string;
  readonly edgeJwtAuthEnabled: boolean;
}

export type DeploymentConfigByTarget = Partial<Record<EnvironmentName, TargetDeploymentConfig>>;

export interface AllowedProductUserConfig {
  readonly authSubject: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: "owner" | "member";
  readonly status: "active" | "disabled";
}

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
  const edgeJwtAuthEnabled = value.edgeJwtAuthEnabled !== undefined ? requireBoolean(value.edgeJwtAuthEnabled, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.edgeJwtAuthEnabled`) : true;
  const productAuthIssuer = optionalString(value.productAuthIssuer);
  const productAuthAudience = optionalString(value.productAuthAudience);
  const allowedProductUsers = parseAllowedProductUsers(value.allowedProductUsers, environmentName);
  const trustedUserTenantId = requireString(value.trustedUserTenantId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.trustedUserTenantId`);
  const trustedUserUserId = requireString(value.trustedUserUserId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.trustedUserUserId`);
  const trustedUserAuthSubject = requireString(value.trustedUserAuthSubject, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.trustedUserAuthSubject`);
  const webAppBaseUrl = normalizeHttpsOrigin(requireString(value.webAppBaseUrl, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.webAppBaseUrl`), `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.webAppBaseUrl`);
  const googleOAuthClientId = requireString(value.googleOAuthClientId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.googleOAuthClientId`);

  if (!/^Z[A-Z0-9]+$/.test(hostedZoneId)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneId must be a Route 53 hosted zone id`);
  }
  if (!isValidDnsName(hostedZoneName)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.hostedZoneName must be a valid DNS name`);
  }
  if (!isValidDnsName(sseDomainName) || !isSubdomainOf(sseDomainName, hostedZoneName)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.sseDomainName must be a subdomain of hostedZoneName`);
  }
  const webAppDomainName = getWebAppDomainName(webAppBaseUrl);
  if (!isValidDnsName(webAppDomainName) || !isSubdomainOf(webAppDomainName, hostedZoneName)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.webAppBaseUrl host must be a subdomain of hostedZoneName`);
  }
  if (webAppDomainName === sseDomainName) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.webAppBaseUrl host must be different from sseDomainName`);
  }
  if (!edgeJwtAuthEnabled && environmentName !== "dev") {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.edgeJwtAuthEnabled may be false only for dev`);
  }
  if (productAuthIssuer) {
    validateHttpsUrl(productAuthIssuer, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.productAuthIssuer`);
  }
  if (edgeJwtAuthEnabled && allowedProductUsers.length === 0) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers must include at least one active allowed user when edgeJwtAuthEnabled is true`);
  }

  return {
    hostedZoneId,
    hostedZoneName,
    sseDomainName,
    productAuthIssuer,
    productAuthAudience,
    allowedProductUsers,
    trustedUserTenantId,
    trustedUserUserId,
    trustedUserAuthSubject,
    webAppBaseUrl,
    googleOAuthClientId,
    edgeJwtAuthEnabled
  };
}

function parseAllowedProductUsers(value: unknown, environmentName: EnvironmentName): AllowedProductUserConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers must be an array`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}] must be an object`);
    }
    const authSubject = requireString(item.authSubject, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].authSubject`);
    if (seen.has(authSubject)) {
      throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers authSubject values must be unique`);
    }
    seen.add(authSubject);
    const role = requireString(item.role, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].role`);
    if (role !== "owner" && role !== "member") {
      throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].role must be owner or member`);
    }
    const status = requireString(item.status, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].status`);
    if (status !== "active" && status !== "disabled") {
      throw new Error(`${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].status must be active or disabled`);
    }
    return {
      authSubject,
      tenantId: requireString(item.tenantId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].tenantId`),
      userId: requireString(item.userId, `${DEPLOYMENT_CONFIG_CONTEXT_KEY}.${environmentName}.allowedProductUsers[${index}].userId`),
      role,
      status
    };
  });
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

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeDomainName(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeHttpsOrigin(value: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${fieldName} must be an https origin URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.port
  ) {
    throw new Error(`${fieldName} must be an https origin URL without path, query, fragment, credentials, or port`);
  }
  return parsed.origin;
}

function validateHttpsUrl(value: string, fieldName: string): void {
  try {
    const issuer = new URL(value);
    if (issuer.protocol !== "https:") {
      throw new Error("issuer must use https");
    }
  } catch {
    throw new Error(`${fieldName} must be an https URL`);
  }
}

export function getWebAppDomainName(webAppBaseUrl: string): string {
  return new URL(webAppBaseUrl).hostname.toLowerCase();
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
