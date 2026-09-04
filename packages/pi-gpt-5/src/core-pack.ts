import type { ModelFeatures } from "./features.js";

export type ReasoningContextPin = "auto" | "all_turns" | "current_turn";
export type VerbosityPin = "auto" | "low" | "medium" | "high";
export type ImageDetailPin = "auto" | "low" | "high" | "original";

export interface CorePackSettings {
  /** `reasoning.mode: "pro"` (GPT-5.6 only). Entitlement is checked at toggle time. */
  proMode: boolean;
  /** `reasoning.context` pin; "auto" omits the field so the model default applies. */
  reasoningContext: ReasoningContextPin;
  /** `text.verbosity` pin; "auto" leaves the provider payload untouched. */
  verbosity: VerbosityPin;
  /** Image `detail` pin; "auto" leaves the provider payload untouched. */
  imageDetail: ImageDetailPin;
}

export const DEFAULT_SETTINGS: CorePackSettings = {
  proMode: false,
  reasoningContext: "auto",
  verbosity: "auto",
  imageDetail: "auto",
};

/**
 * Apply every enabled core-pack setting to a Responses API payload.
 * Returns the payload unchanged when the model is unknown or nothing is set,
 * so non-OpenAI models stay fully passive.
 */
export function applyCorePack(
  payload: unknown,
  settings: CorePackSettings,
  features: ModelFeatures | undefined,
): unknown {
  if (!features || !isRecord(payload)) return payload;

  let next: unknown = payload;
  if (settings.proMode && features.proMode) next = applyProMode(next);
  if (settings.reasoningContext !== "auto" && features.persistedReasoning) {
    next = applyReasoningContext(next, settings.reasoningContext);
  }
  if (settings.verbosity !== "auto" && features.verbosity) {
    next = applyVerbosity(next, settings.verbosity);
  }
  if (settings.imageDetail !== "auto") {
    next = applyImageDetail(next, settings.imageDetail, features);
  }
  return next;
}

export function applyProMode(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  return { ...payload, reasoning: { ...reasoning, mode: "pro" } };
}

export function applyReasoningContext(payload: unknown, context: "all_turns" | "current_turn"): unknown {
  if (!isRecord(payload)) return payload;
  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  return { ...payload, reasoning: { ...reasoning, context } };
}

export function applyVerbosity(payload: unknown, verbosity: "low" | "medium" | "high"): unknown {
  if (!isRecord(payload)) return payload;
  const text = isRecord(payload.text) ? payload.text : {};
  return { ...payload, text: { ...text, verbosity } };
}

/**
 * Set `detail` on every input image part. `original` is only sent to models
 * that advertise it; other models receive `high` (Codex's default), which is
 * the closest non-downscaling-safe value below `original`.
 */
export function applyImageDetail(payload: unknown, detail: ImageDetailPin, features: ModelFeatures): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  const effective = detail === "original" && !features.originalImageDetail ? "high" : detail;
  return {
    ...payload,
    input: payload.input.map((item) => withImageDetail(item, effective)),
  };
}

function withImageDetail(item: unknown, detail: string): unknown {
  if (!isRecord(item)) return item;
  const content = item.content;
  if (!Array.isArray(content)) return item;
  let changed = false;
  const nextContent = content.map((part) => {
    if (isRecord(part) && part.type === "input_image" && part.detail !== detail) {
      changed = true;
      return { ...part, detail };
    }
    return part;
  });
  return changed ? { ...item, content: nextContent } : item;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
