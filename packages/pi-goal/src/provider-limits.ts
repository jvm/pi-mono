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
  // Not `\s*-?\s*`: adjacent ambiguous quantifiers backtrack quadratically on long whitespace runs.
  /\b\d+\s*(?:-\s*)?hour usage limit/i,
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

// Match billing failures, not any mention of billing: request IDs, header names,
// and URLs such as https://billing.example are not limit evidence.
const BILLING_PATTERNS = [
  /\bbilling[_\s-](?:hard[_\s-]limit|not[_\s-]active|limit|required|issue|error|details|problem)/i,
  /\b(?:check|update|review) your billing\b/i,
  /\bplans? (?:&|and) billing\b/i,
  /credit balance is too low/i,
  /available balance/i,
  /enable usage from your available balance/i,
  /payment required/i,
  /credits? exhausted/i,
];

// Secondary auth evidence for failures that carry no HTTP status, and for
// providers that report a bad key as HTTP 400 (Google). Covers the wording of
// OpenAI, Anthropic, Google, Bedrock, Mistral, OpenRouter and generic gateways.
const AUTH_PATTERNS = [
  /\b(?:invalid|incorrect|missing|expired|revoked) (?:api[_\s-]?key|x-api-key|access token|auth(?:entication)? token|credentials?)\b/i,
  /\binvalid[_\s-]api[_\s-]key\b/i,
  /\bapi key not valid\b/i,
  /\bAPI_KEY_INVALID\b/,
  /\bauthentication[_\s-](?:error|failed|required)\b/i,
  /\b(?:unauthorized|unauthenticated)\b/i,
  /\bpermission[_\s-]denied\b/i,
  /\bsecurity token included in the request is invalid\b/i,
  /\b(?:UnrecognizedClientException|AccessDeniedException)\b/,
  /\bno auth credentials found\b/i,
];

// Some gateways report throttling as HTTP 403; that is a limit, not an auth failure.
const RATE_LIMIT_TEXT = /\brate[_\s-]?limit|\btoo many requests\b|\bthrottl/i;

export function classifyProviderLimit(input: ProviderLimitInput): ProviderLimitClassification {
  const status = input.status;
  const text = extractSearchableText(input);
  const retryAfterSeconds = parseRetryAfter(input.headers);
  // A successful response, or one without a status or error text, is never limit evidence.
  if (!text.trim() && (status == null || status < 400)) return { kind: "none", pause: false, retryAfterSeconds };
  const resetHint = extractResetHint(text);
  const result = (kind: ProviderLimitKind, pause: boolean, reason?: string): ProviderLimitClassification => ({ kind, pause, reason, retryAfterSeconds, resetHint });
  // A known failure status decides; wording only refines it. A 2xx status
  // (e.g. a stream that failed after 200 OK) says nothing about the failure.
  const failureStatus = status != null && status >= 400 ? status : undefined;
  const limit = limitFromText(text);

  if (failureStatus === 401) return result("auth_required", true, "provider authentication failed");
  if (failureStatus === 402) return limit ? result(limit.kind, true, limit.reason) : result("billing_required", true, "provider payment required");
  if (failureStatus === 429) return limit ? result(limit.kind, true, limit.reason) : result("rate_limit", true, "provider returned HTTP 429");
  // Some gateways report throttling or billing as HTTP 403; that is a limit, not an auth failure.
  if (failureStatus === 403) {
    if (limit) return result(limit.kind, true, limit.reason);
    if (RATE_LIMIT_TEXT.test(text)) return result("rate_limit", true, "provider returned a rate limit error");
    return result("auth_required", true, "provider denied access");
  }
  if (failureStatus != null && failureStatus >= 500) return result("provider_error", false, `provider returned HTTP ${failureStatus}`);
  // Any other failure status (404, 408, 422, ...) is a generic error whatever its wording.
  // Wording decides only without a status, or for a 400 (Anthropic balance, Google bad key).
  if (failureStatus != null && failureStatus !== 400) return result("none", false);
  if (limit) return result(limit.kind, true, limit.reason);
  if (/\b429\b/.test(text) && /rate limit|too many requests|limit/i.test(text)) return result("rate_limit", true, "provider returned a rate limit error");
  if (matchesAny(text, AUTH_PATTERNS)) return result("auth_required", true, "provider authentication failed");
  return result("none", false);
}

