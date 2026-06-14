import { MAX_URL_COUNT, MAX_URL_LENGTH } from "./limits.js";

export function normalizeWebUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH) throw new Error(`URL length must be <= ${MAX_URL_LENGTH} characters.`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Malformed URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`URL scheme must be http or https: ${value}`);
  if (parsed.username || parsed.password) throw new Error(`URL credentials are not allowed: ${value}`);
  parsed.hash = "";
  return parsed.toString();
}

export function canonicalWebUrl(value: string): string {
  const parsed = new URL(normalizeWebUrl(value));
  parsed.hostname = parsed.hostname.toLowerCase();
  if (isDefaultPort(parsed)) parsed.port = "";
  return parsed.toString();
}

function isDefaultPort(url: URL): boolean {
  return (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
}

export function normalizeUrlInput(input: { url?: string; urls?: string[] }, maxCount = MAX_URL_COUNT): string[] {
  const raw = [...(Array.isArray(input.urls) ? input.urls : []), ...(input.url ? [input.url] : [])].map((url) => String(url).trim()).filter(Boolean);
  const unique = [...new Set(raw.map(normalizeWebUrl))];
  if (unique.length > maxCount) throw new Error(`Too many URLs: maximum is ${maxCount}.`);
  return unique;
}

export function urlsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const ca = canonicalWebUrl(a);
    const cb = canonicalWebUrl(b);
    if (ca === cb) return true;
    return trimTrailingSlash(ca) === trimTrailingSlash(cb);
  } catch {
    return a === b;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
