export const RUNTIME_CONFIG_CATEGORIES = Object.freeze({
  PRODUCT_AUTH: "product-auth",
  GOOGLE_OAUTH: "google-oauth",
  TOKEN_ENCRYPTION: "token-encryption",
  PLATFORM_PROVIDER: "platform-provider",
  SERVICE_URL: "service-url",
  CORS: "cors",
  TRUSTED_USER: "trusted-user"
} as const);

export type RuntimeConfigCategory = (typeof RUNTIME_CONFIG_CATEGORIES)[keyof typeof RUNTIME_CONFIG_CATEGORIES];

export interface RuntimeConfigRequirement {
  readonly name: string;
  readonly category: RuntimeConfigCategory;
  readonly description: string;
  readonly secret: boolean;
}

export interface RuntimeConfigValidationResult {
  readonly valid: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly setupStatus: "ready" | "blocked";
  readonly safeMessages: readonly string[];
}

export const REQUIRED_RUNTIME_CONFIG: readonly RuntimeConfigRequirement[] = Object.freeze([
  requirement("PRODUCT_AUTH_ISSUER", RUNTIME_CONFIG_CATEGORIES.PRODUCT_AUTH, "Product auth token issuer."),
  requirement("PRODUCT_AUTH_AUDIENCE", RUNTIME_CONFIG_CATEGORIES.PRODUCT_AUTH, "Product auth token audience."),
  requirement("PRODUCT_AUTH_HMAC_SECRET", RUNTIME_CONFIG_CATEGORIES.PRODUCT_AUTH, "Product auth HMAC signing secret.", true),
  requirement("WEB_APP_BASE_URL", RUNTIME_CONFIG_CATEGORIES.CORS, "Trusted web app base URL."),
  requirement("API_BASE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Public HTTP API base URL."),
  requirement("SSE_BASE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Public SSE base URL."),
  requirement("GOOGLE_OAUTH_CLIENT_ID", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Google OAuth client ID."),
  requirement("GOOGLE_OAUTH_CLIENT_SECRET_REF", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Secret reference for the Google OAuth client secret.", true),
  requirement("GOOGLE_OAUTH_CALLBACK_URL", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Configured OAuth callback URL."),
  requirement("OAUTH_STATE_SIGNING_SECRET", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Google OAuth state signing secret.", true),
  requirement("APP_KMS_KEY_ID", RUNTIME_CONFIG_CATEGORIES.TOKEN_ENCRYPTION, "Shared app KMS key ID or ARN."),
  requirement("PLATFORM_PROVIDER_SECRET_REF_OPENAI", RUNTIME_CONFIG_CATEGORIES.PLATFORM_PROVIDER, "Secret reference for the platform-owned OpenAI credential.", true),
  requirement("PLATFORM_PROVIDER_SECRET_REF_ANTHROPIC", RUNTIME_CONFIG_CATEGORIES.PLATFORM_PROVIDER, "Secret reference for the platform-owned Anthropic credential.", true),
  requirement("PLATFORM_PROVIDER_DEFAULT", RUNTIME_CONFIG_CATEGORIES.PLATFORM_PROVIDER, "Default platform provider."),
  requirement("TENANT_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Tenant table name."),
  requirement("OAUTH_TOKEN_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "OAuth token table name."),
  requirement("SESSION_SECRET_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Session secret table name."),
  requirement("CONSENT_GRANT_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Consent grant table name."),
  requirement("RESOURCE_SESSION_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Resource session table name."),
  requirement("PROPOSED_ACTION_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Proposed action table name."),
  requirement("SESSION_EVENT_TABLE_NAME", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Session event table name."),
  requirement("SESSION_SECRET_TTL_HOURS", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Session secret TTL in hours."),
  requirement("PROPOSED_ACTION_TTL_HOURS", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Proposed action TTL in hours."),
  requirement("SSE_HEARTBEAT_SECONDS", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "SSE heartbeat interval in seconds."),
  requirement("SSE_REPLAY_WINDOW_SECONDS", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "SSE replay window in seconds."),
  requirement("ALLOWED_ORIGINS", RUNTIME_CONFIG_CATEGORIES.CORS, "Comma-separated trusted frontend origins."),
  requirement("TRUSTED_USER_MODE", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Must be true for trusted-user dogfooding."),
  requirement("TRUSTED_USER_TENANT_ID", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Stable trusted-user tenant id."),
  requirement("TRUSTED_USER_USER_ID", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Stable trusted-user user id."),
  requirement("TRUSTED_USER_AUTH_SUBJECT", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Stable trusted-user auth subject."),
  requirement("TRUSTED_USER_BOOTSTRAP_SECRET", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Trusted-user bootstrap login secret.", true)
]);

export function validateRuntimeConfig(config: Record<string, string | undefined>): RuntimeConfigValidationResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const entry of REQUIRED_RUNTIME_CONFIG) {
    const value = config[entry.name];
    if (typeof value !== "string" || !value.trim()) {
      missing.push(entry.name);
      continue;
    }

    if (["WEB_APP_BASE_URL", "API_BASE_URL", "SSE_BASE_URL", "GOOGLE_OAUTH_CALLBACK_URL"].includes(entry.name)) {
      validateHttpsUrl(entry.name, value, invalid);
    }
    if (entry.name === "GOOGLE_OAUTH_CALLBACK_URL") {
      validateRequiredPath(entry.name, value, "/oauth/google/callback", invalid);
    }
    if (entry.name === "ALLOWED_ORIGINS") {
      validateCorsOrigins(value, invalid);
    }
    if (entry.name === "TRUSTED_USER_MODE" && value.trim().toLowerCase() !== "true") {
      invalid.push("TRUSTED_USER_MODE must be true for this trusted-user stack");
    }
    if (["SESSION_SECRET_TTL_HOURS", "PROPOSED_ACTION_TTL_HOURS", "SSE_HEARTBEAT_SECONDS", "SSE_REPLAY_WINDOW_SECONDS"].includes(entry.name)) {
      validatePositiveInteger(entry.name, value, invalid);
    }
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    setupStatus: missing.length === 0 && invalid.length === 0 ? "ready" : "blocked",
    safeMessages: [...missing.map((name) => `${name} is required`), ...invalid]
  };
}

export function listRuntimeConfigRequirements(): RuntimeConfigRequirement[] {
  return REQUIRED_RUNTIME_CONFIG.map((item) => ({ ...item }));
}

function requirement(name: string, category: RuntimeConfigCategory, description: string, secret = false): RuntimeConfigRequirement {
  return Object.freeze({ name, category, description, secret });
}

function validateHttpsUrl(name: string, value: string, invalid: string[]): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      invalid.push(`${name} must use https`);
    }
  } catch {
    invalid.push(`${name} must be a valid URL`);
  }
}

function validateRequiredPath(name: string, value: string, expectedPath: string, invalid: string[]): void {
  try {
    const url = new URL(value);
    if (url.pathname !== expectedPath) {
      invalid.push(`${name} must use ${expectedPath}`);
    }
  } catch {
    invalid.push(`${name} must be a valid URL`);
  }
}

function validateCorsOrigins(value: string, invalid: string[]): void {
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) {
    invalid.push("ALLOWED_ORIGINS must include at least one origin");
    return;
  }
  for (const origin of origins) {
    validateHttpsUrl(`ALLOWED_ORIGINS origin ${origin}`, origin, invalid);
  }
}

function validatePositiveInteger(name: string, value: string, invalid: string[]): void {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    invalid.push(`${name} must be a positive integer`);
  }
}
