import { randomUUID } from "node:crypto";
import type { GoalState, GoalStatus, GoalSummary } from "./types.js";

export const nowIso = () => new Date().toISOString();
export const newGoalId = () => randomUUID();

export function secondsBetween(startIso: string | undefined, endMs = Date.now()): number {
  if (!startIso) return 0;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((endMs - start) / 1000));
}

export function realizedTimeUsed(goal: GoalState, endMs = Date.now()): number {
  return goal.timeUsedSeconds + (goal.status === "active" ? secondsBetween(goal.activeStartedAt, endMs) : 0);
}

export function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}m`;
}

function trim1(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function goalStatusLabel(status: GoalStatus): string {
  return status.replace("_", " ");
}

export function goalToSummary(goal: GoalState, endMs = Date.now()): GoalSummary {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    remainingTokens: goal.tokenBudget == null ? undefined : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    timeUsedSeconds: realizedTimeUsed(goal, endMs),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    activeStartedAt: goal.activeStartedAt,
  };
}

export function goalUsageSummary(goal: GoalState | GoalSummary): string {
  const tokens = `tokens ${formatTokensCompact(goal.tokensUsed)}${goal.tokenBudget ? `/${formatTokensCompact(goal.tokenBudget)}` : ""}`;
  const time = `time ${formatElapsed(goal.timeUsedSeconds)}`;
  return `${tokens}, ${time}`;
}

export function truncateOneLine(text: string, max = 96): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`;
}

export function terminalStatus(status: GoalStatus): boolean {
  return status === "blocked" || status === "usage_limited" || status === "budget_limited" || status === "complete" || status === "paused";
}
