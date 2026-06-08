import type { BranchEntry, GoalMutation, GoalState } from "./types.js";
import { GOAL_SCHEMA_VERSION } from "./types.js";
import { nowIso } from "./utils.js";

export interface UsageAccountingResult {
  mutation?: GoalMutation;
  goal: GoalState;
  addedTokens: number;
  addedEntryIds: string[];
}

export function assistantUsageTokens(message: any): number {
  if (!message || message.role !== "assistant") return 0;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return 0;
  if (Number.isFinite(usage.totalTokens)) return Math.max(0, Math.floor(usage.totalTokens));
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .filter((n) => Number.isFinite(n))
    .reduce((sum, n) => sum + Math.max(0, Math.floor(n)), 0);
}

export function accountUsageFromBranch(goal: GoalState, branchEntries: BranchEntry[], endMs = Date.now()): UsageAccountingResult {
  const accounted = new Set(goal.accountedUsage.entryIds);
  const createdMs = Date.parse(goal.createdAt);
  let addedTokens = 0;
  const addedEntryIds: string[] = [];
  for (const entry of branchEntries) {
    if (entry?.type !== "message" || !entry.id || accounted.has(entry.id)) continue;
    const entryMs = Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(createdMs) && Number.isFinite(entryMs) && entryMs < createdMs) continue;
    const tokens = assistantUsageTokens(entry.message);
    if (tokens <= 0) continue;
    addedTokens += tokens;
    addedEntryIds.push(entry.id);
  }
  if (addedTokens === 0) return { goal, addedTokens: 0, addedEntryIds };
  void endMs;
  const mutation: GoalMutation = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    kind: "account",
    goalId: goal.goalId,
    tokens: addedTokens,
    entryIds: addedEntryIds,
    at: nowIso(),
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
