import { DEFAULT_TIMEOUT_MS } from "./limits.js";
import { normalizeUrlInput } from "./urls.js";

const MAX_CHARS = 50_000;
const MAX_LINES = 2_000;

export function truncateText(text: string, maxChars = MAX_CHARS): string {
  const lines = text.split(/\r?\n/);
  const lineLimited = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") + "\n[truncated: line limit]" : text;
  return lineLimited.length > maxChars ? lineLimited.slice(0, maxChars) + "\n[truncated: size limit]" : lineLimited;
}

export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const { timeoutMs: _timeoutMs, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function asSnippet(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean).join("\n").slice(0, 1000) || undefined;
  if (typeof value === "string") return value.slice(0, 1000) || undefined;
  return JSON.stringify(value).slice(0, 1000);
}

export function normalizeUrls(input: { url?: string; urls?: string[] }, maxCount?: number): string[] {
  return normalizeUrlInput(input, maxCount);
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
