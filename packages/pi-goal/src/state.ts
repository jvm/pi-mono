import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchEntry, GoalMutation, GoalMutationMeta, GoalState, GoalStatus } from "./types.js";
import { GOAL_ENTRY_TYPE, GOAL_SCHEMA_VERSION } from "./types.js";
import { withPiGoalVersion } from "./metadata.js";
import { newGoalId, nowIso } from "./utils.js";

export function appendGoalMutation(pi: ExtensionAPI, mutation: GoalMutation): void {
  pi.appendEntry(GOAL_ENTRY_TYPE, mutation);
}

export function createGoalMutation(objective: string, tokenBudget?: number, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "create", goalId: newGoalId(), objective, tokenBudget, at: nowIso(), meta: withPiGoalVersion(meta) };
}

export function replaceGoalMutation(objective: string, tokenBudget?: number, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "replace", goalId: newGoalId(), objective, tokenBudget, at: nowIso(), meta: withPiGoalVersion(meta) };
}

export function reconstructGoalState(branchEntries: BranchEntry[], diagnostics: string[] = []): GoalState | null {
  let goal: GoalState | null = null;
  for (const entry of branchEntries) {
    if (entry?.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const mutation = entry.data as Partial<GoalMutation> | undefined;
    if (!isKnownMutation(mutation)) {
      diagnostics.push(`Ignoring malformed pi-goal entry ${entry.id ?? "<unknown>"}.`);
      continue;
    }
    goal = applyGoalMutation(goal, mutation, diagnostics);
  }
  return goal;
}

export function applyGoalMutation(current: GoalState | null, mutation: GoalMutation, diagnostics: string[] = []): GoalState | null {
  if (mutation.kind === "clear") return null;
  if (mutation.kind === "create" || mutation.kind === "replace") {
    return {
      goalId: mutation.goalId,
      objective: mutation.objective,
      status: "active",
      tokenBudget: mutation.tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: mutation.at,
      updatedAt: mutation.at,
      activeStartedAt: mutation.at,
      accountedUsage: { tokens: 0, entryIds: [] },
    };
  }
  if (!current) {
    diagnostics.push(`Ignoring ${mutation.kind} mutation without current goal.`);
    return current;
  }
  if (mutation.goalId !== current.goalId) {
    diagnostics.push(`Ignoring ${mutation.kind} mutation for stale goal ${mutation.goalId}.`);
    return current;
  }
  switch (mutation.kind) {
    case "edit":
      return { ...current, objective: mutation.objective, status: mutation.status ?? current.status, updatedAt: mutation.at, activeStartedAt: mutation.status === "active" ? mutation.at : current.activeStartedAt };
    case "status":
      return { ...current, status: mutation.status, timeUsedSeconds: mutation.timeUsedSeconds ?? current.timeUsedSeconds, activeStartedAt: mutation.activeStartedAt, updatedAt: mutation.at };
    case "budget":
      return { ...current, tokenBudget: mutation.tokenBudget, updatedAt: mutation.at };
    case "account": {
      const ids = [...new Set([...current.accountedUsage.entryIds, ...mutation.entryIds])];
      const tokens = current.tokensUsed + mutation.tokens;
      return { ...current, tokensUsed: tokens, accountedUsage: { tokens, entryIds: ids }, updatedAt: mutation.at };
    }
  }
}

function isKnownMutation(value: Partial<GoalMutation> | undefined): value is GoalMutation {
  if (!value || value.schemaVersion !== GOAL_SCHEMA_VERSION || typeof value.kind !== "string" || !validTimestamp(value.at)) return false;
  const mutation = value as Record<string, unknown>;
  if (value.kind === "clear") return optionalNonNegativeInteger(mutation.timeUsedSeconds);
  if (typeof mutation.goalId !== "string" || mutation.goalId.length === 0) return false;
  switch (value.kind) {
    case "create":
    case "replace":
      return typeof mutation.objective === "string" && optionalPositiveInteger(mutation.tokenBudget);
    case "edit":
      return typeof mutation.objective === "string" && (mutation.status === undefined || isGoalStatus(mutation.status));
    case "status":
      return isGoalStatus(mutation.status)
        && optionalNonNegativeInteger(mutation.timeUsedSeconds)
        && (mutation.activeStartedAt === undefined || validTimestamp(mutation.activeStartedAt));
    case "budget":
      return optionalPositiveInteger(mutation.tokenBudget);
    case "account":
      return nonNegativeInteger(mutation.tokens)
        && Array.isArray(mutation.entryIds)
        && mutation.entryIds.every((id) => typeof id === "string");
    default:
      return false;
  }
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value);
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0);
}

export function statusMutation(goal: GoalState, status: GoalStatus, timeUsedSeconds: number, activeStartedAt?: string, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "status", goalId: goal.goalId, status, timeUsedSeconds, activeStartedAt, at: nowIso(), meta: withPiGoalVersion(meta) };
}