function limitFromText(text: string): { kind: ProviderLimitKind; reason: string } | undefined {
  if (matchesAny(text, USAGE_LIMIT_PATTERNS)) return { kind: "usage_limit", reason: "provider usage limit reached" };
  if (matchesAny(text, QUOTA_PATTERNS)) return { kind: "quota_exceeded", reason: "provider quota exceeded" };
  if (matchesAny(text, BILLING_PATTERNS)) return { kind: "billing_required", reason: "provider billing or balance limit" };
  return undefined;
}

/**
 * Classifies a failed assistant attempt. `response` is the HTTP response of the
 * same attempt, when Pi reported one; its failure status outranks a status
 * prefix in the error text.
 */
export function classifyAssistantError(message: any, response?: Pick<ProviderLimitInput, "status" | "headers">): ProviderLimitClassification {
  if (!message || message.role !== "assistant") return { kind: "none", pause: false };
  const raw = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (!raw && message.stopReason !== "error") return { kind: "none", pause: false };
  const responseStatus = response?.status != null && response.status >= 400 ? response.status : undefined;
  return classifyProviderLimit({
    status: responseStatus ?? extractStatus(raw),
    headers: response?.headers,
    errorMessage: raw || String(message.stopReason ?? ""),
    provider: message.provider,
    model: message.model,
  });
}

/**
 * Only the provider's error text is evidence. Header names and values, provider
 * and model IDs, and URLs routinely contain words such as "billing" or "limit".
 */
function extractSearchableText(input: ProviderLimitInput): string {
  // Error bodies come from the network: examine a bounded prefix only.
  const raw = (input.errorMessage ?? "").slice(0, MAX_ERROR_TEXT_LENGTH);
  const parts = [raw];
  // The provider payload spans the first "{" to the last "}". Plain index
  // scanning keeps this linear; a regex here backtracks polynomially.
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try {
      parts.push(JSON.stringify(JSON.parse(raw.slice(open, close + 1))));
    } catch {
      // Keep the raw error text if provider payload is not valid JSON.
    }
  }
  return stripUrls(parts.join("\n"));
}

/** Upper bound on the provider error text that classification examines. */
export const MAX_ERROR_TEXT_LENGTH = 16_384;

const isAsciiLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isAsciiDigit = (code: number) => code >= 48 && code <= 57;
const isWordChar = (code: number) => isAsciiLetter(code) || isAsciiDigit(code) || code === 95;
// RFC 3986 scheme characters after the first letter: letters, digits, "+", ".", "-".
const isSchemeChar = (code: number) => isAsciiLetter(code) || isAsciiDigit(code) || code === 43 || code === 46 || code === 45;
// A URL ends at whitespace or at a delimiter of the JSON, HTML, or prose around
// it, so stripping it never removes a neighbouring field such as `"code":"..."`.
// A backslash ends it too: in a JSON-escaped payload it starts `\"`.
const URL_DELIMITERS = new Set(['"', "'", "<", ">", ",", "}", "]", "\\"]);
const endsUrl = (char: string) => URL_DELIMITERS.has(char) || char.trim() === "";

/**
 * Replaces each URL (`scheme://...`) with a space in linear time. Like
 * `/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,}\]\\]+/gi`, which backtracks quadratically
 * on long runs of scheme characters without "://".
 */
function stripUrls(text: string): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const separator = text.indexOf("://", from);
    if (separator < 0) break;
    from = separator + 1;
    // The scheme run cannot contain ":", so this backward walk stays linear overall.
    let runStart = separator;
    while (runStart > copied && isSchemeChar(text.charCodeAt(runStart - 1))) runStart--;
    let start = -1;
    for (let i = runStart; i < separator; i++) {
      if (isAsciiLetter(text.charCodeAt(i)) && (i === 0 || !isWordChar(text.charCodeAt(i - 1)))) {
        start = i;
        break;
      }
    }
    let end = separator + 3;
    while (end < text.length && !endsUrl(text[end])) end++;
    if (start < 0 || end === separator + 3) continue;
    out += text.slice(copied, start) + " ";
    copied = end;
    from = end;
  }
  return out + text.slice(copied);
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
