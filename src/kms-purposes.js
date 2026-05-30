import { buildEnvironmentResourceName, normalizeEnvironmentName } from "./environments.js";

export const KMS_PURPOSES = Object.freeze({
  OAUTH_TOKENS: "oauth-tokens",
  SESSION_SECRETS: "session-secrets",
  PROPOSED_ACTIONS: "proposed-actions",
  USER_SECRETS: "user-secrets"
});

export const KMS_PURPOSE_MAPPING = Object.freeze({
  [KMS_PURPOSES.OAUTH_TOKENS]: Object.freeze({
    description: "Encrypt Google OAuth access and refresh tokens.",
    owningService: "ai-assist-auth-service"
  }),
  [KMS_PURPOSES.SESSION_SECRETS]: Object.freeze({
    description: "Encrypt short-lived model provider API keys.",
    owningService: "ai-assist-secrets-service"
  }),
  [KMS_PURPOSES.PROPOSED_ACTIONS]: Object.freeze({
    description: "Encrypt sensitive proposed-action payloads.",
    owningService: "ai-assist-orchestration-service"
  }),
  [KMS_PURPOSES.USER_SECRETS]: Object.freeze({
    description: "Future opt-in persistent provider secrets.",
    owningService: "ai-assist-secrets-service",
    optional: true
  })
});

export function listKmsPurposeMappings({ includeOptional = true } = {}) {
  return Object.entries(KMS_PURPOSE_MAPPING)
    .filter(([, mapping]) => includeOptional || mapping.optional !== true)
    .map(([purpose, mapping]) => ({ purpose, ...mapping }));
}

export function getKmsAlias(environment, purpose) {
  normalizeEnvironmentName(environment);
  if (!KMS_PURPOSE_MAPPING[purpose]) {
    throw new Error(`unknown KMS purpose: ${purpose}`);
  }

  return `alias/${buildEnvironmentResourceName(environment, `${purpose}-key`)}`;
}
