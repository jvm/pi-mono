export type ProviderLimitKind = "none" | "rate_limit" | "usage_limit" | "quota_exceeded" | "billing_required" | "auth_required" | "provider_error";

export interface ProviderLimitInput {
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

export interface ProviderLimitClassification {
  kind: ProviderLimitKind;
  pause: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  resetHint?: string;
}

const USAGE_LIMIT_PATTERNS = [
  /GoUsageLimitError/i,
  /\busage limit (?:reached|exceeded)/i,
  /\b\d+\s*-?\s*hour usage limit/i,
  /\bdaily limit\b/i,
  /\bmonthly limit\b/i,
  /\bweekly limit\b/i,
  /\btoken plan\b/i,
];

const QUOTA_PATTERNS = [
  /insufficient[_\s-]?quota/i,
  /quota (?:exceeded|reached)/i,
  /exceeded (?:your )?quota/i,
];

const BILLING_PATTERNS = [
  /billing/i,
  /available balance/i,
  /enable usage from your available balance/i,
  /payment required/i,
  /credits? exhausted/i,
];

const AUTH_PATTERNS = [
  /invalid api key/i,
  /unauthorized/i,
  /forbidden/i,
  /authentication/i,
];

export function classifyProviderLimit(input: ProviderLimitInput): ProviderLimitClassification {
  const status = input.status;
  const text = extractSearchableText(input);
  const retryAfterSeconds = parseRetryAfter(input.headers);
  const resetHint = extractResetHint(text);

  if (matchesAny(text, USAGE_LIMIT_PATTERNS)) return { kind: "usage_limit", pause: true, reason: "provider usage limit reached", retryAfterSeconds, resetHint };
  if (matchesAny(text, QUOTA_PATTERNS)) return { kind: "quota_exceeded", pause: true, reason: "provider quota exceeded", retryAfterSeconds, resetHint };
  if (matchesAny(text, BILLING_PATTERNS)) return { kind: "billing_required", pause: true, reason: "provider billing or balance limit", retryAfterSeconds, resetHint };
  if ((status === 401 || status === 403) && matchesAny(text, AUTH_PATTERNS)) return { kind: "auth_required", pause: true, reason: "provider authentication failed", retryAfterSeconds, resetHint };
  if (status === 402) return { kind: "billing_required", pause: true, reason: "provider payment required", retryAfterSeconds, resetHint };
  if (status === 429) return { kind: "rate_limit", pause: true, reason: "provider returned HTTP 429", retryAfterSeconds, resetHint };
  if (status && status >= 500) return { kind: "provider_error", pause: false, reason: `provider returned HTTP ${status}`, retryAfterSeconds, resetHint };
  if (/\b429\b/.test(text) && /rate limit|too many requests|limit/i.test(text)) return { kind: "rate_limit", pause: true, reason: "provider returned a rate limit error", retryAfterSeconds, resetHint };
  return { kind: "none", pause: false, retryAfterSeconds, resetHint };
}

export function classifyAssistantError(message: any): ProviderLimitClassification {
  if (!message || message.role !== "assistant") return { kind: "none", pause: false };
  const raw = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (!raw && message.stopReason !== "error") return { kind: "none", pause: false };
  return classifyProviderLimit({
    status: extractStatus(raw),
    errorMessage: raw || String(message.stopReason ?? ""),
    provider: message.provider,
    model: message.model,
  });
}

function extractSearchableText(input: ProviderLimitInput): string {
  const parts = [input.errorMessage ?? "", input.provider ?? "", input.model ?? ""];
  if (input.headers) parts.push(JSON.stringify(input.headers));
  try {
    const match = (input.errorMessage ?? "").match(/\{[\s\S]*\}/);
    if (match) parts.push(JSON.stringify(JSON.parse(match[0])));
  } catch {
    // Keep the raw error text if provider payload is not valid JSON.
  }
  return parts.join("\n");
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractStatus(errorMessage: string): number | undefined {
  const match = errorMessage.match(/^\s*(\d{3})\b/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

function parseRetryAfter(headers: ProviderLimitInput["headers"]): number | undefined {
  const value = headerValue(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function headerValue(headers: ProviderLimitInput["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function extractResetHint(text: string): string | undefined {
  const resets = text.match(/resets?\s+in\s+([^".\n]+)/i);
  if (resets) return `resets in ${resets[1].trim()}`;
  const retry = text.match(/try again\s+in\s+([^".\n]+)/i);
  if (retry) return `try again in ${retry[1].trim()}`;
  return undefined;
}
