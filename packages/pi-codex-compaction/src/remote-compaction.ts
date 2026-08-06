import { stream as captureProviderPayload } from "@earendil-works/pi-ai/compat";
import type { Model, Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  getCodexAccountFingerprint,
  requestRemoteCompactionWithUsage,
  resolveCodexResponsesUrl,
  type CodexCompactionUsage,
} from "./codex-wire.js";

export const REMOTE_SUMMARY_MARKER = "[pi-codex-compaction:v1]";
export const REMOTE_COMPACTION_KIND = "pi-codex-compaction";

const FALLBACK_SUMMARY_MAX_CHARS = 12_000;
const MAX_ENCRYPTED_CONTENT_CHARS = 2_000_000;
const COMPACTION_RESPONSE_RESERVE_TOKENS = 8_192;
const TRUNCATED_TOOL_OUTPUT = "[Tool output omitted from the Codex compaction request to fit the active model context window.]";
const PI_COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

export interface RemoteCompactionDetails {
  kind: typeof REMOTE_COMPACTION_KIND;
  version: 2;
  provider: "openai-codex";
  model: string;
  endpoint: string;
  accountFingerprint: string;
  authKind: CodexAuthKind;
  encryptedContent: string;
  usage?: CodexCompactionUsage;
}

export type CodexAuthKind = "oauth" | "api-key" | "unknown";

type CodexModel = Pick<
  Model<any>,
  "id" | "api" | "provider" | "baseUrl" | "contextWindow" | "headers" | "reasoning"
>;
type AgentMessage = ReturnType<typeof sessionEntryToContextMessages>[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function supportsRemoteCompaction(model: Pick<CodexModel, "api" | "provider"> | undefined): boolean {
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function findActiveRemoteCompaction(entries: readonly SessionEntry[]): RemoteCompactionDetails | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    return isRemoteCompactionDetails(entry.details) ? entry.details : undefined;
  }
  return undefined;
}

/**
 * Check the model, endpoint, and account before reusing an opaque checkpoint.
 * The checkpoint is intentionally not treated as portable across those
 * boundaries because the service can bind its encryption to them.
 */
export function isRemoteCompactionCompatible(
  details: RemoteCompactionDetails,
  model: Pick<CodexModel, "id" | "api" | "provider" | "baseUrl">,
  accountFingerprint: string,
  authKind: CodexAuthKind = "unknown",
): boolean {
  if (!supportsRemoteCompaction(model) || details.model !== model.id) return false;
  if (details.accountFingerprint !== accountFingerprint) return false;
  if (details.authKind !== authKind) return false;
  try {
    return details.endpoint === resolveCodexResponsesUrl(model.baseUrl);
  } catch {
    return false;
  }
}

export function applyRemoteCompactionMarker(payload: unknown, details: RemoteCompactionDetails): unknown | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

  let replaced = false;
  const input = payload.input.map((item) => {
    if (replaced || !isCompactionSummaryInput(item)) return item;
    replaced = true;
    return {
      type: "compaction",
      encrypted_content: details.encryptedContent,
    };
  });
  return replaced ? { ...payload, input } : undefined;
}

