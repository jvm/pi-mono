import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalMutation, GoalState, ParsedGoalCommand } from "./types.js";
import { GOAL_EVENT_TYPE, GOAL_SCHEMA_VERSION, GOAL_SUMMARY_TYPE } from "./types.js";
import { accountUsageFromBranch } from "./accounting.js";
import { appendGoalMutation, applyGoalMutation, createGoalMutation, replaceGoalMutation, statusMutation } from "./state.js";
import { PI_GOAL_VERSION, transitionMeta, withPiGoalVersion } from "./metadata.js";
import { formatElapsed, goalToSummary, goalUsageSummary, nowIso, realizedTimeUsed } from "./utils.js";
import { validateObjective, validateTokenBudget } from "./validation.js";

export interface CommandRuntime {
  getGoal(): GoalState | null;
  setGoal(goal: GoalState | null): void;
  afterGoalChanged(ctx: ExtensionCommandContext, event?: string): void;
  scheduleContinuation(ctx: ExtensionCommandContext, reason: string): void;
}

export function parseGoalCommand(args: string): ParsedGoalCommand {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "status") return { action: "status" };
  if (["edit", "pause", "resume", "clear"].includes(trimmed)) return { action: trimmed as ParsedGoalCommand["action"] };
  if (trimmed === "budget clear") return { action: "clearBudget" };
  const budget = trimmed.match(/^budget\s+(\S+)$/);
  if (budget) return { action: "setBudget", tokenBudget: Number(budget[1]) };
  const withBudget = trimmed.match(/^--budget\s+(\S+)\s+([\s\S]+)$/);
  if (withBudget) return { action: "createOrReplace", tokenBudget: Number(withBudget[1]), objective: withBudget[2] };
  return { action: "createOrReplace", objective: trimmed };
}

export async function handleGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  const parsed = parseGoalCommand(args);
  if (parsed.action === "status") return showStatus(pi, ctx, runtime.getGoal());
  if (parsed.action === "createOrReplace") return createOrReplace(pi, ctx, runtime, parsed.objective, parsed.tokenBudget);
  if (parsed.action === "edit") return editGoal(pi, ctx, runtime);
  if (parsed.action === "pause") return setGoalStatus(pi, ctx, runtime, "paused");
  if (parsed.action === "resume") return setGoalStatus(pi, ctx, runtime, "active");
  if (parsed.action === "clear") return clearGoal(pi, ctx, runtime);
  if (parsed.action === "setBudget") return setBudget(pi, ctx, runtime, parsed.tokenBudget);
  if (parsed.action === "clearBudget") return setBudget(pi, ctx, runtime, undefined);
}

export function goalCompletions(prefix: string) {
  const items = ["status", "edit", "pause", "resume", "clear", "budget ", "budget clear", "--budget "];
  const filtered = items.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
  return filtered.length ? filtered : null;
}

function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: GoalState | null): void {
  if (!goal) {
    const text = "No goal set. Usage: /goal <objective> or /goal --budget 50000 <objective>.";
    ctx.ui.notify(text, "info");
    pi.sendMessage({ customType: GOAL_SUMMARY_TYPE, content: text, display: true, details: { goal: null, piGoalVersion: PI_GOAL_VERSION } });
    return;
  }
  const summary = goalToSummary(goal);
  const budget = summary.tokenBudget ? `\nBudget: ${summary.tokensUsed}/${summary.tokenBudget} tokens (${summary.remainingTokens} remaining)` : "";
  const text = `Goal ${summary.status}\nObjective: ${summary.objective}\nUsage: ${goalUsageSummary(summary)}${budget}\nCommands: /goal pause, /goal resume, /goal edit, /goal budget <n>, /goal clear`;
  pi.sendMessage({ customType: GOAL_SUMMARY_TYPE, content: text, display: true, details: { goal: summary, piGoalVersion: PI_GOAL_VERSION } });
}

async function createOrReplace(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime, rawObjective: unknown, rawBudget: unknown): Promise<void> {
  const objective = validateObjective(rawObjective);
  if (!objective.ok) return ctx.ui.notify(objective.error, "error");
  const budget = validateTokenBudget(rawBudget, { allowEmpty: true });
  if (!budget.ok) return ctx.ui.notify(budget.error, "error");
  const existing = runtime.getGoal();
  if (existing && existing.status !== "complete") {
    if (!ctx.hasUI) return ctx.ui.notify("Replacing the current goal requires confirmation in interactive/RPC mode.", "error");
    const ok = await ctx.ui.confirm("Replace current goal?", `Current goal (${existing.status}): ${existing.objective}`);
    if (!ok) return;
  }
  const mutation = existing ? replaceGoalMutation(objective.value, budget.value, { source: "command:/goal" }) : createGoalMutation(objective.value, budget.value, { source: "command:/goal" });
  appendGoalMutation(pi, mutation);
  runtime.setGoal(applyGoalMutation(existing, mutation));
  runtime.afterGoalChanged(ctx, existing ? "Goal replaced." : "Goal created.");
  runtime.scheduleContinuation(ctx, "created");
}

