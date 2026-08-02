export const FAST_SERVICE_TIER = "priority" as const;

export interface FastModel {
  readonly provider: string;
  readonly id: string;
}

const OPENAI_CODEX_FAST_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export function supportsFastMode(model: FastModel | undefined): boolean {
  return model?.provider === "openai-codex" && OPENAI_CODEX_FAST_MODELS.has(model.id);
}

export function applyFastMode(payload: unknown, model: FastModel | undefined): unknown {
  if (!supportsFastMode(model) || !isRecord(payload)) return payload;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