export async function createRemoteCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  getTools: () => readonly ToolInfoLike[],
  thinkingLevel?: string,
): Promise<{
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: RemoteCompactionDetails;
} | undefined> {
  // Pi's custom focus is part of the standard summarizer contract. The
  // Responses compaction envelope has no documented equivalent, so do not
  // silently discard it.
  if (event.customInstructions?.trim()) return undefined;

  const model = ctx.model as CodexModel | undefined;
  if (!model || !supportsRemoteCompaction(model)) return undefined;

  const endpoint = resolveCodexResponsesUrl(model.baseUrl);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<any>);
  if (!auth.ok || !auth.apiKey) return undefined;
  const accountFingerprint = getCodexAccountFingerprint(auth.apiKey);
  const authKind = getCodexAuthKind(ctx.modelRegistry, model as Model<any>);

  const previous = findActiveRemoteCompaction(ctx.sessionManager.buildContextEntries());
  const compatiblePrevious = previous && isRemoteCompactionCompatible(previous, model, accountFingerprint, authKind)
    ? previous
    : undefined;
  const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
  const instructions = ctx.getSystemPrompt() || "You are a helpful assistant.";
  const sessionId = ctx.sessionManager.getSessionId();
  const providerPayload = await captureCodexPayload(
    model,
    instructions,
    convertToLlm(messages),
    getTools(),
    auth.apiKey,
    auth.headers,
    sessionId,
    event.signal,
    thinkingLevel,
  );
  if (!providerPayload) return undefined;
  const providerInput = providerPayload.input;
  if (!Array.isArray(providerInput)) return undefined;
  const providerTools = Array.isArray(providerPayload.tools) ? providerPayload.tools : [];

  const input = appendCompactionItems(providerInput, event.preparation, compatiblePrevious);
  const requestBody = {
    ...providerPayload,
    model: model.id,
    store: false,
    stream: true,
  };
  const boundedInput = boundCompactionInput(
    input,
    instructions,
    providerTools,
    model.contextWindow,
    requestBody,
  );
  if (!boundedInput) return undefined;

  const result = await requestRemoteCompactionWithUsage({
    model,
    apiKey: auth.apiKey,
    authHeaders: auth.headers,
    sessionId,
    body: {
      ...requestBody,
      input: boundedInput,
    },
    signal: event.signal,
  });

  const fallback = buildFallbackSummary(event.preparation, messages);
  return {
    summary: `${REMOTE_SUMMARY_MARKER}\n\n${fallback}`,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    details: {
      kind: REMOTE_COMPACTION_KIND,
      version: 2,
      provider: "openai-codex",
      model: model.id,
      endpoint,
      accountFingerprint,
      authKind,
      encryptedContent: result.encryptedContent,
      ...(result.usage ? { usage: result.usage } : {}),
    },
  };
}

export function buildCompactionInput(
  model: CodexModel,
  preparation: SessionBeforeCompactEvent["preparation"],
  messages: AgentMessage[],
  previous: RemoteCompactionDetails | undefined,
): unknown[] {
  return appendCompactionItems(convertCompactionMessages(model, convertToLlm(messages)), preparation, previous);
}

export function boundCompactionInput(
  input: readonly unknown[],
  instructions: string,
  tools: readonly unknown[],
  contextWindow: number,
  requestPayload?: Record<string, unknown>,
): unknown[] | undefined {
  const budget = Math.max(1, Math.floor(contextWindow - COMPACTION_RESPONSE_RESERVE_TOKENS));
  // A byte-level bound is conservative when the active model's tokenizer is unavailable:
  // a token can be represented by a single UTF-8 byte, but not fewer.
  const budgetBytes = budget;
  const bounded = input.map((item) => item);
  let requestBytes = estimateConservativeBytes(
    buildCompactionRequest(requestPayload, bounded, instructions, tools),
  );
  if (requestBytes <= budgetBytes) return bounded;

  // ponytail: trim tool outputs first; if structural content still exceeds the active model window,
  // let Pi's standard compaction path handle the request instead of inventing a lossy transcript rewrite.
  for (let index = bounded.length - 1; index >= 0; index--) {
    const item = bounded[index];
    const replacement = trimToolOutput(item);
    if (!replacement) continue;

    requestBytes += estimateConservativeBytes(replacement) - estimateConservativeBytes(item);
    bounded[index] = replacement;
    if (requestBytes <= budgetBytes) return bounded;
  }

  return undefined;
}

export function buildFallbackSummary(preparation: SessionBeforeCompactEvent["preparation"], messages: AgentMessage[]): string {
  const transcript = serializeConversation(convertToLlm(messages));
  const previous = preparation.previousSummary ? `Previous checkpoint fallback:\n${preparation.previousSummary}` : "";
  const fileOperations = formatFileOperations(preparation.fileOps);
  const content = [
    "This checkpoint is opaque to non-Codex providers. Use the transcript excerpt below when continuing this session.",
    previous,
    transcript ? `Discarded conversation excerpt:\n${transcript}` : "",
    fileOperations,
  ]
    .filter(Boolean)
    .join("\n\n");
  return `<codex-compaction-fallback>\n${limitText(content, FALLBACK_SUMMARY_MAX_CHARS)}\n</codex-compaction-fallback>`;
}

