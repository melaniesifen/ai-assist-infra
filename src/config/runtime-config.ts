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
  requirement("AI_ASSIST_PRODUCT_AUTH_ISSUER", RUNTIME_CONFIG_CATEGORIES.PRODUCT_AUTH, "Product auth token issuer."),
  requirement("AI_ASSIST_PRODUCT_AUTH_AUDIENCE", RUNTIME_CONFIG_CATEGORIES.PRODUCT_AUTH, "Product auth token audience."),
  requirement("GOOGLE_OAUTH_CLIENT_ID", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Google OAuth client ID."),
  requirement("GOOGLE_OAUTH_CLIENT_SECRET_ARN", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Secret reference for the Google OAuth client secret.", true),
  requirement("GOOGLE_OAUTH_REDIRECT_URI", RUNTIME_CONFIG_CATEGORIES.GOOGLE_OAUTH, "Configured OAuth callback redirect URI."),
  requirement("AI_ASSIST_TOKEN_KMS_KEY_ALIAS", RUNTIME_CONFIG_CATEGORIES.TOKEN_ENCRYPTION, "KMS alias for OAuth token encryption."),
  requirement("AI_ASSIST_PLATFORM_PROVIDER_SECRET_ARN", RUNTIME_CONFIG_CATEGORIES.PLATFORM_PROVIDER, "Secret reference for the platform-owned provider credential.", true),
  requirement("AI_ASSIST_AUTH_SERVICE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Auth service base URL."),
  requirement("AI_ASSIST_SECRETS_SERVICE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Secrets service base URL."),
  requirement("AI_ASSIST_CONTEXT_SERVICE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Context service base URL."),
  requirement("AI_ASSIST_ORCHESTRATION_SERVICE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Orchestration service base URL."),
  requirement("AI_ASSIST_SESSION_EVENTS_SERVICE_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Session events service base URL."),
  requirement("AI_ASSIST_GOOGLE_DOCS_ADAPTER_URL", RUNTIME_CONFIG_CATEGORIES.SERVICE_URL, "Google Docs adapter base URL."),
  requirement("AI_ASSIST_ALLOWED_CORS_ORIGINS", RUNTIME_CONFIG_CATEGORIES.CORS, "Comma-separated trusted frontend origins."),
  requirement("AI_ASSIST_TRUSTED_USER_MODE", RUNTIME_CONFIG_CATEGORIES.TRUSTED_USER, "Must be true for trusted-user dogfooding.")
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

    if (entry.category === RUNTIME_CONFIG_CATEGORIES.SERVICE_URL || entry.name === "GOOGLE_OAUTH_REDIRECT_URI") {
      validateHttpsUrl(entry.name, value, invalid);
    }
    if (entry.name === "AI_ASSIST_ALLOWED_CORS_ORIGINS") {
      validateCorsOrigins(value, invalid);
    }
    if (entry.name === "AI_ASSIST_TRUSTED_USER_MODE" && value.trim().toLowerCase() !== "true") {
      invalid.push("AI_ASSIST_TRUSTED_USER_MODE must be true for this trusted-user stack");
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

function validateCorsOrigins(value: string, invalid: string[]): void {
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) {
    invalid.push("AI_ASSIST_ALLOWED_CORS_ORIGINS must include at least one origin");
    return;
  }
  for (const origin of origins) {
    validateHttpsUrl(`AI_ASSIST_ALLOWED_CORS_ORIGINS origin ${origin}`, origin, invalid);
  }
}
