import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { readStoredCredential, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { object } from "./parse.js";
import { UsageError, type UsageProvider } from "./types.js";

export const ENDPOINTS = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "github-copilot": "https://api.github.com/copilot_internal/user",
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
  "zai-coding-cn": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
} as const;

const ORIGINS: Record<UsageProvider, readonly string[]> = {
  openai: ["https://api.openai.com"],
  "openai-codex": ["https://chatgpt.com"],
  anthropic: ["https://api.anthropic.com"],
  "github-copilot": [
    "https://api.individual.githubcopilot.com",
    "https://api.business.githubcopilot.com",
    "https://api.enterprise.githubcopilot.com",
    "https://api.githubcopilot.com",
  ],
  zai: ["https://api.z.ai"],
  "zai-coding-cn": ["https://open.bigmodel.cn"],
  "opencode-go": ["https://opencode.ai"],
};

export interface UsageRequest {
  /** Quota source, which can differ from the active model only for the openai fallback. */
  provider: Exclude<UsageProvider, "openai">;
  url: typeof ENDPOINTS[keyof typeof ENDPOINTS];
  headers: Record<string, string>;
}

type UsageRegistry = Pick<ModelRegistry, "getApiKeyAndHeaders" | "getProvider" | "getProviderAuth">;
interface ResolvedUsageAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

function validateOrigin(provider: UsageProvider, url: string): void {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password && ORIGINS[provider].includes(parsed.origin)) return;
  } catch { /* Fail closed, including relative and malformed URLs. */ }
  throw new UsageError("custom endpoint unsupported");
}

function header(headers: Record<string, string | null> | undefined, name: string): string | null | undefined {
  const values = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  if (values.length > 1 && values.some(value => value !== values[0])) throw new UsageError("auth required");
  return values[0];
}

function secret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function legacyAccountId(token: string): string | undefined {
  // Routing metadata only; the server verifies the JWT. Native SIWC metadata stays opaque.
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const claims = object(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    const id = object(claims["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function resolvedToken(resolved: ResolvedUsageAuth): string {
  let token = resolved.apiKey;
  const authorization = header(resolved.headers, "authorization");
  if (authorization !== undefined) {
    // Null explicitly removes auth. Never fall back to an overridden stored credential.
    if (typeof authorization !== "string" || !/^Bearer \S+$/i.test(authorization)) throw new UsageError("auth required");
    token = authorization.slice(7);
  }
  const apiKeyHeader = header(resolved.headers, "x-api-key");
  if (apiKeyHeader !== undefined && apiKeyHeader !== token) throw new UsageError("auth required");
  if (!secret(token)) throw new UsageError("auth required");
  return token;
}

function codexRequest(resolved: ResolvedUsageAuth): UsageRequest {
  if (resolved.baseUrl !== undefined) validateOrigin("openai-codex", resolved.baseUrl);
  const token = resolvedToken(resolved);
  const account = legacyAccountId(token);
  if (!account) throw new UsageError("subscription auth required");
  const override = header(resolved.headers, "chatgpt-account-id");
  if (override !== undefined && override !== account) throw new UsageError("auth required");
  return {
    provider: "openai-codex", url: ENDPOINTS["openai-codex"],
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account },
  };
}

async function resolveCodexFallback(registry: UsageRegistry): Promise<UsageRequest | undefined> {
  const provider = registry.getProvider("openai-codex");
  if (!provider) return undefined;
  validateOrigin("openai-codex", provider.baseUrl ?? "");
  // Pi owns credential selection and locked OAuth refresh, including custom stores.
  // Never read a stale access token directly or bypass a failed refresh.
  const resolved = await registry.getProviderAuth("openai-codex");
  if (resolved?.source !== "OAuth") return undefined;
  return codexRequest(resolved.auth);
}

export async function resolveUsageRequest(
  provider: UsageProvider,
  model: Model<Api>,
  registry: UsageRegistry,
  readCredential: (provider: string) => Credential | undefined = readStoredCredential,
): Promise<UsageRequest> {
  validateOrigin(provider, model.baseUrl);
  if (provider === "openai") {
    // Temporary, documented exception: the Codex login may be another account.
    const fallback = await resolveCodexFallback(registry);
    if (fallback) return fallback;
  }
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (!resolved.ok) throw new UsageError("auth required");
  if (resolved.baseUrl !== undefined) validateOrigin(provider, resolved.baseUrl);
  if (provider === "openai-codex") return codexRequest(resolved);
  const token = resolvedToken(resolved);

  if (provider === "openai") {
    const stored = readCredential(provider);
    if (stored?.type !== "oauth" || stored.access !== token
      || typeof stored.clientId !== "string" || !Array.isArray(stored.scopes)
      || !stored.scopes.includes("chatgpt.tokens.use.direct")) {
      throw new UsageError("subscription auth required");
    }
    // No eligible Codex login. Never send the native token to a legacy endpoint.
    throw new UsageError("native quota unavailable");
  }

  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (provider === "anthropic") {
    if (!token.startsWith("sk-ant-oat")) throw new UsageError("subscription auth required");
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else if (provider === "github-copilot") {
    // Pi's access token is for inference. The same Pi grant's original GitHub token
    // lives in `refresh`; no other stored account may supply this credential.
    const stored = readCredential(provider);
    if (stored?.type !== "oauth" || stored.access !== token || !secret(stored.refresh)) {
      throw new UsageError("Pi Copilot login required");
    }
    if (stored.enterpriseUrl) throw new UsageError("enterprise quota unsupported");
    headers.Authorization = `token ${stored.refresh}`;
    headers["Editor-Version"] = "vscode/1.96.2";
    headers["Editor-Plugin-Version"] = "copilot-chat/0.26.7";
    headers["User-Agent"] = "GitHubCopilotChat/0.26.7";
    headers["X-Github-Api-Version"] = "2025-04-01";
  }
  return { provider, url: ENDPOINTS[provider], headers };
}
