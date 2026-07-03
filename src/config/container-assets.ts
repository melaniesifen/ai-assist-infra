import { SERVICES, ServiceName } from "./service-routes";

export const PYTHON_SERVICE_BASE_IMAGE = "python:3.13-slim-bookworm";

export interface PythonServiceContainerAsset {
  readonly service: ServiceName;
  readonly sourceDirectory: string;
  readonly pythonPackage: string;
}

export const PYTHON_SERVICE_CONTAINER_ASSETS: readonly PythonServiceContainerAsset[] = Object.freeze([
  asset(SERVICES.AUTH, "ai-assist-auth-service", "ai_assist_auth_service"),
  asset(SERVICES.SECRETS, "ai-assist-secrets-service", "ai_assist_secrets_service"),
  asset(SERVICES.ORCHESTRATION, "ai-assist-orchestration-service", "ai_assist_orchestration"),
  asset(SERVICES.SESSION_EVENTS, "ai-assist-session-events-service", "ai_assist_session_events"),
  asset(SERVICES.CONTEXT, "ai-assist-context-service", "ai_assist_context_service"),
  asset(SERVICES.GOOGLE_DOCS_ADAPTER, "ai-assist-google-docs-adapter", "ai_assist_google_docs_adapter")
]);

export function getPythonServiceContainerAsset(service: ServiceName): PythonServiceContainerAsset {
  const found = PYTHON_SERVICE_CONTAINER_ASSETS.find((assetConfig) => assetConfig.service === service);
  if (!found) {
    throw new Error(`container asset config is missing for ${service}`);
  }
  return { ...found };
}

export function validateContainerAssetConfig(assets: readonly PythonServiceContainerAsset[] = PYTHON_SERVICE_CONTAINER_ASSETS): { readonly valid: boolean; readonly errors: string[] } {
  const errors: string[] = [];
  const seenServices = new Set<string>();
  const requiredServices = new Set(Object.values(SERVICES));

  for (const item of assets) {
    if (!requiredServices.delete(item.service)) {
      errors.push(`${item.service} has duplicate or unknown container asset config`);
    }
    if (!item.sourceDirectory.startsWith("ai-assist-")) {
      errors.push(`${item.service} sourceDirectory must point at a workspace service repo`);
    }
    if (!/^ai_assist_[a-z_]+$/.test(item.pythonPackage)) {
      errors.push(`${item.service} pythonPackage must be an ai_assist_* module`);
    }
    if (seenServices.has(item.service)) {
      errors.push(`${item.service} container asset config is duplicated`);
    }
    seenServices.add(item.service);
  }

  for (const missing of requiredServices) {
    errors.push(`${missing} is missing container asset config`);
  }
  if (PYTHON_SERVICE_BASE_IMAGE.includes(":latest")) {
    errors.push("container base image must not use the mutable latest tag");
  }

  return { valid: errors.length === 0, errors };
}

function asset(service: ServiceName, sourceDirectory: string, pythonPackage: string): PythonServiceContainerAsset {
  return Object.freeze({ service, sourceDirectory, pythonPackage });
}
