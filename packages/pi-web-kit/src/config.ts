import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchProviderName, SearchProviderName, WebKitConfig } from "./types.js";

const SEARCH = ["exa_mcp", "exa", "tinyfish", "brave", "firecrawl"] as const;
const FETCH = ["exa_mcp", "exa", "tinyfish", "markdown_new", "firecrawl"] as const;

type PartialConfig = Partial<Omit<WebKitConfig, "apiKeys" | "markdownNew">> & {
  apiKeys?: Partial<WebKitConfig["apiKeys"]>;
  markdownNew?: Partial<WebKitConfig["markdownNew"]>;
};

export function resolveConfig(flags: { providerSearch?: unknown; providerFetch?: unknown } = {}, cwd = process.cwd(), env = process.env): WebKitConfig {
  let cfg: WebKitConfig = {
    provider_search: "exa_mcp",
    provider_fetch: "exa_mcp",
    apiKeys: {},
    markdownNew: { method: "auto", retainImages: false },
  };
  cfg = merge(cfg, {
    provider_search: env.PI_WEB_KIT_PROVIDER_SEARCH as SearchProviderName | undefined,
    provider_fetch: env.PI_WEB_KIT_PROVIDER_FETCH as FetchProviderName | undefined,
    apiKeys: {
      exa: env.EXA_API_KEY,
      tinyfish: env.TINYFISH_API_KEY,
      brave: env.BRAVE_SEARCH_API_KEY,
      firecrawl: env.FIRECRAWL_API_KEY,
    },
  });
  const home = env.HOME ?? homedir();
  for (const path of [join(home, ".pi/agent/pi-web-kit.json"), join(cwd, ".pi-web-kit.json")]) {
    try { cfg = merge(cfg, JSON.parse(readFileSync(path, "utf8")) as PartialConfig); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  }
  cfg = merge(cfg, {
    provider_search: flags.providerSearch as SearchProviderName | undefined,
    provider_fetch: flags.providerFetch as FetchProviderName | undefined,
  });
  validateSearchProvider(cfg.provider_search);
  validateFetchProvider(cfg.provider_fetch);
  return cfg;
}

function merge(base: WebKitConfig, patch: PartialConfig): WebKitConfig {
  return {
    provider_search: patch.provider_search ?? base.provider_search,
    provider_fetch: patch.provider_fetch ?? base.provider_fetch,
    apiKeys: clean({ ...base.apiKeys, ...patch.apiKeys }),
    markdownNew: { ...base.markdownNew, ...patch.markdownNew },
  };
}

function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] == null || obj[k] === "") delete obj[k];
  return obj;
}

export function validateSearchProvider(name: string): asserts name is SearchProviderName {
  if (!SEARCH.includes(name as SearchProviderName)) throw new Error(`Unknown search provider '${name}'. Expected one of: ${SEARCH.join(", ")}.`);
}

export function validateFetchProvider(name: string): asserts name is FetchProviderName {
  if (!FETCH.includes(name as FetchProviderName)) throw new Error(`Unknown fetch provider '${name}'. Expected one of: ${FETCH.join(", ")}.`);
}

const PROVIDER_ENV_NAMES = { exa: "EXA_API_KEY", tinyfish: "TINYFISH_API_KEY", brave: "BRAVE_SEARCH_API_KEY", firecrawl: "FIRECRAWL_API_KEY" } as const;

export function requireKey(config: WebKitConfig, provider: "exa" | "tinyfish" | "brave" | "firecrawl"): string {
  const key = config.apiKeys[provider];
  const envName = PROVIDER_ENV_NAMES[provider];
  if (!key) throw new Error(`${provider} provider requires ${envName} or apiKeys.${provider} in .pi-web-kit.json / ~/.pi/agent/pi-web-kit.json.`);
  return key;
}
