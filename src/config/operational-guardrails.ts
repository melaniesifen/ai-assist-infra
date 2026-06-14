export const OPERATIONAL_PATHS = Object.freeze({
  OAUTH: "oauth",
  PROVIDER: "provider",
  GOOGLE_DOCS: "google-docs",
  SSE: "sse",
  APPLY: "apply",
  KMS: "kms",
  DYNAMODB: "dynamodb",
  RATE_LIMIT: "rate-limit"
} as const);

export type OperationalPath = (typeof OPERATIONAL_PATHS)[keyof typeof OPERATIONAL_PATHS];

export interface SafeAuditEvent {
  readonly path: OperationalPath;
  readonly eventName: string;
  readonly fields: readonly string[];
}

export interface OperationalMetric {
  readonly path: OperationalPath;
  readonly metricName: string;
  readonly unit: "Count" | "Milliseconds";
}

export interface OperationalAlarm {
  readonly path: OperationalPath;
  readonly metricName: string;
  readonly threshold: number;
  readonly evaluationPeriods: number;
}

export interface RunbookNote {
  readonly path: OperationalPath;
  readonly title: string;
  readonly steps: readonly string[];
}

export const METADATA_ONLY_LOG_FIELDS = Object.freeze([
  "timestamp",
  "environment",
  "service",
  "route",
  "statusCode",
  "durationMs",
  "requestId",
  "correlationId",
  "tenantId",
  "userId",
  "sessionId",
  "errorCategory",
  "errorCode",
  "provider",
  "connector",
  "dependencyStatus",
  "rateLimitDecision"
]);

export const FORBIDDEN_LOG_FIELDS = Object.freeze([
  "prompt",
  "documentText",
  "selectedText",
  "modelResponse",
  "providerKey",
  "oauthAccessToken",
  "oauthRefreshToken",
  "authorizationHeader",
  "cookie",
  "decryptedActionPayload"
]);

