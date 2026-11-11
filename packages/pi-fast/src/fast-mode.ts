export const FAST_SERVICE_TIER = "fast" as const;
// Keep the older spelling for ChatGPT OAuth and legacy Codex compatibility.
export const PRIORITY_SERVICE_TIER = "priority" as const;

export interface FastModel {
  readonly provider: string;
  readonly id: string;
  readonly api?: string;
}

const OPENAI_FAST_MODELS: ReadonlySet<string> = new Set([
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export function supportsFastMode(model: FastModel | undefined): boolean {
  if (!model || !OPENAI_FAST_MODELS.has(model.id)) return false;
  return model.provider === "openai-codex" ||
    (model.provider === "openai" && model.api === "openai-responses");
}

export function applyFastMode(payload: unknown, model: FastModel | undefined, isUsingOAuth = false): unknown {
  if (!supportsFastMode(model) || !isRecord(payload)) return payload;
  const tier = model?.provider === "openai-codex" || isUsingOAuth
    ? PRIORITY_SERVICE_TIER
    : FAST_SERVICE_TIER;
  return { ...payload, service_tier: tier };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
