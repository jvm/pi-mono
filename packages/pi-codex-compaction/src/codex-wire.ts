import { createHash } from "node:crypto";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ENCRYPTED_CONTENT_CHARS = 2_000_000;
const REQUEST_HEADER_TIMEOUT_MS = 30_000;
const REQUEST_IDLE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 30_000;
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
const TRUSTED_CODEX_HOST = "chatgpt.com";
export const BETA_FEATURE = "remote_compaction_v2";

export interface CodexCompactionRequest {
  model: {
    id: string;
    baseUrl: string;
    headers?: Record<string, string>;
  };
  apiKey: string;
  authHeaders?: Record<string, string>;
  sessionId?: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CodexCompactionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface CodexCompactionResult {
  encryptedContent: string;
  usage?: CodexCompactionUsage;
}

/**
 * Keep the original string-returning API for callers that only need the
 * checkpoint. The extension uses requestRemoteCompactionWithUsage below.
 */
export async function requestRemoteCompaction(request: CodexCompactionRequest): Promise<string> {
  return (await requestRemoteCompactionWithUsage(request)).encryptedContent;
}

export async function requestRemoteCompactionWithUsage(
  request: CodexCompactionRequest,
): Promise<CodexCompactionResult> {
  const endpoint = resolveCodexResponsesUrl(request.model.baseUrl);
  const accountId = extractAccountId(request.apiKey);
  const headers = buildHeaders(request, accountId);
  const body = JSON.stringify(request.body);
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Codex compaction request exceeded the size limit");
  }

  const requestState = requestSignal(request.signal);
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      requestState.startAttempt();

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: requestState.signal,
        });
        requestState.headersReceived();

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const error = new CodexCompactionError(
            `Codex compaction request returned HTTP ${response.status}`,
            isRetryableStatus(response.status),
          );
          if (!error.retryable || attempt >= MAX_RETRIES) throw error;
          await waitForRetry(response, attempt, requestState.signal);
          continue;
        }

        try {
          return await readCompactionSse(response, requestState.signal, requestState.touch);
        } catch (error) {
          if (!isRetryableError(error) || attempt >= MAX_RETRIES || requestState.signal.aborted) {
            throw error;
          }
          await waitForRetry(undefined, attempt, requestState.signal);
        }
      } catch (error) {
        if (requestState.signal.aborted || !isRetryableError(error) || attempt >= MAX_RETRIES) {
          throw error;
        }
        await waitForRetry(undefined, attempt, requestState.signal);
      }
    }
  } finally {
    requestState.cleanup();
  }

  throw new Error("Codex compaction request failed");
}

export function resolveCodexResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Codex compaction requires an HTTPS endpoint");
  }
  if (url.hostname.toLowerCase() !== TRUSTED_CODEX_HOST) {
    throw new Error("Codex compaction endpoint is not a trusted Codex origin");
  }
  if (url.username || url.password) {
    throw new Error("Codex compaction endpoint must not contain URL credentials");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/codex/responses")) {
    return url.toString();
  }
  url.pathname = path.endsWith("/codex") ? `${path}/responses` : `${path}/codex/responses`;
  return url.toString();
}

export function parseCompactionSse(sse: string): string {
  return parseCompactionSseResult(sse).encryptedContent;
}

export function parseCompactionSseResult(sse: string): CodexCompactionResult {
  if (new TextEncoder().encode(sse).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Codex compaction response exceeded the size limit");
  }
  const parser = new CompactionSseParser();
  parser.push(sse);
  return parser.finish();
}

function buildHeaders(request: CodexCompactionRequest, accountId: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.model.headers ?? {})) headers.set(name, value);
  for (const [name, value] of Object.entries(request.authHeaders ?? {})) headers.set(name, value);

  headers.set("Authorization", `Bearer ${request.apiKey}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("x-codex-beta-features", BETA_FEATURE);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  const sessionId = safeSessionId(request.sessionId);
  if (sessionId) {
    headers.set("session-id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }
  return headers;
}

export function getCodexAccountFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(extractAccountId(token)).digest("hex")}`;
}

function extractAccountId(token: string): string {
  const segment = token.split(".")[1];
  if (!segment) throw new Error("Codex authentication token has no account claim");

  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    const claim = isRecord(payload) ? payload[ACCOUNT_ID_CLAIM] : undefined;
    const accountId = isRecord(claim) ? claim.chatgpt_account_id : undefined;
    if (typeof accountId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(accountId)) {
      throw new Error("missing account claim");
    }
    return accountId;
  } catch {
    throw new Error("Codex authentication token has no valid account claim");
  }
}

function safeSessionId(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return undefined;
  return value;
}

