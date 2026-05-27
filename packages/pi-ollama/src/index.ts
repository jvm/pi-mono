export type OllamaModelConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: Record<string, unknown>;
};

export type OllamaProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  compat: Record<string, unknown>;
  models: OllamaModelConfig[];
};

type OllamaModelSummary = {
  name?: string;
  model?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
};

type OllamaShowResponse = {
  parameters?: string;
  capabilities?: string[];
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
};

type FetchLike = typeof fetch;

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_CONTEXT_WINDOW = 4096;
const DEFAULT_TIMEOUT_MS = 3000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function resolveOllamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(env.PI_OLLAMA_HOST ?? env.OLLAMA_HOST ?? env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL);
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_OLLAMA_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/(api|v1)$/i, "");
}

export function toOpenAIBaseUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/v1`;
}

export async function discoverOllamaProvider(options: {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
} = {}): Promise<OllamaProviderConfig> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? resolveOllamaBaseUrl());
  const timeoutMs = options.timeoutMs ?? timeoutFromEnv();
  const fetchImpl = options.fetch ?? fetch;

  const models = await discoverModels(baseUrl, timeoutMs, fetchImpl).catch(() => []);

  return {
    name: "Ollama (local)",
    baseUrl: toOpenAIBaseUrl(baseUrl),
    apiKey: "ollama",
    api: "openai-completions",
    compat: ollamaCompat(),
    models,
  };
}

export async function discoverModels(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch,
): Promise<OllamaModelConfig[]> {
  const tags = (await fetchJson<{ models?: OllamaModelSummary[] }>(
    `${normalizeBaseUrl(baseUrl)}/api/tags`,
    { method: "GET" },
    timeoutMs,
    fetchImpl,
  )) ?? { models: [] };

  const summaries = Array.isArray(tags.models) ? tags.models : [];
  const discovered = await Promise.all(
    summaries.map(async (summary) => {
      const id = summary.model ?? summary.name;
      if (!id) return undefined;
      const details = await showModel(baseUrl, id, timeoutMs, fetchImpl).catch(() => undefined);
      return toPiModel(summary, details);
    }),
  );

  return discovered
    .filter((model): model is OllamaModelConfig => Boolean(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function toPiModel(summary: OllamaModelSummary, show?: OllamaShowResponse): OllamaModelConfig | undefined {
  const id = summary.model ?? summary.name;
  if (!id) return undefined;

  const capabilities = new Set((show?.capabilities ?? []).map((capability) => capability.toLowerCase()));
  const family = show?.details?.family ?? summary.details?.family;
  const families = show?.details?.families ?? summary.details?.families ?? [];
  const familyText = [id, family, ...families].filter(Boolean).join(" ").toLowerCase();
  const contextWindow = getContextWindow(show);
  const maxTokens = getMaxTokens(show, contextWindow);
  const reasoning = capabilities.has("thinking") || looksLikeThinkingModel(familyText);
  const input: ("text" | "image")[] =
    capabilities.has("vision") || looksLikeVisionModel(familyText) ? ["text", "image"] : ["text"];

  return {
    id,
    name: displayName(id, show ?? summary),
    reasoning,
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(familyText) } : {}),
    input,
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
    compat: ollamaCompat(),
  };
}

function timeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PI_OLLAMA_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function showModel(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<OllamaShowResponse> {
  return fetchJson<OllamaShowResponse>(
    `${normalizeBaseUrl(baseUrl)}/api/show`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    },
    timeoutMs,
    fetchImpl,
  );
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function getContextWindow(show?: OllamaShowResponse): number {
  const parameterContext = parseParameterNumber(show?.parameters, "num_ctx");
  if (parameterContext && parameterContext > 0) return parameterContext;

  const infoContext = findModelInfoNumber(show?.model_info, /(^|\.)context_length$/i);
  if (infoContext && infoContext > 0) return infoContext;

  return DEFAULT_CONTEXT_WINDOW;
}

function getMaxTokens(show: OllamaShowResponse | undefined, contextWindow: number): number {
  const numPredict = parseParameterNumber(show?.parameters, "num_predict");
  if (numPredict && numPredict > 0) return Math.min(numPredict, contextWindow);
  return Math.min(16384, Math.max(1024, Math.floor(contextWindow / 2)));
}

function parseParameterNumber(parameters: string | undefined, key: string): number | undefined {
  if (!parameters) return undefined;
  for (const line of parameters.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match || match[1] !== key) continue;
    const parsed = Number(match[2].trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function findModelInfoNumber(modelInfo: Record<string, unknown> | undefined, keyPattern: RegExp): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!keyPattern.test(key)) continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function looksLikeThinkingModel(text: string): boolean {
  return /\b(qwen3|deepseek[-_ ]?(r1|v3\.1)|gpt[-_ ]?oss)\b/i.test(text);
}

function looksLikeVisionModel(text: string): boolean {
  return /\b(gemma[34]|qwen\d*[-_ ]?vl|llama[-_ ]?4|llava|bakllava|minicpm[-_ ]?v|moondream|pixtral|granite[-_ ]?vision)\b/i.test(
    text,
  );
}

function thinkingLevelMap(text: string): Record<string, string | null> {
  if (/gpt[-_ ]?oss/i.test(text)) {
    return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high" };
  }
  return { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };
}

function displayName(id: string, details: OllamaShowResponse | OllamaModelSummary): string {
  const modelDetails = details.details;
  const suffix = [modelDetails?.parameter_size, modelDetails?.quantization_level].filter(Boolean).join(" ");
  return suffix ? `${id} (${suffix}, Ollama)` : `${id} (Ollama)`;
}

function ollamaCompat(): Record<string, unknown> {
  return {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: true,
  };
}
