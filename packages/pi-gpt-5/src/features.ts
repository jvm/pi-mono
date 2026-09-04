/**
 * Machine-readable feature gate for OpenAI GPT-5.x models on the Responses API.
 *
 * This file mirrors `features_gate.md`. When OpenAI changes model capabilities,
 * update `features_gate.md` first, then this table, in the same change.
 *
 * Sources and verification steps live in `features_gate.md`.
 */

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningMode = "standard" | "pro";

export type Verbosity = "low" | "medium" | "high";

export interface ModelFeatures {
  /** Reasoning effort values the model accepts on the wire. */
  efforts: ReasoningEffort[];
  /** `reasoning.mode: "pro"` is accepted (GPT-5.6+). */
  proMode: boolean;
  /** Model is a dedicated legacy Pro slug (pro capability via slug, never via `reasoning.mode`). */
  legacyProSlug: boolean;
  /** `reasoning.context` accepts `all_turns` (persisted reasoning). */
  persistedReasoning: boolean;
  /** Model default for `reasoning.context` when the parameter is omitted. */
  reasoningContextDefault: "all_turns" | "current_turn";
  /** `text.verbosity` is advertised for this model (Codex backend catalog). */
  verbosity: boolean;
  /** `prompt_cache_options` explicit cache mode is accepted. */
  explicitPromptCacheMode: boolean;
  /** Programmatic Tool Calling (`programmatic_tool_calling` tool + `program` items). */
  programmaticToolCalling: boolean;
  /** Hosted multi-agent beta (`multi_agent.enabled`, `OpenAI-Beta: responses_multi_agent=v1`). */
  multiAgent: boolean;
  /** Image input accepts `detail: "original"` without downscaling. */
  originalImageDetail: boolean;
  /** Assistant messages carry a `phase` value that must survive manual history replay. */
  messagePhase: boolean;
  /** Freeform/grammar tool definitions (apply_patch style) are accepted. */
  grammarTools: boolean;
  /** Additional hosted tools and `search_tools` style dynamic activation. */
  additionalTools: boolean;
  /** Structured-output strict schemas. */
  strictSchemas: boolean;
}

const GPT56_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function gpt56(overrides: Partial<ModelFeatures> = {}): ModelFeatures {
  return {
    efforts: GPT56_EFFORTS,
    proMode: true,
    legacyProSlug: false,
    persistedReasoning: true,
    reasoningContextDefault: "all_turns",
    verbosity: true,
    explicitPromptCacheMode: true,
    programmaticToolCalling: true,
    multiAgent: true,
    originalImageDetail: true,
    messagePhase: true,
    grammarTools: true,
    additionalTools: true,
    strictSchemas: true,
    ...overrides,
  };
}

/**
 * Feature gates per model id, as registered in Pi's model registry for the
 * official `openai` provider (`api: "openai-responses"`). The `gpt-5.6` alias
 * resolves to `gpt-5.6-sol` before lookup.
 */
export const MODEL_FEATURES: Readonly<Record<string, ModelFeatures>> = {
  "gpt-5.6-sol": gpt56(),
  "gpt-5.6-terra": gpt56(),
  "gpt-5.6-luna": gpt56(),

  "gpt-5.5": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
  }),
  "gpt-5.5-pro": gpt56({
    efforts: ["medium", "high", "xhigh"],
    proMode: false,
    legacyProSlug: true,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    additionalTools: false,
  }),

  "gpt-5.4": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    verbosity: true,
  }),
  "gpt-5.4-mini": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
  }),
  "gpt-5.4-nano": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: false,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    additionalTools: false,
  }),
  "gpt-5.4-pro": gpt56({
    efforts: ["medium", "high", "xhigh"],
    proMode: false,
    legacyProSlug: true,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    verbosity: false,
  }),

  "gpt-5.3-codex": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: false,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    additionalTools: false,
  }),
  "gpt-5.3-codex-spark": gpt56({
    efforts: ["low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: false,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    additionalTools: false,
  }),

  "gpt-5.2": gpt56({
    efforts: ["none", "low", "medium", "high", "xhigh"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    messagePhase: false,
  }),
  "gpt-5.2-pro": gpt56({
    efforts: ["medium", "high", "xhigh"],
    proMode: false,
    legacyProSlug: true,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: false,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    messagePhase: false,
    additionalTools: false,
  }),

  "gpt-5.1": gpt56({
    efforts: ["none", "low", "medium", "high"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: false,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    messagePhase: false,
  }),

  "gpt-5": gpt5({}),
  "gpt-5-mini": gpt5({ verbosity: false }),
  "gpt-5-nano": gpt5({ verbosity: false }),
  "gpt-5-pro": gpt5({
    efforts: ["high"],
    legacyProSlug: true,
    verbosity: false,
    additionalTools: false,
  }),
};

function gpt5(overrides: Partial<ModelFeatures>): ModelFeatures {
  return gpt56({
    efforts: ["minimal", "low", "medium", "high"],
    proMode: false,
    persistedReasoning: false,
    reasoningContextDefault: "current_turn",
    verbosity: true,
    explicitPromptCacheMode: false,
    programmaticToolCalling: false,
    multiAgent: false,
    originalImageDetail: false,
    messagePhase: false,
    additionalTools: false,
    ...overrides,
  });
}

/** Resolve the `gpt-5.6` alias and return the gate for a model id, or `undefined` for unknown models. */
export function featuresFor(modelId: string): ModelFeatures | undefined {
  const id = modelId === "gpt-5.6" ? "gpt-5.6-sol" : modelId;
  return MODEL_FEATURES[id];
}
