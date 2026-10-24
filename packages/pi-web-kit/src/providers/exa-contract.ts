import { DEFAULT_NUM_RESULTS, EXA_DATE_PATTERN, MAX_EXA_AGE_HOURS, MAX_EXA_DATE_CHARACTERS, MAX_EXA_DOMAINS, MAX_EXA_HINT_CHARACTERS, MAX_EXA_MESSAGE_CHARACTERS, MAX_EXA_NOTICES, MAX_EXA_QUERY_CHARACTERS, MAX_URL_LENGTH, safePrefix } from "../limits.js";
import { redactText } from "../output.js";
import type { ExaDiagnostic, ExaNotice, FetchInput, SearchInput } from "../types.js";

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

export function validateExaMaxAgeHours(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < -1 || value > MAX_EXA_AGE_HOURS) {
    throw new Error(`maxAgeHours must be an integer from -1 to ${MAX_EXA_AGE_HOURS}.`);
  }
  return value;
}

export function exaFetchMaxAgeHours(input: FetchInput): number | undefined {
  // Validate explicit options even when refresh would override them.
  const explicit = validateExaMaxAgeHours(input.maxAgeHours);
  if (input.maxAgeMs != null && (typeof input.maxAgeMs !== "number" || !Number.isInteger(input.maxAgeMs)
    || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0)) {
    throw new Error("maxAgeMs must be a finite nonnegative integer.");
  }
  if (input.refresh === true) return 0;
  if (explicit != null) return explicit;
  // A stricter provider age still meets a caller's more permissive age limit.
  return input.maxAgeMs == null ? undefined : Math.min(MAX_EXA_AGE_HOURS, Math.floor(input.maxAgeMs / 3_600_000));
}

/** The flat tool inputs deliberately do not expose arbitrary contents overrides. */
export function buildExaSearchBody(input: SearchInput) {
  const allowed = new Set(["query", "queries", "numResults", "contextTokens", "purpose", "type", "category",
    "includeDomains", "excludeDomains", "startPublishedDate", "endPublishedDate", "startCrawlDate", "endCrawlDate", "maxAgeHours", "contents"]);
  if (Object.entries(input).some(([key, value]) => value != null && !allowed.has(key))) {
    throw new Error("Unsupported Exa search parameter. Use only the exposed search controls.");
  }
  const query = optionalString(input.query, "query", MAX_EXA_QUERY_CHARACTERS);
  if (!query) throw new Error("query must be a non-empty string.");
  const objective = optionalString(input.purpose, "purpose", 2_000);
  if (!objective) throw new Error("purpose is required: state the task this search serves, including the relevant version and source preferences.");
  if (input.numResults != null && (!Number.isSafeInteger(input.numResults) || input.numResults < 1 || input.numResults > 100)) {
    throw new Error("Exa numResults must be an integer from 1 to 100.");
  }
  const type = optionalString(input.type, "type", MAX_EXA_HINT_CHARACTERS) ?? "auto";
  const category = optionalString(input.category, "category", MAX_EXA_HINT_CHARACTERS);
  for (const field of ["startCrawlDate", "endCrawlDate"] as const) {
    if (input[field] != null) {
      throw new Error(`Exa ignores ${field}. Remove it; use publication-date filters only if publication time is intended.`);
    }
  }
  if (input.contents != null) throw new Error("Exa contents overrides are not supported; search uses highlights. Use web_fetch for page text.");
  if (type === "lite" && input.maxAgeHours != null) {
    throw new Error("Exa lite does not support maxAgeHours, including -1. Use auto when freshness control is required.");
  }
  const maxAgeHours = validateExaMaxAgeHours(input.maxAgeHours);
  for (const field of ["includeDomains", "excludeDomains"] as const) {
    const values = input[field];
    if (values != null && (!Array.isArray(values) || values.length > MAX_EXA_DOMAINS
      || !values.every(value => typeof value === "string" && value.trim() && value.length <= MAX_URL_LENGTH))) {
      throw new Error(`${field} must contain at most ${MAX_EXA_DOMAINS} non-empty domain/path strings of at most ${MAX_URL_LENGTH} characters.`);
    }
  }
  for (const field of ["startPublishedDate", "endPublishedDate"] as const) {
    const date = optionalString(input[field], field, MAX_EXA_DATE_CHARACTERS);
    if (date && (!new RegExp(EXA_DATE_PATTERN).test(date) || !Number.isFinite(Date.parse(date)))) {
      throw new Error(`${field} must be an ISO 8601 date.`);
    }
  }
  if ((category === "company" || category === "people") && (input.startPublishedDate != null || input.endPublishedDate != null)) {
    throw new Error("Exa company and people categories do not support publication-date filters.");
  }
  if (category === "people" && input.excludeDomains != null) {
    throw new Error("Exa people category does not support excludeDomains.");
  }
  return {
    query,
    numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
    type,
    objective,
    contents: { highlights: true, ...(maxAgeHours != null ? { maxAgeHours } : {}) },
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
    startPublishedDate: input.startPublishedDate,
    endPublishedDate: input.endPublishedDate,
    category,
  };
}

const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function identifier(value: unknown, pattern: RegExp, secrets: readonly string[]): string | undefined {
  return typeof value === "string" && pattern.test(value) && redactText(value, secrets) === value ? value : undefined;
}

export function exaNotices(data: any, secrets: readonly string[]): { notices?: ExaNotice[]; omittedNoticeCount?: number } {
  if (!Array.isArray(data?.notices) || !data.notices.length) return {};
  const notices: ExaNotice[] = [];
  for (const notice of data.notices.slice(0, MAX_EXA_NOTICES)) {
    if (!notice || typeof notice.code !== "string" || typeof notice.message !== "string") continue;
    const clean = (value: string, max: number) => safePrefix(redactText(value, secrets).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "), max);
    notices.push({ code: clean(notice.code, 64), message: clean(notice.message, MAX_EXA_MESSAGE_CHARACTERS),
      ...(typeof notice.path === "string" ? { path: clean(notice.path, 128) } : {}) });
  }
  const omittedNoticeCount = data.notices.length - notices.length;
  return { notices, ...(omittedNoticeCount ? { omittedNoticeCount } : {}) };
}

/** Only machine identifiers and finite metrics enter the diagnostic channel. */
export function exaDiagnostic(data: any, base: ExaDiagnostic, secrets: readonly string[]): ExaDiagnostic {
  const requestId = identifier(data?.requestId, /^[a-zA-Z0-9_-]{1,128}$/, secrets);
  const warnings = Array.isArray(data?.warnings) ? data.warnings.slice(0, MAX_EXA_NOTICES).flatMap((warning: any) => {
    const code = identifier(warning?.code, /^[A-Z][A-Z0-9_]{0,63}$/, secrets);
    const path = identifier(warning?.path, /^\/[a-zA-Z0-9_~/]{0,127}$/, secrets);
    return code ? [{ code, ...(path ? { path } : {}) }] : [];
  }) : [];
  const omittedWarningCount = Array.isArray(data?.warnings) ? data.warnings.length - warnings.length : 0;
  return { ...base,
    ...(requestId ? { requestId } : {}),
    ...(finiteNonnegative(data?.searchTime) ? { searchTime: data.searchTime } : {}),
    ...(finiteNonnegative(data?.costDollars?.total) ? { costDollars: data.costDollars.total } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(omittedWarningCount ? { omittedWarningCount } : {}),
  };
}