async function captureCodexPayload(
  model: CodexModel,
  instructions: string,
  messages: ReturnType<typeof convertToLlm>,
  tools: readonly ToolInfoLike[],
  apiKey: string,
  authHeaders: Record<string, string> | undefined,
  sessionId: string,
  signal: AbortSignal,
  thinkingLevel: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (signal.aborted) return undefined;

  let payload: unknown;
  const captureError = new Error("capture Codex request payload");
  const options: Record<string, unknown> = {
    apiKey,
    headers: authHeaders,
    sessionId,
    signal,
    onPayload(next: unknown) {
      payload = next;
      throw captureError;
    },
  };
  if (model.reasoning && isThinkingLevel(thinkingLevel) && thinkingLevel !== "off") {
    options.reasoningEffort = thinkingLevel;
  }

  const stream = captureProviderPayload(model as Model<any>, {
    systemPrompt: instructions,
    messages,
    tools: [...tools],
  }, options);

  await stream.result();
  return isRecord(payload) ? payload : undefined;
}

function appendCompactionItems(
  input: readonly unknown[],
  preparation: SessionBeforeCompactEvent["preparation"],
  previous: RemoteCompactionDetails | undefined,
): unknown[] {
  const output = [...input];
  if (previous) {
    output.unshift({ type: "compaction", encrypted_content: previous.encryptedContent });
  } else if (preparation.previousSummary) {
    output.unshift({
      type: "message",
      role: "user",
      // This is bounded together with the complete request envelope below;
      // the readable fallback limit is only for non-Codex continuation.
      content: [{ type: "input_text", text: preparation.previousSummary }],
      status: "completed",
    });
  }
  output.push({ type: "compaction_trigger" });
  return output;
}

function convertCompactionMessages(model: CodexModel, messages: readonly unknown[]): unknown[] {
  const input: unknown[] = [];
  let messageIndex = 0;

  for (const rawMessage of messages) {
    if (!isRecord(rawMessage)) continue;
    const role = rawMessage.role;

    if (role === "user") {
      const content = convertUserContent(rawMessage.content);
      if (content.length > 0) input.push({ type: "message", role: "user", content });
    } else if (role === "assistant") {
      const output: unknown[] = [];
      const sourceIsSameResponsesApi = rawMessage.provider === model.provider && rawMessage.api === model.api;
      const differentModel = sourceIsSameResponsesApi && rawMessage.model !== model.id;
      let textIndex = 0;
      if (Array.isArray(rawMessage.content)) {
        for (const rawBlock of rawMessage.content) {
          if (!isRecord(rawBlock)) continue;
          if (rawBlock.type === "thinking" && typeof rawBlock.thinkingSignature === "string") {
            try {
              const reasoning = JSON.parse(rawBlock.thinkingSignature) as unknown;
              if (isRecord(reasoning)) output.push(reasoning);
            } catch {
              // Ignore malformed reasoning signatures; the textual/tool history remains usable.
            }
          } else if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
            const signature = parseTextSignature(rawBlock.textSignature);
            output.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: rawBlock.text, annotations: [] }],
              status: "completed",
              id: signature?.id ?? `msg_pi_${messageIndex}${textIndex ? `_${textIndex}` : ""}`,
              ...(signature?.phase ? { phase: signature.phase } : {}),
            });
            textIndex++;
          } else if (rawBlock.type === "toolCall" && typeof rawBlock.id === "string") {
            const [callId, itemIdRaw] = splitToolCallId(rawBlock.id);
            output.push({
              type: "function_call",
              ...(itemIdRaw && !differentModel ? { id: normalizeResponseItemId(itemIdRaw) } : {}),
              call_id: callId,
              name: typeof rawBlock.name === "string" ? rawBlock.name : "",
              arguments: JSON.stringify(rawBlock.arguments ?? {}),
            });
          }
        }
      }
      input.push(...output);
    } else if (role === "toolResult") {
      const content = Array.isArray(rawMessage.content) ? rawMessage.content : [];
      const text = content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      const hasImage = content.some((part) => isRecord(part) && part.type === "image");
      const toolCallId = typeof rawMessage.toolCallId === "string" ? rawMessage.toolCallId : "";
      input.push({
        type: "function_call_output",
        call_id: splitToolCallId(toolCallId)[0],
        output: text || (hasImage ? "(see attached image)" : "(no tool output)"),
      });
    }

    messageIndex++;
  }

  return input;
}

