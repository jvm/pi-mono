const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ENCRYPTED_CONTENT_CHARS = 2_000_000;
const REQUEST_TIMEOUT_MS = 120_000;
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
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

export async function requestRemoteCompaction(request: CodexCompactionRequest): Promise<string> {
  const accountId = extractAccountId(request.apiKey);
  const headers = buildHeaders(request, accountId);
  const { signal, cleanup } = requestSignal(request.signal);

  try {
    const response = await fetch(resolveCodexResponsesUrl(request.model.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal,
    });

    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      throw new Error(`Codex compaction request returned HTTP ${response.status}`);
    }

    return parseCompactionSse(await readBoundedBody(response));
  } finally {
    cleanup();
  }
}

export function resolveCodexResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Codex compaction requires an HTTPS endpoint");
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
  const encryptedContents = new Set<string>();
  let completed = false;

  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;

    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("Codex compaction returned invalid SSE data");
    }
    if (!isRecord(event)) continue;

    if (event.type === "error" || event.type === "response.failed") {
      throw new Error("Codex compaction response failed");
    }

    if (event.type === "response.output_item.done") {
      collectCompactionItem(event.item, encryptedContents);
    }

    if (event.type === "response.completed" || event.type === "response.done") {
      const response = isRecord(event.response) ? event.response : undefined;
      collectOutputItems(response?.output, encryptedContents);
      completed = response?.status === undefined || response.status === "completed";
    }
  }

  if (!completed) {
    throw new Error("Codex compaction stream ended before response completion");
  }
  if (encryptedContents.size !== 1) {
    throw new Error(`Codex compaction returned ${encryptedContents.size} checkpoint items`);
  }
  return [...encryptedContents][0];
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

function collectOutputItems(value: unknown, encryptedContents: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) collectCompactionItem(item, encryptedContents);
}

function collectCompactionItem(value: unknown, encryptedContents: Set<string>): void {
  if (!isRecord(value) || value.type !== "compaction") return;
  const encryptedContent = value.encrypted_content;
  if (
    typeof encryptedContent === "string" &&
    encryptedContent.length > 0 &&
    encryptedContent.length <= MAX_ENCRYPTED_CONTENT_CHARS
  ) {
    encryptedContents.add(encryptedContent);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("Codex compaction response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("Codex compaction response exceeded the size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function requestSignal(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error("Codex compaction request timed out")), REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
