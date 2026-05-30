import { ROUTE_RATE_LIMIT_TIERS, SERVICE_ROUTES } from "./service-routes.js";

export const DEFAULT_RATE_LIMIT_TIERS = Object.freeze({
  [ROUTE_RATE_LIMIT_TIERS.PUBLIC_LOW]: Object.freeze({ requestsPerMinute: 30, burst: 10 }),
  [ROUTE_RATE_LIMIT_TIERS.USER_STANDARD]: Object.freeze({ requestsPerMinute: 120, burst: 30 }),
  [ROUTE_RATE_LIMIT_TIERS.EXPENSIVE]: Object.freeze({ requestsPerMinute: 20, burst: 5 }),
  [ROUTE_RATE_LIMIT_TIERS.STREAM]: Object.freeze({ requestsPerMinute: 10, burst: 3 }),
  [ROUTE_RATE_LIMIT_TIERS.MUTATION]: Object.freeze({ requestsPerMinute: 40, burst: 10 })
});

const REQUIRED_RATE_LIMIT_PATHS = Object.freeze([
  "/auth/google/start",
  "/auth/google/callback",
  "/provider-secrets/session",
  "/resource-sessions/{sessionId}/commands",
  "/resource-sessions/{sessionId}/context-preview",
  "/resource-sessions/{sessionId}/events",
  "/resource-sessions/{sessionId}/apply-action"
]);

export function buildDefaultRouteRateLimits() {
  return SERVICE_ROUTES.reduce((config, route) => {
    config[route.routeKey] = {
      ...DEFAULT_RATE_LIMIT_TIERS[route.rateLimitTier],
      tier: route.rateLimitTier
    };
    return config;
  }, {});
}

export function validateRateLimitConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["rate limit config must be an object"] };
  }

  const knownRouteKeys = new Set(SERVICE_ROUTES.map((route) => route.routeKey));
  for (const routeKey of Object.keys(config)) {
    if (!knownRouteKeys.has(routeKey)) {
      errors.push(`${routeKey} is not a known service route`);
    }
  }

  for (const route of SERVICE_ROUTES) {
    const entry = config[route.routeKey];
    if (!entry) {
      if (REQUIRED_RATE_LIMIT_PATHS.includes(route.path)) {
        errors.push(`${route.routeKey} is missing required rate limit config`);
      }
      continue;
    }

    validatePositiveInteger(entry.requestsPerMinute, `${route.routeKey}.requestsPerMinute`, errors);
    validatePositiveInteger(entry.burst, `${route.routeKey}.burst`, errors);
    if (entry.burst > entry.requestsPerMinute) {
      errors.push(`${route.routeKey}.burst cannot exceed requestsPerMinute`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validatePositiveInteger(value, field, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${field} must be a positive integer`);
  }
}
