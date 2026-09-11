import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { boundedStringify } from "./bounded-json.js";

export const STATE_TYPE = "pi-openai-reasoning:v1";
const MAX_ITEMS = 20_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_UPDATES = 128;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type RecordValue = Record<string, unknown>;
interface Boundary { offset: number; hash: string }
interface Update extends Boundary { effort: Effort }
export interface ReasoningState {
  version: 1;
  model: string;
  window: string;
  baseline: Effort;
  updates: Update[];
  last: Boundary;
}

export function supportsReasoningUpdates(model: Model<any> | undefined): boolean {
  if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses" ||
    model.id !== "gpt-6-astra" || !model.reasoning) return false;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
      ["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(url.pathname.replace(/\/+$/, ""));
  } catch { return false; }
}

export function rewriteReasoning(
  payload: unknown,
  model: Model<any>,
  entries: readonly SessionEntry[],
  compacting = false,
): { payload: RecordValue; state?: ReasoningState } | undefined {
  if (!supportsReasoningUpdates(model) || !isRecord(payload) || payload.model !== model.id ||
    !Array.isArray(payload.input) || !isRecord(payload.reasoning) || !isEffort(payload.reasoning.effort)) return;
  if ((payload.reasoning.mode !== undefined && payload.reasoning.mode !== "standard") ||
    payload.multi_agent !== undefined || payload.context_management !== undefined ||
    payload.previous_response_id !== undefined || payload.conversation !== undefined ||
    payload.background === true || (payload.truncation !== undefined && payload.truncation !== "disabled")) return;
  const rawInput = payload.input;
  if (rawInput.some((item) => isRecord(item) &&
    (item.type === "configuration_update" || item.type === "agent_message"))) return;
  const trigger = rawInput.at(-1);
  if (compacting && (!isRecord(trigger) || trigger.type !== "compaction_trigger")) return;
  if (!compacting && rawInput.some((item) => isRecord(item) && item.type === "compaction_trigger")) return;
  const input = compacting ? rawInput.slice(0, -1) : rawInput;
  const window = [...entries].reverse().find((entry) => entry.type === "compaction")?.id ?? "root";
  const hashes = fingerprintPrefixes(input, window !== "root");
  if (!hashes || input.length === 0) return;
  const selected = payload.reasoning.effort;
  const previous = findState(entries, model.id, window);
  const last = { offset: input.length, hash: hashes[input.length] };
  const valid = previous && (compacting || hashes[previous.last.offset] === previous.last.hash) &&
    previous.updates.every((update) =>
      compacting && update.offset > input.length || hashes[update.offset] === update.hash);
  const baseline = valid ? previous.baseline : selected;
  let updates = valid ? previous.updates.filter((update) => update.offset <= input.length).map((u) => ({ ...u })) : [];
  const retry = valid && previous.last.offset === last.offset && previous.last.hash === last.hash;

  if (!valid && window !== "root" && isCheckpoint(input[0])) {
    // An opaque checkpoint does not retain configuration-update semantics.
    updates.push({ offset: 1, hash: hashes[1], effort: selected });
  }
  const effective = updates.at(-1)?.effort ?? baseline;
  if (effective !== selected && (compacting || !retry)) {
    let offset = input.length;
    if (!compacting && previous && hashes[previous.last.offset] === previous.last.hash) {
      // Put the update before the next user input, not before an older assistant.
      const nextUser = input.findIndex((item, index) =>
        index >= previous.last.offset && isRecord(item) && item.role === "user");
      if (nextUser >= 0) offset = nextUser;
    }
    const tail = updates.at(-1);
    if (!compacting && tail?.offset === offset && input.length > offset) offset = input.length;
    if (tail?.offset === offset) {
      // Only temporary compaction requests can replace a tail already sent.
      // A normal retry keeps its original selection until history advances.
      if (compacting) tail.effort = selected;
    } else {
      updates.push({ offset, hash: hashes[offset], effort: selected });
    }
  }
  if (updates.length > MAX_UPDATES) {
    // Stop pinning at the bound. Normal Pi effort remains correct, but this
    // context window no longer gets cache-preserving effort updates.
    return;
  }
  const output: unknown[] = [];
  let updateIndex = 0;
  for (let offset = 0; offset <= input.length; offset++) {
    const update = updates[updateIndex];
    if (update?.offset === offset) {
      output.push({ type: "configuration_update", reasoning: { effort: update.effort } });
      updateIndex++;
    }
    if (offset < input.length) output.push(input[offset]);
  }
  if (compacting) output.push(trigger);
  const state: ReasoningState = { version: 1, model: model.id, window, baseline, updates, last };
  return {
    payload: { ...payload, reasoning: { ...payload.reasoning, effort: baseline }, input: output },
    ...(!compacting && JSON.stringify(state) !== JSON.stringify(previous) ? { state } : {}),
  };
}

function findState(entries: readonly SessionEntry[], model: string, window: string): ReasoningState | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    if (isState(entry.data) && entry.data.model === model && entry.data.window === window) return entry.data;
  }
  return;
}

function isState(value: unknown): value is ReasoningState {
  if (!isRecord(value) || value.version !== 1 || typeof value.model !== "string" || value.model.length > 256 ||
    Object.keys(value).some((key) => !["version", "model", "window", "baseline", "updates", "last"].includes(key)) ||
    typeof value.window !== "string" || value.window.length > 256 || !isEffort(value.baseline) ||
    !isBoundary(value.last) || !Array.isArray(value.updates) || value.updates.length > MAX_UPDATES) return false;
  let previousOffset = -1;
  for (const update of value.updates) {
    if (!isBoundary(update, true) || !isRecord(update) || !isEffort(update.effort) ||
      update.offset <= previousOffset || update.offset > value.last.offset) return false;
    previousOffset = update.offset;
  }
  return true;
}

function isBoundary(value: unknown, update = false): value is Boundary {
  return isRecord(value) && Object.keys(value).every((key) =>
    key === "offset" || key === "hash" || update && key === "effort") &&
    Number.isInteger(value.offset) && (value.offset as number) >= 0 &&
    (value.offset as number) <= MAX_ITEMS && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash);
}

function fingerprintPrefixes(input: unknown[], hasCheckpoint: boolean): string[] | undefined {
  if (input.length > MAX_ITEMS) return;
  const hash = createHash("sha256");
  const prefixes = [hash.copy().digest("hex")];
  let bytes = 0;
  try {
    for (const [index, item] of input.entries()) {
      // Compaction's normal hook may run before or after this extension.
      const text = boundedStringify(
        hasCheckpoint && index === 0 && isCheckpoint(item) ? { type: "checkpoint" } : item,
        MAX_BYTES - bytes,
      );
      if (text === undefined) return;
      bytes += Buffer.byteLength(text);
      hash.update(text).update("\n");
      prefixes.push(hash.copy().digest("hex"));
    }
  } catch { return; }
  return prefixes;
}

function isCheckpoint(item: unknown): boolean {
  return isRecord(item) && (item.type === "compaction" || item.role === "user" && Array.isArray(item.content) &&
    item.content.some((part) => isRecord(part) && typeof part.text === "string" &&
      part.text.startsWith("The conversation history before this point was compacted into the following summary:")));
}
function isEffort(value: unknown): value is Effort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
