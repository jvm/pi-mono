import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveUsageRequest } from "./auth.js";
import { formatUsage } from "./format.js";
import { abortable, fetchUsageJson, REQUEST_TIMEOUT_MS } from "./http.js";
import { parseUsage } from "./parse.js";
import { errorMessage, isUsageProvider, type UsageProvider, type UsageSnapshot } from "./types.js";

export const STATUS_KEY = "pi-subs-usage";
export const POLL_MS = 120_000;
export const TICK_MS = 15_000;

export function isOffline(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

interface CachedUsage {
  identity?: string;
  snapshot?: UsageSnapshot;
  message: string;
}

interface Target {
  key: string;
  model: Model<Api>;
  provider: UsageProvider;
}

interface FetchedUsage {
  payload: unknown;
  fetchedAt: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelKey(model: Model<Api>): string {
  // Never retain header credentials in a cache key. Equivalent model objects
  // from the registry and model_select must find the same cached reading.
  return digest([model.provider, model.id, model.api, model.baseUrl,
    Object.entries(model.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

export class UsageMonitor {
  private ctx?: ExtensionContext;
  private model?: Model<Api>;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private flight?: Promise<void>;
  private generation = 0;
  private lastRequest = -Infinity;
  private cache = new Map<string, CachedUsage>();
  private message = "usage unavailable";
  private published?: string;
  private enabled = true;

  start(ctx: ExtensionContext): void {
    this.stop();
    if (ctx.mode !== "tui") return;
    this.ctx = ctx;
    this.model = ctx.model;
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      if (isOffline() || Date.now() - this.lastRequest >= POLL_MS) void this.refresh();
      else this.render();
    }, TICK_MS);
    this.timer.unref();
    // Do not hold up session_start or the editor while inactive providers load.
    void this.refresh();
  }

  select(ctx: ExtensionContext, model = ctx.model): void {
    if (ctx.mode !== "tui") {
      this.stop();
      return;
    }
    this.ctx = ctx;
    this.model = model;
    // Selection never resolves credentials, polls, cancels a poll, or resets its clock.
    this.render();
  }

  private cancelRefresh(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.flight = undefined;
  }

  stop(): void {
    this.cancelRefresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cache.clear();
    this.message = "usage unavailable";
    this.lastRequest = -Infinity;
    if (this.ctx?.mode === "tui") this.ctx.ui.setStatus(STATUS_KEY, undefined);
    this.published = undefined;
    this.ctx = undefined;
    this.model = undefined;
  }

  toggle(ctx: ExtensionContext, enabled: boolean): void {
    this.enabled = enabled;
    this.start(ctx);
  }

  refresh(): Promise<void> {
    const { ctx } = this;
    if (!ctx || !this.enabled || ctx.mode !== "tui") return Promise.resolve();
    if (isOffline()) {
      this.cancelRefresh();
      this.cache.clear();
      this.lastRequest = -Infinity;
      this.render();
      return Promise.resolve();
    }
    if (this.flight) return this.flight;
    this.lastRequest = Date.now();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    // One bounded cycle; independent provider workers keep a slow service from
    // delaying other services. Pi's auth promises cannot themselves be cancelled.
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    this.flight = this.poll(ctx, controller.signal, generation).finally(() => {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.controller = undefined;
        this.flight = undefined;
        this.render();
      }
    });
    return this.flight;
  }

  private async poll(ctx: ExtensionContext, signal: AbortSignal, generation: number): Promise<void> {
    const current = () => generation === this.generation;
    const requests = new Map<string, Promise<FetchedUsage>>();
    try {
      const groups = new Map<UsageProvider, Target[]>();
      const nextCache = new Map<string, CachedUsage>();
      // Use Pi's public availability snapshot, not auth files or project config.
      for (const model of ctx.modelRegistry.getAvailable()) {
        if (!isUsageProvider(model.provider)) continue;
        const key = modelKey(model);
        if (nextCache.has(key)) continue;
        nextCache.set(key, this.cache.get(key) ?? { message: "loading" });
        const targets = groups.get(model.provider) ?? [];
        targets.push({ key, model, provider: model.provider });
        groups.set(model.provider, targets);
      }
      this.cache = nextCache; // Also evict removed providers/models.
      this.message = "usage unavailable";
      this.render();

      // At most one worker per supported provider. Resolve EVERY model's auth:
      // Pi can hide model-specific Authorization overrides from model.headers.
      // Only identical effective quota requests may share an HTTP response.
      await Promise.all([...groups.values()].map(async targets => {
        for (const { key, model, provider } of targets) {
          if (!current()) return;
          try {
            signal.throwIfAborted();
            const request = await abortable(resolveUsageRequest(provider, model, ctx.modelRegistry, undefined, signal), signal);
            if (!current()) return;
            signal.throwIfAborted();
            const identity = digest(request);
            const previous = this.cache.get(key);
            if (previous?.identity !== identity) {
              this.cache.set(key, { identity, message: "loading" });
              this.render();
            }
            let pending = requests.get(identity);
            if (!pending) {
              pending = abortable(fetchUsageJson(request, signal), signal)
                .then(payload => ({ payload, fetchedAt: Date.now() }));
              requests.set(identity, pending);
            }
            const { payload, fetchedAt } = await pending;
            if (!current()) return;
            signal.throwIfAborted();
            this.cache.set(key, {
              identity,
              // Normalize once at fetch time, including relative reset times
              // and model-specific windows. Switching only renders this snapshot.
              snapshot: parseUsage(request.provider, payload, model.id, fetchedAt),
              message: "",
            });
          } catch (error) {
            if (!current()) return;
            // A failed account must not retain a misleading numerical reading.
            this.cache.set(key, { message: errorMessage(error) });
          }
          this.render();
        }
      }));
    } catch (error) {
      if (current()) {
        this.cache.clear();
        this.message = errorMessage(error);
      }
    } finally {
      // Raw payloads and request promises live only for this poll, never on disk.
      requests.clear();
    }
  }

  private render(): void {
    if (!this.ctx) return;
    let status: string | undefined;
    if (this.enabled && this.model && isUsageProvider(this.model.provider)) {
      const cached = this.cache.get(modelKey(this.model));
      const text = isOffline() ? "offline"
        : cached?.snapshot ? formatUsage(cached.snapshot, Date.now())
        : cached?.message ?? this.message;
      status = `[${text}]`;
    }
    if (status !== this.published) {
      this.ctx.ui.setStatus(STATUS_KEY, status);
      this.published = status;
    }
  }
}
