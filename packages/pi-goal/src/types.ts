export const GOAL_ENTRY_TYPE = "pi-goal";
export const GOAL_CONTEXT_TYPE = "pi-goal-context";
export const GOAL_SUMMARY_TYPE = "pi-goal-summary";
export const GOAL_EVENT_TYPE = "pi-goal-event";
export const GOAL_SCHEMA_VERSION = 1;
export const MAX_OBJECTIVE_CHARS = 4000;

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export interface AccountedUsage {
  tokens: number;
  entryIds: string[];
}

export interface BlockedAuditState {
  lastReason?: string;
  consecutiveCount: number;
}

export interface GoalState {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
  activeStartedAt?: string;
  accountedUsage: AccountedUsage;
  blockedAudit?: BlockedAuditState;
}

export interface GoalMutationMeta {
  piGoalVersion?: string;
  source?: string;
  trigger?: {
    messageId?: string;
    toolCallId?: string;
    siblingToolCalls?: Array<{ id?: string; name?: string }>;
    continuationReason?: string;
  };
  time?: {
    activeStartedAt?: string;
    endedAt?: string;
    elapsedDeltaSeconds?: number;
    realizedTimeUsedSeconds?: number;
  };
  accounting?: {
    scannedAssistantEntries?: number;
    addedEntryCount?: number;
    cacheTokensIncluded?: boolean;
  };
  providerLimit?: {
    kind?: string;
    reason?: string;
    resetHint?: string;
    retryAfterSeconds?: number;
  };
  verification?: {
    summary?: string;
    checkedRequirements?: string[];
    commands?: string[];
    worktreeStatus?: "clean" | "dirty" | "unknown";
  };
}

interface MutationBase {
  schemaVersion: 1;
  kind: string;
  at: string;
  goalId?: string;
  meta?: GoalMutationMeta;
}

export type GoalMutation =
  | (MutationBase & { kind: "create" | "replace"; goalId: string; objective: string; tokenBudget?: number })
  | (MutationBase & { kind: "edit"; goalId: string; objective: string; status?: GoalStatus })
  | (MutationBase & { kind: "status"; goalId: string; status: GoalStatus; timeUsedSeconds?: number; activeStartedAt?: string })
  | (MutationBase & { kind: "budget"; goalId: string; tokenBudget?: number })
  | (MutationBase & { kind: "account"; goalId: string; tokens: number; entryIds: string[]; timeUsedSeconds?: number })
  | (MutationBase & { kind: "clear"; goalId?: string; timeUsedSeconds?: number });

export interface GoalSummary {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  remainingTokens?: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
  activeStartedAt?: string;
}

export type GoalContextReason = "continue" | "created" | "resumed" | "objective_updated" | "budget_limited";

export interface ParsedGoalCommand {
  action: "status" | "edit" | "pause" | "resume" | "clear" | "setBudget" | "clearBudget" | "createOrReplace";
  objective?: string;
  tokenBudget?: number;
}

export type BranchEntry = Record<string, any>;
