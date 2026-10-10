import { ENDPOINTS, type UsageRequest } from "./auth.js";
import { UsageError } from "./types.js";

export const MAX_RESPONSE_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

/** Bound even a host auth resolver that does not accept cancellation. Late results are discarded. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new UsageError("request failed"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchUsageJson(
  request: UsageRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  if (!(Object.values(ENDPOINTS) as string[]).includes(request.url)) throw new UsageError("custom endpoint unsupported");
  signal.throwIfAborted();
  const response = await fetcher(request.url, {
    method: "GET", headers: request.headers, redirect: "error", cache: "no-store", signal,
  });
  const cancel = async () => { await response.body?.cancel().catch(() => undefined); };
  if (!response.ok) {
    await cancel();
    if (response.status === 401 || response.status === 403) throw new UsageError("access denied");
    if (response.status === 429) throw new UsageError("rate limited");
    throw new UsageError("request failed");
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) {
    await cancel();
    throw new UsageError("invalid quota data");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new UsageError("invalid quota data");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new UsageError("invalid quota data");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
