import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./limits.js";
import { normalizeUrlInput } from "./urls.js";
import { redactText } from "./output.js";
import { AdmissionError, coordinate, requestScope } from "./coordinator.js";

const MAX_CHARS = 50_000;
const MAX_LINES = 2_000;

/** Only operational transport failures may become per-query failure data. */
export class ProviderRequestError extends Error {}

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
    signal.throwIfAborted();
    // All destinations are fixed provider endpoints. Never forward API keys,
    // query bodies, or URLs through a provider-controlled redirect.
    return await coordinate(requestScope(url, rest.headers), signal, async cooldown => {
      let response: Response;
      try { response = await fetch(url, { ...rest, signal, redirect: "error" }); }
      catch (error) {
        if (signal.aborted) throw error;
        // Redirect/policy failures must not be presented as a completed search.
        if (error instanceof TypeError && !/redirect/i.test(String(error.cause ?? error.message))) {
          throw new ProviderRequestError("Provider network request failed.");
        }
        throw error;
      }
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        if (retry) {
          const ms = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          if (Number.isFinite(ms)) cooldown(ms);
        }
      }
      const result = await consume(response);
      signal.throwIfAborted();
      return result;
    });
  } catch (error) {
    if (init.signal?.aborted) throw new Error("Web tool cancelled.");
    if (controller.signal.aborted) throw new ProviderRequestError(`Request timed out after ${timeoutMs}ms`);
    if (error instanceof AdmissionError) throw new ProviderRequestError(error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { text } = await requestText(url, init);
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; }
  catch { throw new Error("Provider returned invalid JSON."); }
}

/** Keep both text and JSON deadlines active until the bounded body is consumed. */
export function requestText(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ text: string; headers: Headers }> {
  return withResponseTimeout(url, init, async res => {
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new ProviderRequestError(`Provider request failed (HTTP ${res.status}).`);
    }
    return { text: await readBoundedText(res), headers: res.headers };
  });
}

async function readBoundedText(res: Response): Promise<string> {
  const tooLarge = () => new Error(`Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      // Reading a response can fail after fetch has already returned headers.
      // Classify only the body read, not size checks, decoding or JSON parsing.
      // withResponseTimeout still gives caller cancellation/deadlines precedence.
      const { done, value } = await reader.read().catch(() => {
        throw new ProviderRequestError("Provider response body could not be read.");
      });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw tooLarge();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
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
