export const SERVICES = Object.freeze({
  AUTH: "ai-assist-auth-service",
  SECRETS: "ai-assist-secrets-service",
  ORCHESTRATION: "ai-assist-orchestration-service",
  SESSION_EVENTS: "ai-assist-session-events-service",
  CONTEXT: "ai-assist-context-service",
  GOOGLE_DOCS_ADAPTER: "ai-assist-google-docs-adapter"
} as const);

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

export const ROUTE_RATE_LIMIT_TIERS = Object.freeze({
  PUBLIC_LOW: "PUBLIC_LOW",
  USER_STANDARD: "USER_STANDARD",
  EXPENSIVE: "EXPENSIVE",
  STREAM: "STREAM",
  MUTATION: "MUTATION"
} as const);

export type RouteRateLimitTier = (typeof ROUTE_RATE_LIMIT_TIERS)[keyof typeof ROUTE_RATE_LIMIT_TIERS];

export interface ServiceRoute {
  readonly method: string;
  readonly path: string;
  readonly routeKey: string;
  readonly service: ServiceName;
  readonly rateLimitTier: RouteRateLimitTier;
  readonly requiresAuthentication: boolean;
}

export const SERVICE_ROUTES: readonly ServiceRoute[] = Object.freeze([
  route("GET", "/health", SERVICES.AUTH, ROUTE_RATE_LIMIT_TIERS.PUBLIC_LOW),
  route("GET", "/auth/session", SERVICES.AUTH, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("GET", "/auth/google/start", SERVICES.AUTH, ROUTE_RATE_LIMIT_TIERS.PUBLIC_LOW),
  route("GET", "/auth/google/callback", SERVICES.AUTH, ROUTE_RATE_LIMIT_TIERS.PUBLIC_LOW),
  route("GET", "/setup/status", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("POST", "/provider-secrets/session", SERVICES.SECRETS, ROUTE_RATE_LIMIT_TIERS.EXPENSIVE),
  route("GET", "/provider-secrets/session/{provider}/status", SERVICES.SECRETS, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("DELETE", "/provider-secrets/session/{provider}", SERVICES.SECRETS, ROUTE_RATE_LIMIT_TIERS.MUTATION),
  route("GET", "/providers", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("GET", "/resources", SERVICES.GOOGLE_DOCS_ADAPTER, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("POST", "/resource-sessions", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.MUTATION),
  route("GET", "/resource-sessions/{sessionId}", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("POST", "/resource-sessions/{sessionId}/commands", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.EXPENSIVE),
  route("GET", "/resource-sessions/{sessionId}/events", SERVICES.SESSION_EVENTS, ROUTE_RATE_LIMIT_TIERS.STREAM),
  route("GET", "/context-modes", SERVICES.CONTEXT, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("PUT", "/resource-sessions/{sessionId}/context-mode", SERVICES.CONTEXT, ROUTE_RATE_LIMIT_TIERS.MUTATION),
  route("POST", "/resource-sessions/{sessionId}/context-preview", SERVICES.CONTEXT, ROUTE_RATE_LIMIT_TIERS.EXPENSIVE),
  route("GET", "/resource-sessions/{sessionId}/actions", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.USER_STANDARD),
  route("POST", "/resource-sessions/{sessionId}/actions/{actionId}/approve", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.MUTATION),
  route("POST", "/resource-sessions/{sessionId}/actions/{actionId}/reject", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.MUTATION),
  route("POST", "/resource-sessions/{sessionId}/apply-action", SERVICES.ORCHESTRATION, ROUTE_RATE_LIMIT_TIERS.MUTATION)
]);

function route(method: string, path: string, service: ServiceName, rateLimitTier: RouteRateLimitTier): ServiceRoute {
  return Object.freeze({
    method,
    path,
    routeKey: `${method} ${path}`,
    service,
    rateLimitTier,
    requiresAuthentication: path !== "/health"
  });
}

export function listServiceRoutes(): ServiceRoute[] {
  return SERVICE_ROUTES.map((item) => ({ ...item }));
}

export function findServiceRoute(method: string, path: string): ServiceRoute | null {
  return SERVICE_ROUTES.find((item) => item.method === method && item.path === path) ?? null;
}

export function groupRoutesByService(): Record<string, ServiceRoute[]> {
  return SERVICE_ROUTES.reduce<Record<string, ServiceRoute[]>>((groups, item) => {
    groups[item.service] = groups[item.service] ?? [];
    groups[item.service].push({ ...item });
    return groups;
  }, {});
}
