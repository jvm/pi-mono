import type { BranchEntry, GoalMutation, GoalState } from "./types.js";
import { GOAL_ENTRY_TYPE, GOAL_SCHEMA_VERSION } from "./types.js";
import { withPiGoalVersion } from "./metadata.js";
import { nowIso } from "./utils.js";
import { isKnownMutation } from "./state.js";

export interface UsageAccountingResult {
  mutation?: GoalMutation;
  goal: GoalState;
  addedTokens: number;
  addedEntryIds: string[];
}

export function assistantUsageTokens(message: any): number {
  if (!message || message.role !== "assistant") return 0;
  return usageTokens(message.usage);
}

function usageTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  if (Number.isFinite(usage.totalTokens)) return Math.max(0, Math.floor(usage.totalTokens));
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .filter((n) => Number.isFinite(n))
    .reduce((sum, n) => sum + Math.max(0, Math.floor(n)), 0);
}

function entryUsage(entry: BranchEntry): any {
  if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
    // Pi already aggregates every nesting level onto the transcript tool result.
    return entry.message.usage;
  }
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
}

export function accountUsageFromBranch(goal: GoalState, branchEntries: BranchEntry[], endMs = Date.now()): UsageAccountingResult {
  const accounted = new Set(goal.accountedUsage.entryIds);
  const createdMs = Date.parse(goal.createdAt);
  // Entry order disambiguates work finalized in the same millisecond as creation.
  // Timestamp-only fallback supports existing callers with an unpersisted goal.
  const startIndex = branchEntries.findIndex((entry) => entry?.type === "custom" && entry.customType === GOAL_ENTRY_TYPE
    && isKnownMutation(entry.data) && entry.data.goalId === goal.goalId && (entry.data.kind === "create" || entry.data.kind === "replace"));
  let addedTokens = 0;
  let scannedAssistantEntries = 0;
  let scannedUsageEntries = 0;
  let cacheTokensIncluded = false;
  const addedEntryIds: string[] = [];
  for (const entry of branchEntries.slice(startIndex + 1)) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    // A retained goal ends at replacement/clear, not pause or terminal status.
    if (entry.type === "custom" && entry.customType === GOAL_ENTRY_TYPE
      && isKnownMutation(entry.data)
      && (entry.data.kind === "create" || entry.data.kind === "replace" || entry.data.kind === "clear")) break;
    if (accounted.has(entry.id)) continue;
    const entryMs = Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(createdMs) || !Number.isFinite(entryMs) || entryMs < createdMs || entryMs > endMs) continue;
    const usage = entryUsage(entry);
    if (!usage) continue;
    scannedUsageEntries++;
    if (entry.message?.role === "assistant") scannedAssistantEntries++;
    if (usage && (Number.isFinite(usage.cacheRead) || Number.isFinite(usage.cacheWrite))) cacheTokensIncluded = true;
    const tokens = usageTokens(usage);
    if (tokens <= 0) continue;
    addedTokens += tokens;
    accounted.add(entry.id);
    addedEntryIds.push(entry.id);
  }
  if (addedTokens === 0) return { goal, addedTokens: 0, addedEntryIds };
  const mutation: GoalMutation = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    kind: "account",
    goalId: goal.goalId,
    tokens: addedTokens,
    entryIds: addedEntryIds,
    at: nowIso(),
    meta: withPiGoalVersion({
      source: "accounting",
      accounting: { scannedAssistantEntries, scannedUsageEntries, addedEntryCount: addedEntryIds.length, cacheTokensIncluded },
    }),
  };
  return {
    mutation,
    addedTokens,
    addedEntryIds,
    goal: {
      ...goal,
      tokensUsed: goal.tokensUsed + addedTokens,
      accountedUsage: {
        tokens: goal.tokensUsed + addedTokens,
        entryIds: [...goal.accountedUsage.entryIds, ...addedEntryIds],
      },
      updatedAt: mutation.at,
    },
  };
}

export function isBudgetExceeded(goal: GoalState): boolean {
  return goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget;
}
