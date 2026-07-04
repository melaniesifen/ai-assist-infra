export const ENVIRONMENTS = Object.freeze({
  LOCAL: "local",
  DEV: "dev",
  GAMMA: "gamma",
  PROD: "prod"
} as const);

export type EnvironmentName = (typeof ENVIRONMENTS)[keyof typeof ENVIRONMENTS];

const ENVIRONMENT_ALIASES: Readonly<Record<string, EnvironmentName>> = Object.freeze({
  local: ENVIRONMENTS.LOCAL,
  development: ENVIRONMENTS.DEV,
  dev: ENVIRONMENTS.DEV,
  gamma: ENVIRONMENTS.GAMMA,
  staging: ENVIRONMENTS.GAMMA,
  stage: ENVIRONMENTS.GAMMA,
  production: ENVIRONMENTS.PROD,
  prod: ENVIRONMENTS.PROD
});

export interface DeploymentTarget {
  readonly environmentName: EnvironmentName;
  readonly accountEnvVar: string;
  readonly fallbackAccount?: string;
  readonly region: string;
  readonly runtimeResourceName: string;
  readonly stackName: string;
  readonly removalProtection: boolean;
  readonly logRetentionDays: number;
}

export const INITIAL_DEPLOYMENT_TARGETS: readonly DeploymentTarget[] = Object.freeze([
  target(ENVIRONMENTS.DEV, {
    runtimeResourceName: "dogfood-runtime",
    stackName: "AiAssistDevInfraStack",
    removalProtection: false,
    logRetentionDays: 30
  }),
  target(ENVIRONMENTS.GAMMA, {
    runtimeResourceName: "shared-runtime",
    stackName: "AiAssistGammaInfraStack",
    removalProtection: true,
    logRetentionDays: 90
  }),
  target(ENVIRONMENTS.PROD, {
    runtimeResourceName: "shared-runtime",
    stackName: "AiAssistProdInfraStack",
    removalProtection: true,
    logRetentionDays: 365
  })
]);

export function normalizeEnvironmentName(name: string): EnvironmentName {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("environment name is required");
  }

  const normalized = ENVIRONMENT_ALIASES[name.trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`unsupported environment: ${name}`);
  }

  return normalized;
}

export function isProductionEnvironment(name: string): boolean {
  return normalizeEnvironmentName(name) === ENVIRONMENTS.PROD;
}

export function buildEnvironmentResourceName(environment: string, resourceName: string): string {
  const normalizedEnvironment = normalizeEnvironmentName(environment);
  if (typeof resourceName !== "string" || !resourceName.trim()) {
    throw new Error("resource name is required");
  }

  return `ai-assist-${normalizedEnvironment}-${resourceName.trim()}`;
}

export function buildTargetResourceName(target: Pick<DeploymentTarget, "environmentName" | "region">, resourceName: string): string {
  const normalizedEnvironment = normalizeEnvironmentName(target.environmentName);
  const normalizedRegion = normalizeRegionName(target.region);
  if (typeof resourceName !== "string" || !resourceName.trim()) {
    throw new Error("resource name is required");
  }

  return `ai-assist-${normalizedEnvironment}-${normalizedRegion}-${resourceName.trim()}`;
}

export function listDeploymentTargets(): DeploymentTarget[] {
  return INITIAL_DEPLOYMENT_TARGETS.map((item) => ({ ...item }));
}

export function validateInitialDeploymentTargets(targets: readonly DeploymentTarget[] = INITIAL_DEPLOYMENT_TARGETS): { readonly valid: boolean; readonly errors: string[] } {
  const errors: string[] = [];
  if (targets.length !== 3) {
    errors.push("exactly three initial deployment targets are required");
  }

  const expected = new Set<EnvironmentName>([ENVIRONMENTS.DEV, ENVIRONMENTS.GAMMA, ENVIRONMENTS.PROD]);
  const seenNames = new Set<string>();
  const seenStacks = new Set<string>();
  const seenResourcePrefixes = new Set<string>();
  let accountEnvVar: string | null = null;

  for (const target of targets) {
    const environmentName = normalizeEnvironmentName(target.environmentName);
    if (!expected.delete(environmentName)) {
      errors.push(`${target.environmentName} is not an expected initial deployment target`);
    }
    if (target.region !== "us-west-2") {
      errors.push(`${environmentName} must deploy to us-west-2`);
    }
    if (accountEnvVar === null) {
      accountEnvVar = target.accountEnvVar;
    } else if (target.accountEnvVar !== accountEnvVar) {
      errors.push("initial deployment targets must use the same AWS account env var");
    }
    addUnique(seenNames, environmentName, `${environmentName} is duplicated`, errors);
    addUnique(seenStacks, target.stackName, `${target.stackName} stack name is duplicated`, errors);
    addUnique(seenResourcePrefixes, buildTargetResourceName(target, "probe"), `${environmentName} resource prefix is duplicated`, errors);
    if (environmentName !== ENVIRONMENTS.DEV && target.runtimeResourceName.includes("dogfood")) {
      errors.push(`${environmentName} runtime resource name must not include dogfood`);
    }
  }

  for (const missing of expected) {
    errors.push(`${missing} deployment target is required`);
  }

  return { valid: errors.length === 0, errors };
}

function target(environmentName: EnvironmentName, options: Omit<DeploymentTarget, "environmentName" | "accountEnvVar" | "region">): DeploymentTarget {
  return Object.freeze({
    environmentName,
    accountEnvVar: "CDK_DEFAULT_ACCOUNT",
    region: "us-west-2",
    ...options
  });
}

function normalizeRegionName(region: string): string {
  if (typeof region !== "string" || !/^[a-z]{2}-[a-z]+-\d$/.test(region.trim())) {
    throw new Error(`unsupported AWS region: ${region}`);
  }
  return region.trim();
}

function addUnique(values: Set<string>, value: string, message: string, errors: string[]): void {
  if (values.has(value)) {
    errors.push(message);
  }
  values.add(value);
}
