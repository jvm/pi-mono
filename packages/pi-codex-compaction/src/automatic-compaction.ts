import { createHash, randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { getCurrentSystemMessage, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const KIND = "pi-codex-compaction:automatic:v1";
const CONFIG = `${KIND}:config`;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 1024;
const ENDPOINT = "https://api.openai.com/v1";
type Item = Record<string, unknown>;

interface Checkpoint {
  kind: typeof KIND;
  model: string;
  identity: string;
  summary: string;
  assistantEntryId: string;
  assistantHash: string;
  /** Fingerprints of every normalized output item, including those before the checkpoint. */
  outputHashes: string[];
  /** Exact provider checkpoint followed by the exact output suffix. */
  replay: Item[];
}

interface Attempt {
  sessionId: string;
  model: string;
  identity: string;
  leafId: string | null;
  responseId?: string;
  items: Map<number, Item>;
  itemBytes: number;
  output?: Item[];
  invalid: boolean;
  completed: boolean;
  started: number;
}

function record(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Canonical object ordering, for argument JSON and content comparison. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

/**
 * Compare provider output with Pi's replay serialization. Ignore transport-only
 * status/annotations, but never ignore text, tool arguments, identity or reasoning.
 * Unknown output shapes fail closed instead of inventing a replay mapping.
 */
function outputHash(item: unknown): string | undefined {
  if (!record(item)) return undefined;
  if (item.type === "message" && item.role === "assistant" && typeof item.id === "string" &&
      Array.isArray(item.content) && item.content.length === 1 &&
      record(item.content[0]) && item.content[0].type === "output_text" &&
      typeof item.content[0].text === "string") {
    return hash([item.type, item.id, item.phase ?? null, item.content[0].text]);
  }
  if (item.type === "reasoning" && typeof item.id === "string") return hash(sorted(item));
  if ((item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string" && typeof item.name === "string") {
    try {
      const args = item.type === "function_call" && typeof item.arguments === "string"
        ? sorted(JSON.parse(item.arguments))
        : item.type === "custom_tool_call" && typeof item.input === "string" ? item.input : undefined;
      if (args === undefined) return undefined;
      return hash([item.type, item.id ?? null, item.call_id, item.namespace ?? null, item.name, args]);
    } catch { return undefined; }
  }
  return undefined;
}

function validOutput(output: unknown): output is Item[] {
  if (!Array.isArray(output) || output.length > MAX_ITEMS || bytes(output) > MAX_BYTES) return false;
  return output.every((item) => record(item) && (item.type === "compaction"
    ? typeof item.id === "string" && typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0 && item.encrypted_content.length <= 2_000_000
    : outputHash(item) !== undefined));
}

function activeCheckpoint(ctx: ExtensionContext): Checkpoint | undefined {
  const entry = ctx.sessionManager.buildSessionProjection().entries
    .find((item) => item.sourceEntry.type === "compaction" && item.messages.length > 0)?.sourceEntry;
  if (entry?.type !== "compaction" || !record(entry.details)) return undefined;
  const d = entry.details;
  if (d.kind !== KIND || typeof d.model !== "string" || typeof d.identity !== "string" ||
      typeof d.summary !== "string" || d.summary !== entry.summary ||
      typeof d.assistantEntryId !== "string" || entry.firstKeptEntryId !== d.assistantEntryId ||
      typeof d.assistantHash !== "string" || !Array.isArray(d.outputHashes) ||
      d.outputHashes.length > MAX_ITEMS || !d.outputHashes.every((v) => typeof v === "string") ||
      !validOutput(d.replay) || d.replay[0]?.type !== "compaction" ||
      d.replay.slice(1).some((item) => item.type === "compaction")) return undefined;
  return d as unknown as Checkpoint;
}

function supports(model: Model<any> | undefined): model is Model<"openai-responses"> {
  return model?.provider === "openai" && model.api === "openai-responses" &&
    model.baseUrl === ENDPOINT && /^gpt-(5|6)([.-]|$)/.test(model.id);
}

async function identity(ctx: ExtensionContext): Promise<string | undefined> {
  if (!supports(ctx.model)) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey || (auth.baseUrl !== undefined && auth.baseUrl !== ENDPOINT)) return undefined;
  // Conservative credential binding: rotation invalidates replay, including OAuth
  // refresh. Never persist the token or rely on unverified JWT claims as identity.
  return hash([ctx.model.id, ENDPOINT, ctx.modelRegistry.isUsingOAuth(ctx.model),
    auth.apiKey, sorted(auth.headers ?? {}), sorted(ctx.model.headers ?? {})]);
}

function summaryText(item: unknown): string | undefined {
  if (!record(item) || item.role !== "user" || !Array.isArray(item.content) || item.content.length !== 1) return;
  const part = item.content[0];
  return record(part) && part.type === "input_text" && typeof part.text === "string" ? part.text : undefined;
}

function replay(payload: Item, checkpoint: Checkpoint, ctx: ExtensionContext): Item | undefined {
  if (!Array.isArray(payload.input)) return undefined;
  const projected = ctx.sessionManager.buildSessionProjection().entries
    .find((entry) => entry.sourceEntry.id === checkpoint.assistantEntryId);
  if (projected?.messages.length !== 1 || hash(projected.messages[0]) !== checkpoint.assistantHash) return undefined;
  // Match the exact Pi-generated summary, not arbitrary user text containing a marker.
  const wrapped = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${checkpoint.summary}\n</summary>`;
  const indices = payload.input.flatMap((item, index) => summaryText(item) === wrapped ? [index] : []);
  if (indices.length !== 1) return undefined;
  const index = indices[0]!;
  const start = index + 1;
  const serialized = payload.input.slice(start, start + checkpoint.outputHashes.length);
  if (serialized.length !== checkpoint.outputHashes.length ||
      serialized.some((item, i) => outputHash(item) !== checkpoint.outputHashes[i])) return undefined;
  // Keep current system/tool declarations before the marker and all later tool
  // results/messages. Never search-and-delete arbitrary matching output IDs.
  return { ...payload, input: [
    ...payload.input.slice(0, index),
    ...structuredClone(checkpoint.replay),
    ...payload.input.slice(start + serialized.length),
  ] };
}

function incompatible(payload: Item): boolean {
  return payload.previous_response_id != null || payload.conversation != null ||
    payload.context_management != null || payload.truncation != null ||
    payload.background === true || payload.generate === false ||
    (record(payload.multi_agent) && payload.multi_agent.enabled === true) ||
    !Array.isArray(payload.input) ||
    payload.input.some((item) => record(item) &&
      (item.type === "configuration_update" || item.type === "compaction_trigger"));
}

function fallbackSummary(entries: SessionEntry[], ctx: ExtensionContext): string {
  const projection = ctx.sessionManager.buildSessionProjection();
  const ids = new Set(entries.map((entry) => entry.id));
  const messages = projection.entries.filter((entry) => ids.has(entry.sourceEntry.id))
    .flatMap((entry) => entry.messages).filter((message) => message.role !== "system");
  const text = serializeConversation(convertToLlm(messages));
  const excerpt = text.length > 12_000 ? `${text.slice(0, 4000)}\n[Excerpt omitted]\n${text.slice(-8000)}` : text;
  return `[${KIND}:${randomUUID()}]\nProvider checkpoint; the following is only a bounded readable fallback, not a full summary.\n${excerpt}`;
}

/** Public Pi hooks only. No provider replacement, synthetic model turn, or private registry access. */
export function registerAutomaticCompaction(pi: ExtensionAPI): void {
  pi.registerFlag("server-compaction", { type: "boolean", default: true,
    description: "Server-side compaction on eligible public OpenAI Responses requests (default: on)" });
  pi.registerFlag("server-compaction-threshold", { type: "string",
    description: "Server compaction threshold in tokens (>=1000; default: 60% of Pi's trigger)" });
  let override: { enabled: boolean; threshold?: number } | undefined;
  let inTurn = false;
  let compacting = false;
  let attempt: Attempt | undefined;
  let blocked = false;
  let warmingModel: string | undefined;
  const modelKey = (model: Model<any>) => JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);

  const enabled = () => override?.enabled ?? pi.getFlag("server-compaction") === true;
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    inTurn = false;
    compacting = false;
    attempt = undefined;
    blocked = false;
    warmingModel = undefined;
    override = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CONFIG && record(entry.data) &&
          typeof entry.data.enabled === "boolean") {
        override = { enabled: entry.data.enabled,
          ...(Number.isSafeInteger(entry.data.threshold) && Number(entry.data.threshold) >= 1000
            ? { threshold: Number(entry.data.threshold) } : {}) };
      }
    }
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => { attempt = undefined; inTurn = false; warmingModel = undefined; });
  pi.on("turn_start", () => { inTurn = true; attempt = undefined; });
  pi.on("session_before_compact", () => { compacting = true; attempt = undefined; });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_compact_failed", () => { compacting = false; });
  pi.on("agent_end", () => { inTurn = false; attempt = undefined; });
  // Warming replays the previous request. Stop only if that actual request used
  // automatic compaction, even if the user subsequently switched the toggle off.
  // Other providers and requests skipped by the compatibility guard are unchanged.
  pi.on("cache_warming_decision", (_event, ctx) =>
    ctx.model && warmingModel === modelKey(ctx.model) ? { action: "stop" } : undefined);

  pi.registerCommand("server-compaction", {
    description: "Automatic compaction: on [token threshold], off, or status (default: on)",
    handler: async (args, ctx) => {
      const [action = "status", raw, ...extra] = args.trim() ? args.trim().split(/\s+/) : [];
      if (!["on", "off", "status"].includes(action) || extra.length > 0 ||
          (raw !== undefined && (action !== "on" || !/^\d+$/.test(raw) ||
            !Number.isSafeInteger(Number(raw)) || Number(raw) < 1000))) {
        if (ctx.hasUI) ctx.ui.notify("Use /server-compaction on [tokens >=1000], off, or status", "warning");
        return;
      }
      if (action !== "status") {
        await ctx.waitForIdle();
        override = { enabled: action === "on", ...(raw ? { threshold: Number(raw) } : {}) };
        pi.appendEntry(CONFIG, override);
        blocked = false;
      }
      const note = !supports(ctx.model) ? " (unavailable for the current provider/model)"
        : blocked ? " (paused after an unsuccessful request)" : "";
      if (ctx.hasUI) ctx.ui.notify(`Server compaction: ${enabled() ? "on" : "off"}${note}. Public OpenAI Responses only; Pi compaction remains the safety net.`, "info");
    },
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (inTurn && !compacting) warmingModel = undefined;
    if (!supports(ctx.model) || !record(event.payload) || event.payload.model !== ctx.model.id) return;
    let payload = event.payload;
    if (payload.previous_response_id != null || payload.conversation != null) return;
    const checkpoint = activeCheckpoint(ctx);
    // Disabled mode with no saved checkpoint must not cause extra auth resolution.
    if (!checkpoint && (!enabled() || blocked || !inTurn || compacting || incompatible(payload))) return;
    const credential = await identity(ctx);
    if (!credential) return;
    if (checkpoint && checkpoint.identity === credential && checkpoint.model === ctx.model.id) {
      payload = replay(payload, checkpoint, ctx) ?? payload;
    }
    // Do not configure standalone summarization, cache warming, or foreign nested calls.
    if (!enabled() || blocked || !inTurn || compacting || incompatible(payload)) return payload;
    const settings = pi.getSettings().compaction;
    const perModel = settings?.modelOverrides?.[`${ctx.model.provider}/${ctx.model.id}`];
    const reserve = perModel?.reserveTokens ?? settings?.reserveTokens ?? 16_384;
    const trigger = ctx.model.contextWindow - reserve;
    const raw = override?.threshold ?? pi.getFlag("server-compaction-threshold");
    const threshold = raw === undefined ? Math.floor(trigger * 0.6) : Number(raw);
    if (!Number.isSafeInteger(threshold) || threshold < 1000 || threshold >= trigger) return payload;
    attempt = { sessionId: ctx.sessionManager.getSessionId(), model: ctx.model.id, identity: credential,
      leafId: ctx.sessionManager.getLeafId(), invalid: false, completed: false,
      items: new Map(), itemBytes: 0, started: performance.now() };
    warmingModel = modelKey(ctx.model);
    return { ...payload, store: false, stream: true,
      context_management: [{ type: "compaction", compact_threshold: threshold }] };
  });

  pi.on("provider_stream_event", (event) => {
    if (!attempt || event.provider !== "openai" || event.api !== "openai-responses" ||
        event.model !== attempt.model || !record(event.data)) return;
    const data = event.data;
    if (attempt.invalid) return;
    if (data.type === "response.created") {
      if (!record(data.response) || typeof data.response.id !== "string" || attempt.responseId) {
        attempt.invalid = true;
      } else attempt.responseId = data.response.id;
    }
    if (["error", "response.failed", "response.incomplete"].includes(String(data.type))) attempt.invalid = true;
    if (data.type === "response.output_item.done") {
      const index = data.output_index;
      if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= MAX_ITEMS ||
          attempt.items.has(Number(index)) || !validOutput([data.item]) || attempt.completed) {
        attempt.invalid = true;
        return;
      }
      attempt.itemBytes += bytes(data.item);
      if (attempt.itemBytes > MAX_BYTES) {
        attempt.invalid = true;
        attempt.items.clear();
        return;
      }
      attempt.items.set(Number(index), structuredClone(data.item as Item));
    }
    if (data.type !== "response.completed") return;
    const response = data.response;
    if (!record(response) || response.status !== "completed" || typeof response.id !== "string" ||
        (attempt.responseId !== undefined && response.id !== attempt.responseId) || attempt.completed ||
        !Array.isArray(response.output)) {
      attempt.invalid = true;
      return;
    }
    // The live subscription route leaves response.completed.output empty. Done
    // items carry the authoritative encrypted content; never use item.added.
    const streamed = [...attempt.items].sort(([a], [b]) => a - b);
    const output = streamed.length > 0 ? streamed.map(([, item]) => item) : response.output;
    if (streamed.some(([index], position) => index !== position) || !validOutput(output) ||
        (streamed.length > 0 && response.output.length > 0 &&
          hash(sorted(response.output)) !== hash(sorted(output)))) {
      attempt.invalid = true;
      return;
    }
    attempt.completed = true;
    attempt.responseId = response.id;
    attempt.output = structuredClone(output);
    attempt.items.clear();
  });

  pi.on("turn_end", (event, ctx) => {
    const current = attempt;
    attempt = undefined;
    inTurn = false;
    if (!current) return;
    if (event.outcome !== "completed" || current.invalid || !current.completed || !current.output) {
      blocked = true; // No automatic paid retry without context_management.
      return;
    }
    if (ctx.sessionManager.getSessionId() !== current.sessionId || !supports(ctx.model) ||
        ctx.model.id !== current.model ||
        event.message.role !== "assistant" || !["stop", "toolUse"].includes(event.message.stopReason)) return;
    if (event.message.responseId && event.message.responseId !== current.responseId) return;
    const output = current.output;
    let last = -1;
    for (let i = 0; i < output.length; i++) if (output[i]!.type === "compaction") last = i;
    if (last < 0) return;
    // Pending context changes by another turn-end extension must win over our snapshot.
    if (event.entries.length > 0) return;
    const branch = ctx.sessionManager.getBranch();
    const anchor = branch.findIndex((entry) => entry.id === event.messageEntryId);
    const requestLeaf = branch.findIndex((entry) => entry.id === current.leafId);
    if (anchor < 0 || requestLeaf < 0 || requestLeaf >= anchor ||
        branch.slice(requestLeaf + 1, anchor).some((entry) => entry.type !== "custom")) return;
    const stored = branch[anchor];
    if (stored?.type !== "message" || hash(stored.message) !== hash(event.message)) return;
    const hashes = output.filter((item) => item.type !== "compaction").map(outputHash);
    if (hashes.some((value) => value === undefined)) return;
    // Prove Pi's persisted assistant still represents the observed provider
    // output before discarding any history. In particular, message_end redaction
    // must not later be undone by replaying an unredacted raw suffix.
    try {
      const system = getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages);
      const normalized = convertResponsesMessages(ctx.model,
        normalizeContext({ messages: [...(system ? [system] : []), event.message] }), new Set(["openai"]), {
          includeSystemPrompt: false,
          grammarToolInputProperties: createGrammarToolInputProperties(
            system?.toolsAdded ?? [], ctx.model.compat?.supportsOpenAIGrammarTools ?? false),
        });
      const actualHashes = normalized.map(outputHash).filter((value) => value !== undefined);
      if (hash(actualHashes) !== hash(hashes)) return;
    } catch { return; }
    const summary = fallbackSummary(branch.slice(0, anchor), ctx);
    const details: Checkpoint = {
      kind: KIND, model: current.model, identity: current.identity, summary,
      assistantEntryId: event.messageEntryId, assistantHash: hash(event.message),
      outputHashes: hashes as string[], replay: output.slice(last),
    };
    if (bytes(details) > MAX_BYTES) return;
    return { entries: [{
      type: "compaction", summary, firstKeptEntryId: event.messageEntryId, details,
      // Usage is already recorded on this ordinary assistant response. Never add it twice.
    }, { type: "custom", customType: `${KIND}:saved`, data: {
      version: 1, durationMs: Math.round(performance.now() - current.started),
      checkpointBytes: bytes(details.replay), outputItems: details.replay.length,
    } }] };
  });
}
