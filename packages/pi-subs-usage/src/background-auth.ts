import type { Api, Model } from "@earendil-works/pi-ai";
import { VERSION, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { object } from "./parse.js";
import { UsageError } from "./types.js";

export type BackgroundAuthRegistry = Pick<ModelRegistry, "getRegisteredProviderConfig">;

function command(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("!");
}

function headersUseCommand(headers: unknown): boolean {
  return Object.values(object(headers)).some(command);
}

function modelHeaders(config: Record<string, unknown>, id: string): Record<string, unknown> {
  const definition = Array.isArray(config.models)
    ? config.models.find(value => object(value).id === id && (object(value).type ?? "chat") === "chat")
    : undefined;
  return {
    ...object(object(object(config.modelOverrides)[id]).headers),
    ...object(object(definition).headers),
  };
}

function checkConfiguration(runtime: Record<string, unknown>, registry: BackgroundAuthRegistry, target: Model<Api> | string): void {
  const config = object(runtime.config);
  if (typeof config.getProvider !== "function") throw new UsageError("background auth unavailable");
  const provider = typeof target === "string" ? target : target.provider;
  const configured = object(config.getProvider(provider));
  const extension = object(registry.getRegisteredProviderConfig(provider));
  const providerHeaders = { ...object(configured.headers), ...object(extension.headers) };
  const perModelHeaders = typeof target === "string" ? {} : {
    ...modelHeaders(configured, target.id), ...modelHeaders(extension, target.id),
  };
  // Check provider and model layers separately: Pi resolves provider headers
  // even if a later model header overrides their result.
  if (command(extension.apiKey ?? configured.apiKey)
    || headersUseCommand(providerHeaders) || headersUseCommand(perModelHeaders)) {
    throw new UsageError("command auth unsupported");
  }
}

/**
 * Read-only Pi 1.1 compatibility boundary. Its public auth facade cannot check
 * for commands in hidden model headers or AuthStorage without resolving them.
 * Inspect the already-loaded config and raw credential store, never guessed
 * config paths. Unknown host shapes fail closed instead of risking execSync.
 * Remove this adapter when Pi exposes a non-command auth-resolution policy.
 */
export async function assertBackgroundAuthSafe(
  registry: BackgroundAuthRegistry,
  target: Model<Api> | string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const unavailable = () => new UsageError("background auth unavailable");
  const runtime = object(object(registry).runtime);
  const config = object(runtime.config);
  const credentials = object(runtime.credentials);
  const store = object(credentials.store);
  if (!/^1\.1\./.test(VERSION) || typeof config.getProvider !== "function"
    || typeof registry.getRegisteredProviderConfig !== "function"
    || !(credentials.overrides instanceof Map) || typeof store.read !== "function") {
    throw unavailable();
  }

  const provider = typeof target === "string" ? target : target.provider;
  checkConfiguration(runtime, registry, target);

  let credential: unknown;
  const override = credentials.overrides.get(provider);
  // RuntimeCredentials.read ignores empty overrides and reads the store instead.
  if (override) {
    credential = { type: "api_key", key: override };
  } else if ("readState" in store || "readLatestData" in store) {
    // AuthStorage.read() executes auth.json key commands. Its raw read refreshes
    // the same backing store asynchronously, without resolving configured values.
    if (typeof store.readLatestData !== "function" || !("data" in object(store.readState))) {
      throw unavailable();
    }
    credential = object(await store.readLatestData({ signal }))[provider];
  } else {
    // Other CredentialStore implementations expose raw credentials by contract.
    // Pi's ReadOnlyAuthStorage also returns !commands without executing them.
    credential = await store.read(provider, { signal });
  }
  signal?.throwIfAborted();
  if (object(credential).type === "api_key" && command(object(credential).key)) {
    throw new UsageError("command auth unsupported");
  }
  // A store read can yield while Pi reloads configuration. Do not approve a
  // newly command-backed model based on the earlier configuration snapshot.
  checkConfiguration(runtime, registry, target);
}