async function readCompactionSse(
  response: Response,
  signal: AbortSignal,
  touch: () => void,
): Promise<CodexCompactionResult> {
  if (!response.body) {
    throw new CodexCompactionError("Codex compaction response has no body", true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new CompactionSseParser();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new CodexCompactionError("Codex compaction response exceeded the size limit", false);
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    return parser.finish();
  } catch (error) {
    if (error instanceof CodexCompactionError) throw error;
    if (signal.aborted) throw error;
    throw new CodexCompactionError("Codex compaction response stream failed", true);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class CompactionSseParser {
  private buffer = "";
  private completed = false;
  private status: string | undefined;
  private compactionItems: Array<string | undefined> = [];
  private usage: CodexCompactionUsage | undefined;

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator < 0) break;
      const frame = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      this.processFrame(frame);
    }
  }

  finish(): CodexCompactionResult {
    if (this.buffer.trim()) this.processFrame(this.buffer);
    if (!this.completed) {
      throw new CodexCompactionError("Codex compaction stream ended before response completion", true);
    }
    if (this.status && this.status !== "completed") {
      throw new CodexCompactionError("Codex compaction response failed", false);
    }
    if (this.compactionItems.length !== 1) {
      throw new CodexCompactionError(
        `Codex compaction returned ${this.compactionItems.length} checkpoint items`,
        false,
      );
    }

    const encryptedContent = this.compactionItems[0];
    if (!encryptedContent) {
      throw new CodexCompactionError("Codex compaction returned an invalid checkpoint", false);
    }
    return {
      encryptedContent,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private processFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;

    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new CodexCompactionError("Codex compaction returned invalid SSE data", false);
    }
    if (!isRecord(event)) return;

    if (event.type === "error" || event.type === "response.failed") {
      throw new CodexCompactionError("Codex compaction response failed", false);
    }

    if (event.type === "response.output_item.done") {
      this.collectCompactionItem(event.item);
    }

    if (event.type === "response.completed" || event.type === "response.done") {
      const response = isRecord(event.response) ? event.response : undefined;
      this.status = typeof response?.status === "string" ? response.status : undefined;
      this.usage = parseUsage(response?.usage ?? event.usage);

      // Codex emits output_item.done before response.completed. Retain this
      // fallback for compact Responses implementations that only return the
      // completed response's output array.
      if (this.compactionItems.length === 0) {
        collectOutputItems(response?.output, (item) => this.collectCompactionItem(item));
      }
      this.completed = true;
    }
  }

  private collectCompactionItem(value: unknown): void {
    if (!isRecord(value) || value.type !== "compaction") return;
    const encryptedContent = value.encrypted_content;
    this.compactionItems.push(
      typeof encryptedContent === "string" &&
        encryptedContent.length > 0 &&
        encryptedContent.length <= MAX_ENCRYPTED_CONTENT_CHARS
        ? encryptedContent
        : undefined,
    );
  }
}

function collectOutputItems(value: unknown, collect: (item: unknown) => void): void {
  if (!Array.isArray(value)) return;
  for (const item of value) collect(item);
}

function parseUsage(value: unknown): CodexCompactionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteNonNegativeNumber(value.input_tokens);
  const outputTokens = finiteNonNegativeNumber(value.output_tokens);
  const totalTokens = finiteNonNegativeNumber(value.total_tokens);
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined;
  const cachedInputTokens = finiteNonNegativeNumber(inputDetails?.cached_tokens);
  const reasoningTokens = finiteNonNegativeNumber(outputDetails?.reasoning_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function waitForRetry(
  response: Response | undefined,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const retryAfter = response ? parseRetryAfter(response.headers) : undefined;
  const delay = Math.min(
    MAX_RETRY_DELAY_MS,
    retryAfter ?? RETRY_BASE_DELAY_MS * 2 ** attempt,
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Codex compaction request aborted"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function parseRetryAfter(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const seconds = headers.get("retry-after");
  if (!seconds) return undefined;
  const numeric = Number(seconds);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1_000;
  const date = Date.parse(seconds);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

class CodexCompactionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodexCompactionError";
  }
}

function isRetryableError(error: unknown): boolean {
  return error instanceof CodexCompactionError
    ? error.retryable
    : error instanceof Error;
}

interface RequestSignal {
  signal: AbortSignal;
  startAttempt: () => void;
  headersReceived: () => void;
  touch: () => void;
  cleanup: () => void;
}

function requestSignal(signal: AbortSignal | undefined): RequestSignal {
  const controller = new AbortController();
  let headerTimeout: ReturnType<typeof setTimeout> | undefined;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  const clearTimers = () => {
    if (headerTimeout) clearTimeout(headerTimeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    headerTimeout = undefined;
    idleTimeout = undefined;
  };
  const touch = () => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(
      () => controller.abort(new Error("Codex compaction response idle timeout")),
      REQUEST_IDLE_TIMEOUT_MS,
    );
  };

  return {
    signal: controller.signal,
    startAttempt: () => {
      clearTimers();
      headerTimeout = setTimeout(
        () => controller.abort(new Error("Codex compaction request timed out waiting for response headers")),
        REQUEST_HEADER_TIMEOUT_MS,
      );
    },
    headersReceived: () => {
      if (headerTimeout) clearTimeout(headerTimeout);
      headerTimeout = undefined;
      touch();
    },
    touch,
    cleanup: () => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