function convertUserContent(value: unknown): unknown[] {
  if (typeof value === "string") return [{ type: "input_text", text: value }];
  if (!Array.isArray(value)) return [];

  const content: unknown[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "input_text", text: part.text });
    } else if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
      content.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` });
    }
  }
  return content;
}

function parseTextSignature(value: unknown): { id: string; phase?: string } | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!value.startsWith("{")) return { id: value.slice(0, 64) };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string") return undefined;
    return {
      id: parsed.id.slice(0, 64),
      ...(typeof parsed.phase === "string" ? { phase: parsed.phase } : {}),
    };
  } catch {
    return undefined;
  }
}

function splitToolCallId(value: string): [string, string | undefined] {
  const separator = value.indexOf("|");
  return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)];
}

function normalizeResponseItemId(value: string): string {
  let normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
  if (!normalized.startsWith("fc")) normalized = `fc_${normalized}`;
  return normalized.slice(0, 64);
}

function isCompactionSummaryInput(value: unknown): boolean {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "message") || value.role !== "user" || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.some(
    (part) =>
      isRecord(part) &&
      part.type === "input_text" &&
      typeof part.text === "string" &&
      part.text.trimStart().startsWith(PI_COMPACTION_SUMMARY_PREFIX) &&
      part.text.includes(REMOTE_SUMMARY_MARKER),
  );
}

function isRemoteCompactionDetails(value: unknown): value is RemoteCompactionDetails {
  return (
    isRecord(value) &&
    value.kind === REMOTE_COMPACTION_KIND &&
    value.version === 2 &&
    value.provider === "openai-codex" &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    value.model.length <= 256 &&
    typeof value.endpoint === "string" &&
    value.endpoint.length <= 2_048 &&
    typeof value.accountFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.accountFingerprint) &&
    (value.authKind === "oauth" || value.authKind === "api-key" || value.authKind === "unknown") &&
    typeof value.encryptedContent === "string" &&
    value.encryptedContent.length > 0 &&
    value.encryptedContent.length <= MAX_ENCRYPTED_CONTENT_CHARS &&
    (value.usage === undefined || isCodexCompactionUsage(value.usage))
  );
}

export function getCodexAuthKind(
  modelRegistry: unknown,
  model: Model<any>,
): CodexAuthKind {
  const isUsingOAuth = isRecord(modelRegistry) ? modelRegistry.isUsingOAuth : undefined;
  if (typeof isUsingOAuth !== "function") return "unknown";
  try {
    return isUsingOAuth.call(modelRegistry, model) ? "oauth" : "api-key";
  } catch {
    return "unknown";
  }
}

function isCodexCompactionUsage(value: unknown): value is CodexCompactionUsage {
  return isRecord(value) && Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
  );
}

function buildCompactionRequest(
  requestPayload: Record<string, unknown> | undefined,
  input: readonly unknown[],
  instructions: string,
  tools: readonly unknown[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = requestPayload ? { ...requestPayload } : {};
  payload.instructions = instructions;
  payload.input = input;
  if (tools.length > 0 || requestPayload && "tools" in requestPayload) payload.tools = tools;
  return payload;
}

function trimToolOutput(value: unknown): unknown | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.type === "function_call_output" ||
      value.type === "custom_tool_call_output" ||
      value.type === "local_shell_call_output" ||
      value.type === "computer_call_output") &&
    value.output !== undefined
  ) {
    return { ...value, output: TRUNCATED_TOOL_OUTPUT };
  }
  if (value.type === "tool_search_output" && Array.isArray(value.tools)) {
    return { ...value, tools: [] };
  }
  return undefined;
}

function estimateConservativeBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value) ?? "";
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function formatFileOperations(fileOps: { read: Set<string>; edited: Set<string> }): string {
  const read = [...fileOps.read].filter((path): path is string => typeof path === "string").sort();
  const edited = [...fileOps.edited].filter((path): path is string => typeof path === "string").sort();
  if (read.length === 0 && edited.length === 0) return "";
  return [
    "File operations in discarded history:",
    read.length > 0 ? `- Read: ${read.join(", ")}` : "",
    edited.length > 0 ? `- Modified: ${edited.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omission = "\n\n[… earlier fallback context omitted …]\n\n";
  const available = Math.max(0, maxChars - omission.length);
  const head = Math.floor(available * 0.35);
  return `${text.slice(0, head)}${omission}${text.slice(text.length - (available - head))}`;
}

type ToolInfoLike = Pick<Tool, "name" | "description" | "parameters">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