async function editGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  const current = runtime.getGoal();
  if (!current) return ctx.ui.notify("No goal to edit.", "error");
  if (!ctx.hasUI) return ctx.ui.notify("/goal edit requires interactive/RPC UI.", "error");
  const next = await ctx.ui.editor("Edit goal objective", current.objective);
  if (next == null) return;
  const objective = validateObjective(next);
  if (!objective.ok) return ctx.ui.notify(objective.error, "error");
  const reactivate = current.status === "complete" || current.status === "budget_limited";
  const mutation: GoalMutation = { schemaVersion: GOAL_SCHEMA_VERSION, kind: "edit", goalId: current.goalId, objective: objective.value, status: reactivate ? "active" : current.status, at: nowIso(), meta: withPiGoalVersion({ source: "command:/goal edit" }) };
  appendGoalMutation(pi, mutation);
  runtime.setGoal(applyGoalMutation(current, mutation));
  runtime.afterGoalChanged(ctx, "Goal updated.");
  if (reactivate) runtime.scheduleContinuation(ctx, "objective_updated");
}

function setGoalStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime, status: "paused" | "active"): void {
  const current = accountCurrent(pi, ctx, runtime.getGoal());
  if (!current) return ctx.ui.notify("No goal set.", "error");
  const time = status === "active" ? current.timeUsedSeconds : realizedTimeUsed(current);
  const activeStartedAt = status === "active" ? nowIso() : undefined;
  const mutation = statusMutation(current, status, time, activeStartedAt, transitionMeta(status === "active" ? "command:/goal resume" : "command:/goal pause", current, time, nowIso()));
  appendGoalMutation(pi, mutation);
  runtime.setGoal(applyGoalMutation(current, mutation));
  runtime.afterGoalChanged(ctx, status === "active" ? "Goal resumed." : "Goal paused.");
  if (status === "active") runtime.scheduleContinuation(ctx, "resumed");
}

function clearGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime): void {
  const current = accountCurrent(pi, ctx, runtime.getGoal());
  if (!current) return ctx.ui.notify("No goal set.", "error");
  const time = realizedTimeUsed(current);
  appendGoalMutation(pi, { schemaVersion: GOAL_SCHEMA_VERSION, kind: "clear", goalId: current.goalId, timeUsedSeconds: time, at: nowIso(), meta: transitionMeta("command:/goal clear", current, time, nowIso()) });
  runtime.setGoal(null);
  runtime.afterGoalChanged(ctx, "Goal cleared.");
}

function setBudget(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime, rawBudget: unknown): void {
  const current = runtime.getGoal();
  if (!current) return ctx.ui.notify("No goal set.", "error");
  const budget = validateTokenBudget(rawBudget, { allowEmpty: rawBudget === undefined });
  if (!budget.ok) return ctx.ui.notify(budget.error, "error");
  const mutation: GoalMutation = { schemaVersion: GOAL_SCHEMA_VERSION, kind: "budget", goalId: current.goalId, tokenBudget: budget.value, at: nowIso(), meta: withPiGoalVersion({ source: "command:/goal budget" }) };
  appendGoalMutation(pi, mutation);
  let next = applyGoalMutation(current, mutation)!;
  if (next.tokenBudget != null && next.tokensUsed >= next.tokenBudget && next.status === "active") {
    const time = realizedTimeUsed(next);
    const limited = statusMutation(next, "budget_limited", time, undefined, transitionMeta("budget", next, time, nowIso()));
    appendGoalMutation(pi, limited);
    next = applyGoalMutation(next, limited)!;
  }
  runtime.setGoal(next);
  runtime.afterGoalChanged(ctx, budget.value == null ? "Goal budget cleared." : `Goal budget set to ${budget.value}.`);
}

function accountCurrent(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: GoalState | null): GoalState | null {
  if (!goal) return null;
  const result = accountUsageFromBranch(goal, ctx.sessionManager.getBranch() as any[]);
  if (result.mutation) appendGoalMutation(pi, result.mutation);
  return result.goal;
}

export function formatGoalFooter(goal: GoalState | null): string | undefined {
  if (!goal) return undefined;
  const summary = goalToSummary(goal);
  const budget = summary.tokenBudget ? ` (${summary.tokensUsed >= 1000 ? Math.round(summary.tokensUsed / 1000) + "k" : summary.tokensUsed}/${summary.tokenBudget >= 1000 ? Math.round(summary.tokenBudget / 1000) + "k" : summary.tokenBudget})` : "";
  switch (summary.status) {
    case "active": return summary.tokenBudget ? `Goal: active${budget}` : "Pursuing goal";
    case "paused": return "Goal paused (/goal resume)";
    case "blocked": return "Goal blocked (/goal resume)";
    case "usage_limited": return "Goal hit usage limits (/goal resume)";
    case "budget_limited": return `Goal unmet${budget}`;
    case "complete": return `Goal achieved${budget}`;
  }
}

export function formatWidget(goal: GoalState | null): string[] | undefined {
  if (!goal || goal.status !== "active") return undefined;
  const summary = goalToSummary(goal);
  return [`Goal: ${summary.objective.replace(/\s+/g, " ").slice(0, 120)}`, `Usage: ${goalUsageSummary(summary)} • /goal pause to stop`];
}

export function formatElapsedForSummary(seconds: number): string {
  return formatElapsed(seconds);
}
