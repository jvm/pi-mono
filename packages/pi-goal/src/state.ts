import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BranchEntry, GoalMutation, GoalMutationMeta, GoalState, GoalStatus } from "./types.js";
import { GOAL_ENTRY_TYPE, GOAL_SCHEMA_VERSION } from "./types.js";
import { withPiGoalVersion } from "./metadata.js";
import { goalStatusLabel, newGoalId, nowIso, realizedTimeUsed, secondsBetween } from "./utils.js";

export function appendGoalMutation(pi: ExtensionAPI, mutation: GoalMutation): void {
  pi.appendEntry(GOAL_ENTRY_TYPE, mutation);
}

export function createGoalMutation(objective: string, tokenBudget?: number, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "create", goalId: newGoalId(), objective, tokenBudget, at: nowIso(), meta: withPiGoalVersion(meta) };
}

export function replaceGoalMutation(objective: string, tokenBudget?: number, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "replace", goalId: newGoalId(), objective, tokenBudget, at: nowIso(), meta: withPiGoalVersion(meta) };
}

// Clock skew between a status entry's saved time and its timestamp.
const LEGACY_TIME_TOLERANCE_SECONDS = 2;

export function reconstructGoalState(branchEntries: BranchEntry[], diagnostics: string[] = []): GoalState | null {
  let goal: GoalState | null = null;
  // Up to 0.3.1, an edit of an active goal restarted its active segment, so
  // the time since that segment's start was lost, also from every status entry
  // saved afterwards. Track that loss and add it back to status entries that
  // are short by exactly that amount; an entry from fixed code clears it.
  let legacySegmentStart: string | undefined;
  let legacyLostSeconds = 0;
  for (const entry of branchEntries) {
    if (entry?.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const mutation = entry.data as Partial<GoalMutation> | undefined;
    if (!isKnownMutation(mutation)) {
      diagnostics.push(`Ignoring malformed pi-goal entry ${entry.id ?? "<unknown>"}.`);
      continue;
    }
    let applied: GoalMutation = mutation;
    if (mutation.kind === "create" || mutation.kind === "replace" || mutation.kind === "clear") {
      legacySegmentStart = undefined;
      legacyLostSeconds = 0;
    } else if (goal && mutation.goalId === goal.goalId) {
      if (mutation.kind === "edit" && goal.status === "active" && goal.activeStartedAt && (mutation.status ?? goal.status) === "active") {
        legacyLostSeconds += secondsBetween(legacySegmentStart ?? goal.activeStartedAt, Date.parse(mutation.at));
        legacySegmentStart = mutation.at;
      } else if (mutation.kind === "status") {
        legacySegmentStart = undefined;
        if (mutation.timeUsedSeconds != null && legacyLostSeconds > LEGACY_TIME_TOLERANCE_SECONDS) {
          const expected = realizedTimeUsed(goal, Date.parse(mutation.at));
          if (mutation.timeUsedSeconds + legacyLostSeconds <= expected + LEGACY_TIME_TOLERANCE_SECONDS) {
            applied = { ...mutation, timeUsedSeconds: mutation.timeUsedSeconds + legacyLostSeconds };
          } else {
            legacyLostSeconds = 0;
          }
        }
      }
    }
    goal = applyGoalMutation(goal, applied, diagnostics);
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
    case "edit": {
      const status = mutation.status ?? current.status;
      const wasActive = current.status === "active";
      // An edit never resets elapsed time. Keep a running active segment; open
      // one only when the edit reactivates the goal; close it if the edit stops it.
      if (status === "active") {
        const activeStartedAt = wasActive && current.activeStartedAt ? current.activeStartedAt : mutation.at;
        return { ...current, objective: mutation.objective, status, updatedAt: mutation.at, activeStartedAt };
      }
      const timeUsedSeconds = wasActive ? current.timeUsedSeconds + secondsBetween(current.activeStartedAt, Date.parse(mutation.at)) : current.timeUsedSeconds;
      return { ...current, objective: mutation.objective, status, timeUsedSeconds, updatedAt: mutation.at, activeStartedAt: undefined };
    }
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

export function isKnownMutation(value: Partial<GoalMutation> | undefined): value is GoalMutation {
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

/** Status changes that a user command or model tool may request. */
export type RequestedGoalTransition = "paused" | "active" | "complete" | "blocked";

/**
 * Shared transition table for `/goal pause|resume` and `update_goal`. System
 * transitions (budget, provider limits, shutdown) are not requested here.
 *
 * | target            | allowed sources                                                 |
 * |-------------------|-----------------------------------------------------------------|
 * | paused            | active                                                          |
 * | active (resume)   | active, paused, blocked, usage_limited, budget_limited if under budget |
 * | complete, blocked | active, paused, usage_limited, budget_limited                   |
 *
 * Returns a user/model-readable reason when the transition is invalid.
 */
export function goalTransitionRejection(goal: GoalState, target: RequestedGoalTransition): string | undefined {
  const status = goal.status;
  const label = goalStatusLabel(status);
  if (target === "paused") {
    if (status === "active") return undefined;
    if (status === "paused") return "Goal is already paused. Use /goal resume to continue.";
    if (status === "complete") return "Goal is complete and cannot be paused. Use /goal edit to reactivate it or /goal <objective> to start a new goal.";
    return `Goal is ${label} and is not running, so it cannot be paused. Use /goal status for details.`;
  }
  if (target === "active") {
    if (status === "complete") return "Goal is complete. Use /goal edit to change the objective and reactivate it, or /goal <objective> to start a new goal.";
    if (status === "budget_limited" && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
      return `Goal token budget is exhausted (${goal.tokensUsed}/${goal.tokenBudget} tokens). Raise it with /goal budget <tokens> or remove it with /goal budget clear.`;
    }
    return undefined;
  }
  // A stopped goal (paused or limited) can still be finalized; a finalized one cannot change.
  if (status !== "complete" && status !== "blocked") return undefined;
  return `Goal is already ${status}; update_goal cannot change a finalized goal to ${target}. The goal state is unchanged. Do not call update_goal again; stop goal work and report the current state to the user.`;
}

export function statusMutation(goal: GoalState, status: GoalStatus, timeUsedSeconds: number, activeStartedAt?: string, meta?: GoalMutationMeta): GoalMutation {
  return { schemaVersion: GOAL_SCHEMA_VERSION, kind: "status", goalId: goal.goalId, status, timeUsedSeconds, activeStartedAt, at: nowIso(), meta: withPiGoalVersion(meta) };
}