export const SAFE_AUDIT_EVENTS: readonly SafeAuditEvent[] = Object.freeze([
  audit(OPERATIONAL_PATHS.OAUTH, "oauth.status_changed", ["tenantId", "userId", "provider", "status", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.PROVIDER, "provider.availability_checked", ["tenantId", "userId", "provider", "status", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.GOOGLE_DOCS, "connector.permission_checked", ["tenantId", "userId", "connector", "resourceIdHash", "status", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.SSE, "session.stream_state_changed", ["tenantId", "userId", "sessionId", "status", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.APPLY, "action.apply_decided", ["tenantId", "userId", "sessionId", "actionId", "status", "reasonCode", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.KMS, "kms.operation_failed", ["service", "operation", "keyAlias", "errorCategory", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.DYNAMODB, "dynamodb.operation_throttled", ["service", "tableName", "operation", "errorCategory", "requestId", "correlationId"]),
  audit(OPERATIONAL_PATHS.RATE_LIMIT, "rate_limit.decision_recorded", ["tenantId", "userId", "route", "rateLimitDecision", "requestId", "correlationId"])
]);

export const OPERATIONAL_METRICS: readonly OperationalMetric[] = Object.freeze([
  metric(OPERATIONAL_PATHS.OAUTH, "OAuthErrorCount", "Count"),
  metric(OPERATIONAL_PATHS.PROVIDER, "ProviderUnavailableCount", "Count"),
  metric(OPERATIONAL_PATHS.PROVIDER, "ProviderTokenUsage", "Count"),
  metric(OPERATIONAL_PATHS.GOOGLE_DOCS, "GoogleDocsErrorCount", "Count"),
  metric(OPERATIONAL_PATHS.SSE, "SseStreamErrorCount", "Count"),
  metric(OPERATIONAL_PATHS.APPLY, "ApplyConflictCount", "Count"),
  metric(OPERATIONAL_PATHS.APPLY, "ApplyFailureCount", "Count"),
  metric(OPERATIONAL_PATHS.APPLY, "ApplyLatencyMs", "Milliseconds"),
  metric(OPERATIONAL_PATHS.KMS, "KmsOperationFailureCount", "Count"),
  metric(OPERATIONAL_PATHS.DYNAMODB, "DynamoDbThrottleCount", "Count"),
  metric(OPERATIONAL_PATHS.RATE_LIMIT, "RateLimitDecisionCount", "Count")
]);

export const OPERATIONAL_ALARMS: readonly OperationalAlarm[] = Object.freeze([
  alarm(OPERATIONAL_PATHS.OAUTH, "OAuthErrorCount", 5),
  alarm(OPERATIONAL_PATHS.PROVIDER, "ProviderUnavailableCount", 3),
  alarm(OPERATIONAL_PATHS.PROVIDER, "ProviderTokenUsage", 100000),
  alarm(OPERATIONAL_PATHS.GOOGLE_DOCS, "GoogleDocsErrorCount", 5),
  alarm(OPERATIONAL_PATHS.SSE, "SseStreamErrorCount", 5),
  alarm(OPERATIONAL_PATHS.APPLY, "ApplyConflictCount", 10),
  alarm(OPERATIONAL_PATHS.APPLY, "ApplyFailureCount", 2),
  alarm(OPERATIONAL_PATHS.KMS, "KmsOperationFailureCount", 1),
  alarm(OPERATIONAL_PATHS.DYNAMODB, "DynamoDbThrottleCount", 10),
  alarm(OPERATIONAL_PATHS.RATE_LIMIT, "RateLimitDecisionCount", 50)
]);

export const RUNBOOK_NOTES: readonly RunbookNote[] = Object.freeze([
  runbook(OPERATIONAL_PATHS.OAUTH, "Google OAuth reconnect spike", [
    "Check OAuth error count and callback 4xx/5xx metadata.",
    "Verify client ID, redirect URI, signed state, and token refresh dependency status.",
    "Ask affected users to reconnect only after config status is ready."
  ]),
  runbook(OPERATIONAL_PATHS.PROVIDER, "Platform provider unavailable or quota limited", [
    "Check platform provider availability and quota metrics.",
    "Confirm the platform provider secret reference is configured without reading the secret value.",
    "Temporarily reduce command creation rate limits if quota errors continue."
  ]),
  runbook(OPERATIONAL_PATHS.GOOGLE_DOCS, "Google Docs connector errors", [
    "Check connector permission and quota error metadata.",
    "Confirm revoked OAuth state before retrying connector calls.",
    "Do not inspect document text in logs or alarm messages."
  ]),
  runbook(OPERATIONAL_PATHS.SSE, "SSE stream failure", [
    "Check stream open, close, duration, and disconnect metrics.",
    "Confirm the client can refresh durable state over HTTP after reconnect.",
    "Keep durable writes on HTTP while stream recovery is investigated."
  ]),
  runbook(OPERATIONAL_PATHS.APPLY, "Repeated apply conflicts or failures", [
    "Check action status transitions and conflict reason codes.",
    "Verify revision and original-text hash handling before retrying mutation paths.",
    "Treat uncertain mutation as failed or conflicted until connector state is verified."
  ]),
  runbook(OPERATIONAL_PATHS.KMS, "KMS encrypt or decrypt failure", [
    "Check key alias, key policy, and service role permission metadata.",
    "Block token, provider, and apply paths until decrypt/encrypt status is healthy.",
    "Do not log plaintext, ciphertext blobs, or decrypted dependency responses."
  ]),
  runbook(OPERATIONAL_PATHS.DYNAMODB, "DynamoDB throttling", [
    "Check table-level throttle metrics and service route metadata.",
    "Confirm callers use idempotency keys for retryable mutation paths.",
    "Avoid retry storms by reducing edge throttles or service concurrency first."
  ]),
  runbook(OPERATIONAL_PATHS.RATE_LIMIT, "Rate-limit misconfiguration", [
    "Run rate-limit config validation and compare required guarded routes.",
    "Restore default route tiers if a guarded path is missing or too permissive.",
    "Keep 429 responses metadata-only and free of request body content."
  ])
]);

export function validateOperationalGuardrails(): { readonly valid: boolean; readonly errors: string[] } {
  const errors: string[] = [];
  const expectedPaths = Object.values(OPERATIONAL_PATHS);
  for (const path of expectedPaths) {
    if (!SAFE_AUDIT_EVENTS.some((event) => event.path === path)) {
      errors.push(`${path} is missing a safe audit event`);
    }
    if (!OPERATIONAL_METRICS.some((metric) => metric.path === path)) {
      errors.push(`${path} is missing an operational metric`);
    }
    if (!OPERATIONAL_ALARMS.some((alarmConfig) => alarmConfig.path === path)) {
      errors.push(`${path} is missing an alarm`);
    }
    if (!RUNBOOK_NOTES.some((runbookNote) => runbookNote.path === path)) {
      errors.push(`${path} is missing a runbook note`);
    }
  }

  for (const event of SAFE_AUDIT_EVENTS) {
    for (const forbidden of FORBIDDEN_LOG_FIELDS) {
      if (event.fields.includes(forbidden)) {
        errors.push(`${event.eventName} includes forbidden field ${forbidden}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function audit(path: OperationalPath, eventName: string, fields: readonly string[]): SafeAuditEvent {
  return Object.freeze({ path, eventName, fields: Object.freeze([...fields]) });
}

function metric(path: OperationalPath, metricName: string, unit: OperationalMetric["unit"]): OperationalMetric {
  return Object.freeze({ path, metricName, unit });
}

function alarm(path: OperationalPath, metricName: string, threshold: number): OperationalAlarm {
  return Object.freeze({ path, metricName, threshold, evaluationPeriods: 1 });
}

function runbook(path: OperationalPath, title: string, steps: readonly string[]): RunbookNote {
  return Object.freeze({ path, title, steps: Object.freeze([...steps]) });
}
