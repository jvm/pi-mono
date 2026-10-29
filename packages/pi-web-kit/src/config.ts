import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FetchProviderName, SearchProviderName, WebKitConfig } from "./types.js";

const SEARCH = ["exa", "tinyfish", "brave", "firecrawl"] as const;
const FETCH = ["exa", "tinyfish", "markdown_new", "firecrawl"] as const;
const DEFAULT_CONFIG: WebKitConfig = {
  enabled: true,
  provider_search: "exa",
  provider_fetch: "exa",
  apiKeys: {},
  markdownNew: { method: "auto", retainImages: false },
};
const PROVIDER_ENV_NAMES = {
  exa: "EXA_API_KEY",
  tinyfish: "TINYFISH_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  context7: "CONTEXT7_API_KEY",
} as const;

type PartialConfig = Partial<Omit<WebKitConfig, "apiKeys" | "markdownNew">> & {
  apiKeys?: Partial<WebKitConfig["apiKeys"]>;
  markdownNew?: Partial<WebKitConfig["markdownNew"]>;
};

export function resolveConfig(
  flags: { providerSearch?: unknown; providerFetch?: unknown } = {},
  cwd = process.cwd(),
  env = process.env,
  options: { includeProject?: boolean } = {},
): WebKitConfig {
  let cfg = DEFAULT_CONFIG;
  cfg = merge(cfg, {
    provider_search: env.PI_WEB_KIT_PROVIDER_SEARCH as SearchProviderName | undefined,
    provider_fetch: env.PI_WEB_KIT_PROVIDER_FETCH as FetchProviderName | undefined,
    apiKeys: {
      exa: env.EXA_API_KEY,
      tinyfish: env.TINYFISH_API_KEY,
      brave: env.BRAVE_SEARCH_API_KEY,
      firecrawl: env.FIRECRAWL_API_KEY,
      context7: env.CONTEXT7_API_KEY,
    },
  });
  // Production follows Pi's host-supplied resolver (including custom agent
  // directories). Preserve explicit environment injection for library callers.
  const home = env.HOME ?? homedir();
  const agentDir = env === process.env ? getAgentDir()
    : env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[/\\])/, () => home) || join(home, CONFIG_DIR_NAME, "agent");
  const globalConfig = readConfigFile(join(agentDir, "pi-web-kit.json"));
  if (globalConfig) cfg = merge(cfg, globalConfig);
  if (options.includeProject !== false) {
    const projectConfig = readConfigFile(join(cwd, ".pi-web-kit.json"));
    if (projectConfig) cfg = merge(cfg, projectConfig);
  }
  cfg = merge(cfg, {
    provider_search: flags.providerSearch as SearchProviderName | undefined,
    provider_fetch: flags.providerFetch as FetchProviderName | undefined,
  });
  validateSearchProvider(cfg.provider_search);
  validateFetchProvider(cfg.provider_fetch);
  if (typeof cfg.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  return cfg;
}

function merge(base: WebKitConfig, patch: PartialConfig): WebKitConfig {
  if (Object.hasOwn(patch, "toolExposure")) throw new Error("toolExposure was removed; exposure follows active codemode.");
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : base.enabled,
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

function readConfigFile(path: string): PartialConfig | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PartialConfig;
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    return undefined;
  }
}

export function requireKey(config: WebKitConfig, provider: "exa" | "tinyfish" | "brave" | "firecrawl" | "context7"): string {
  const key = config.apiKeys[provider];
  const envName = PROVIDER_ENV_NAMES[provider];
  if (!key) throw new Error(`${provider} provider requires ${envName} or apiKeys.${provider} in project or agent-directory pi-web-kit config.`);
  return key;
}
