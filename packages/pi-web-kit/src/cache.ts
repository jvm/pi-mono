import { FETCH_CACHE_MAX_BYTES, FETCH_CACHE_MAX_ENTRIES, FETCH_CACHE_TTL_MS } from "./limits.js";

export type CachedPage = {
  provider: string;
  cacheKey: string;
  requestedUrl: string;
  url: string;
  title?: string;
  content: string;
  format: string;
  metadata?: Record<string, unknown>;
  fetchedAt: number;
  bytes: number;
};

type Entry = { page: CachedPage; lastAccessed: number };

export class FetchCache {
  private entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(private opts = { maxEntries: FETCH_CACHE_MAX_ENTRIES, maxBytes: FETCH_CACHE_MAX_BYTES, ttlMs: FETCH_CACHE_TTL_MS }) {}

  get totalCachedBytes() { return this.totalBytes; }
  get size() {
    this.evictExpired();
    return this.entries.size;
  }

  get(key: string, now = Date.now()): CachedPage | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.page.fetchedAt > this.opts.ttlMs) {
      this.delete(key);
      return undefined;
    }
    entry.lastAccessed = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: Omit<CachedPage, "bytes"> & { bytes?: number }, now = Date.now()): CachedPage {
    const bytes = page.bytes ?? byteLength(page.content);
    const stored = { ...page, bytes };
    this.delete(key);
    this.entries.set(key, { page: stored, lastAccessed: now });
    this.totalBytes += bytes;
    this.evict(now);
    return stored;
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private delete(key: string) {
    const old = this.entries.get(key);
    if (!old) return;
    this.totalBytes -= old.page.bytes;
    this.entries.delete(key);
  }

  private evict(now = Date.now()) {
    this.evictExpired(now);
    while (this.entries.size > this.opts.maxEntries || this.totalBytes > this.opts.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.delete(oldest);
    }
  }

  private evictExpired(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.page.fetchedAt > this.opts.ttlMs) this.delete(key);
    }
  }
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export const fetchCache = new FetchCache();
