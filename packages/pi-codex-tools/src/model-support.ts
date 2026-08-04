import type { Model } from "@earendil-works/pi-ai";

const OPENAI_RESPONSES_APIS = new Set(["openai-codex-responses", "openai-responses"]);

export function supportsOpenAIGrammarTools(model: Model<any> | undefined): boolean {
  const compat = model?.compat as { supportsOpenAIGrammarTools?: boolean } | undefined;
  return model !== undefined && OPENAI_RESPONSES_APIS.has(model.api) && compat?.supportsOpenAIGrammarTools === true;
}

export function isOpenAIResponsesApi(api: string | undefined): boolean {
  return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}
