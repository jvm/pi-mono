import { DEFAULT_TIMEOUT_MS } from "./limits.js";
import { normalizeUrlInput } from "./urls.js";
import { redactText } from "./output.js";

const MAX_CHARS = 50_000;
const MAX_LINES = 2_000;

export function truncateText(text: string, maxChars = MAX_CHARS): string {
  const lines = text.split(/\r?\n/);
  const lineLimited = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") + "\n[truncated: line limit]" : text;
  return lineLimited.length > maxChars ? lineLimited.slice(0, maxChars) + "\n[truncated: size limit]" : lineLimited;
}

async function withResponseTimeout<T>(url: string, init: RequestInit & { timeoutMs?: number },
  consume: (res: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const { timeoutMs: _timeoutMs, ...rest } = init;
  try {
    return await consume(await fetch(url, { ...rest, signal }));
  } finally {
    clearTimeout(timer);
  }
}

export function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  return withResponseTimeout(url, init, async res => res);
}

export async function requestJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  // Keep the deadline active through body consumption, not just response headers.
  return withResponseTimeout(url, init, async res => {
    const text = await res.text();
    if (!res.ok) throw new Error(`Provider request failed (HTTP ${res.status}).`);
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; }
    catch { throw new Error("Provider returned invalid JSON."); }
  });
}

export function asSnippet(value: unknown, secrets: readonly string[] = []): string | undefined {
  const text = asText(value);
  return text ? redactText(text, secrets).slice(0, 1000) : undefined;
}

export function asText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") || undefined;
  if (typeof value === "string") return value || undefined;
  return JSON.stringify(value);
}

export function withoutContent(value: any): Record<string, unknown> {
  const { text: _text, content: _content, markdown: _markdown, html: _html, summary: _summary, highlights: _highlights, ...metadata } = value ?? {};
  return metadata;
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
