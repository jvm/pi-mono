import { createRequire } from "node:module";
import type { BranchEntry, GoalMutationMeta, GoalState } from "./types.js";
import { secondsBetween } from "./utils.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("pi-goal package version is missing or invalid.");
}

/** Package version that produced the persisted metadata; schema versioning is separate. */
export const PI_GOAL_VERSION = packageJson.version;

export function withPiGoalVersion(meta: GoalMutationMeta = {}): GoalMutationMeta {
  return { piGoalVersion: PI_GOAL_VERSION, ...meta };
}

export function transitionMeta(source: string, goal: GoalState, nextTimeUsedSeconds: number, endedAt: string, extra: GoalMutationMeta = {}): GoalMutationMeta {
  return withPiGoalVersion({
    source,
    ...extra,
    time: {
      activeStartedAt: goal.activeStartedAt,
      endedAt,
      elapsedDeltaSeconds: Math.max(0, nextTimeUsedSeconds - goal.timeUsedSeconds),
      realizedTimeUsedSeconds: nextTimeUsedSeconds,
      ...extra.time,
    },
  });
}

export interface ToolCallContext {
  messageId?: string;
  toolCallId: string;
  siblingToolCalls: Array<{ id?: string; name?: string }>;
}

export function findToolCallContext(branchEntries: BranchEntry[], toolCallId: string): ToolCallContext | undefined {
  for (const entry of branchEntries) {
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const toolCalls = content.filter((part: any) => part?.type === "toolCall");
    if (!toolCalls.some((part: any) => part.id === toolCallId)) continue;
    return {
      messageId: entry.id,
      toolCallId,
      siblingToolCalls: toolCalls.map((part: any) => ({ id: part.id, name: part.name })),
    };
  }
  return undefined;
}

export function elapsedSecondsSince(startIso: string | undefined, endIso: string): number {
  return secondsBetween(startIso, Date.parse(endIso));
}
