import { ROUTE_RATE_LIMIT_TIERS, RouteRateLimitTier, SERVICE_ROUTES } from "./service-routes";

export interface RateLimit {
  readonly requestsPerMinute: number;
  readonly burst: number;
  readonly tier?: RouteRateLimitTier;
}

export const DEFAULT_RATE_LIMIT_TIERS: Readonly<Record<RouteRateLimitTier, RateLimit>> = Object.freeze({
  [ROUTE_RATE_LIMIT_TIERS.PUBLIC_LOW]: Object.freeze({ requestsPerMinute: 30, burst: 10 }),
  [ROUTE_RATE_LIMIT_TIERS.USER_STANDARD]: Object.freeze({ requestsPerMinute: 120, burst: 30 }),
  [ROUTE_RATE_LIMIT_TIERS.EXPENSIVE]: Object.freeze({ requestsPerMinute: 20, burst: 5 }),
  [ROUTE_RATE_LIMIT_TIERS.STREAM]: Object.freeze({ requestsPerMinute: 10, burst: 3 }),
  [ROUTE_RATE_LIMIT_TIERS.MUTATION]: Object.freeze({ requestsPerMinute: 40, burst: 10 })
});

const REQUIRED_RATE_LIMIT_PATHS = Object.freeze([
  "/auth/login",
  "/auth/logout",
  "/auth/session",
  "/oauth/google/start",
  "/oauth/google/callback",
  "/oauth/google/status",
  "/oauth/google/connection",
  "/setup/status",
  "/provider-secrets/session",
  "/resources",
  "/resource-sessions",
  "/resource-sessions/{sessionId}/commands",
  "/resource-sessions/{sessionId}/context-preview",
  "/sessions/{sessionId}/events",
  "/resource-sessions/{sessionId}/actions",
  "/resource-sessions/{sessionId}/actions/{actionId}",
  "/resource-sessions/{sessionId}/apply-action"
]);

export function buildDefaultRouteRateLimits(): Record<string, RateLimit> {
  return SERVICE_ROUTES.reduce<Record<string, RateLimit>>((config, route) => {
    config[route.routeKey] = {
      ...DEFAULT_RATE_LIMIT_TIERS[route.rateLimitTier],
      tier: route.rateLimitTier
    };
    return config;
  }, {});
}

export function validateRateLimitConfig(config: unknown): { readonly valid: boolean; readonly errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["rate limit config must be an object"] };
  }

  const rateLimitConfig = config as Record<string, Partial<RateLimit>>;
  const knownRouteKeys = new Set(SERVICE_ROUTES.map((route) => route.routeKey));
  for (const routeKey of Object.keys(rateLimitConfig)) {
    if (!knownRouteKeys.has(routeKey)) {
      errors.push(`${routeKey} is not a known service route`);
    }
  }

  for (const route of SERVICE_ROUTES) {
    const entry = rateLimitConfig[route.routeKey];
    if (!entry) {
      if (REQUIRED_RATE_LIMIT_PATHS.includes(route.path)) {
        errors.push(`${route.routeKey} is missing required rate limit config`);
      }
      continue;
    }

    validatePositiveInteger(entry.requestsPerMinute, `${route.routeKey}.requestsPerMinute`, errors);
    validatePositiveInteger(entry.burst, `${route.routeKey}.burst`, errors);
    if (typeof entry.burst === "number" && typeof entry.requestsPerMinute === "number" && entry.burst > entry.requestsPerMinute) {
      errors.push(`${route.routeKey}.burst cannot exceed requestsPerMinute`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validatePositiveInteger(value: unknown, field: string, errors: string[]): void {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push(`${field} must be a positive integer`);
  }
}
