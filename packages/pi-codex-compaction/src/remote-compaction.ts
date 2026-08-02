import { stream as captureProviderPayload } from "@earendil-works/pi-ai/compat";
import type { Model, Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { requestRemoteCompaction } from "./codex-wire.js";

export const REMOTE_SUMMARY_MARKER = "[pi-codex-compaction:v1]";
export const REMOTE_COMPACTION_KIND = "pi-codex-compaction";

const FALLBACK_SUMMARY_MAX_CHARS = 12_000;
const MAX_ENCRYPTED_CONTENT_CHARS = 2_000_000;
const COMPACTION_RESPONSE_RESERVE_TOKENS = 8_192;
const TRUNCATED_TOOL_OUTPUT = "[Tool output omitted from the Codex compaction request to fit the active model context window.]";
const PI_COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

export interface RemoteCompactionDetails {
  kind: typeof REMOTE_COMPACTION_KIND;
  version: 1;
  provider: "openai-codex";
  model: string;
  encryptedContent: string;
}

type CodexModel = Pick<Model<any>, "id" | "api" | "provider" | "baseUrl" | "contextWindow" | "headers">;
type AgentMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

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
): Promise<{
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: RemoteCompactionDetails;
} | undefined> {
  const model = ctx.model as CodexModel | undefined;
  if (!model || !supportsRemoteCompaction(model)) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<any>);
  if (!auth.ok || !auth.apiKey) return undefined;

  const previous = findActiveRemoteCompaction(ctx.sessionManager.buildContextEntries());
  const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
  const instructions = ctx.getSystemPrompt() || "You are a helpful assistant.";
  const sessionId = ctx.sessionManager.getSessionId();
  const providerPayload = await captureCodexPayload(
    model,
    instructions,
    convertToLlm(messages),
    getTools(),
    auth.apiKey,
    sessionId,
    event.signal,
  );
  if (!providerPayload) return undefined;
  const providerInput = providerPayload.input;
  if (!Array.isArray(providerInput)) return undefined;
  const providerTools = Array.isArray(providerPayload.tools) ? providerPayload.tools : [];

  const input = appendCompactionItems(providerInput, event.preparation, previous);
  const boundedInput = boundCompactionInput(input, instructions, providerTools, model.contextWindow);
  if (!boundedInput) return undefined;

  const encryptedContent = await requestRemoteCompaction({
    model,
    apiKey: auth.apiKey,
    authHeaders: auth.headers,
    sessionId,
    body: {
      ...providerPayload,
      model: model.id,
      store: false,
      stream: true,
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
      version: 1,
      provider: "openai-codex",
      model: model.id,
      encryptedContent,
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
): unknown[] | undefined {
  const budget = Math.max(1, contextWindow - COMPACTION_RESPONSE_RESERVE_TOKENS);
  const bounded = input.map((item) => item);
  let payloadBytes = estimateJsonBytes({ instructions, input: bounded, tools });
  const fits = () => Math.ceil(payloadBytes / 4) <= budget;
  if (fits()) return bounded;

  // ponytail: trim tool outputs first; if structural content still exceeds the active model window,
  // let Pi's standard compaction path handle the request instead of inventing a lossy transcript rewrite.
  for (let index = bounded.length - 1; index >= 0; index--) {
    const item = bounded[index];
    if (!isRecord(item)) continue;

    const replacement = item.type === "function_call_output"
      ? { ...item, output: TRUNCATED_TOOL_OUTPUT }
      : item.type === "tool_search_output"
        ? { ...item, tools: [] }
        : undefined;
    if (!replacement) continue;

    payloadBytes += estimateJsonBytes(replacement) - estimateJsonBytes(item);
    bounded[index] = replacement;
    if (fits()) return bounded;
  }

  return undefined;
}

export function buildFallbackSummary(preparation: SessionBeforeCompactEvent["preparation"], messages: AgentMessage[]): string {
  const transcript = serializeConversation(convertToLlm(messages));
  const previous = preparation.previousSummary ? `Previous checkpoint fallback:\n${preparation.previousSummary}` : "";
  const content = [
    "This checkpoint is opaque to non-Codex providers. Use the transcript excerpt below when continuing this session.",
    previous,
    transcript ? `Discarded conversation excerpt:\n${transcript}` : "",
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
  sessionId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (signal.aborted) return undefined;

  let payload: unknown;
  const captureError = new Error("capture Codex request payload");
  const stream = captureProviderPayload(model as Model<any>, {
    systemPrompt: instructions,
    messages,
    tools: [...tools],
  }, {
    apiKey,
    sessionId,
    signal,
    onPayload(next) {
      payload = next;
      throw captureError;
    },
  });

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
      content: [{ type: "input_text", text: limitText(preparation.previousSummary, FALLBACK_SUMMARY_MAX_CHARS) }],
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
    value.version === 1 &&
    value.provider === "openai-codex" &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.encryptedContent === "string" &&
    value.encryptedContent.length > 0 &&
    value.encryptedContent.length <= MAX_ENCRYPTED_CONTENT_CHARS
  );
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
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
