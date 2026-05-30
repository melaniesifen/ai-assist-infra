export const ENVIRONMENTS = Object.freeze({
  LOCAL: "local",
  DEV: "dev",
  STAGE: "stage",
  PROD: "prod"
});

const ENVIRONMENT_ALIASES = Object.freeze({
  local: ENVIRONMENTS.LOCAL,
  development: ENVIRONMENTS.DEV,
  dev: ENVIRONMENTS.DEV,
  staging: ENVIRONMENTS.STAGE,
  stage: ENVIRONMENTS.STAGE,
  production: ENVIRONMENTS.PROD,
  prod: ENVIRONMENTS.PROD
});

export function normalizeEnvironmentName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("environment name is required");
  }

  const normalized = ENVIRONMENT_ALIASES[name.trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`unsupported environment: ${name}`);
  }

  return normalized;
}

export function isProductionEnvironment(name) {
  return normalizeEnvironmentName(name) === ENVIRONMENTS.PROD;
}

export function buildEnvironmentResourceName(environment, resourceName) {
  const normalizedEnvironment = normalizeEnvironmentName(environment);
  if (typeof resourceName !== "string" || !resourceName.trim()) {
    throw new Error("resource name is required");
  }

  return `ai-assist-${normalizedEnvironment}-${resourceName.trim()}`;
}
