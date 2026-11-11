import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalMutation, GoalState, GoalStatus, ParsedGoalCommand } from "./types.js";
import { GOAL_EVENT_TYPE, GOAL_SCHEMA_VERSION, GOAL_SUMMARY_TYPE } from "./types.js";
import { accountUsageFromBranch, isBudgetExceeded } from "./accounting.js";
import { appendGoalMutation, applyGoalMutation, createGoalMutation, goalTransitionRejection, replaceGoalMutation, statusMutation } from "./state.js";
import { PI_GOAL_VERSION, transitionMeta, withPiGoalVersion } from "./metadata.js";
import { formatElapsed, goalToSummary, goalUsageSummary, nowIso, realizedTimeUsed } from "./utils.js";
import { parseTokenBudget, validateObjective, validateTokenBudget } from "./validation.js";

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
  if (trimmed === "budget") return invalid(BUDGET_USAGE);
  const budget = trimmed.match(/^budget\s+(\S+)$/);
  if (budget) {
    const parsed = parseTokenBudget(budget[1]);
    return parsed.ok ? { action: "setBudget", tokenBudget: parsed.value } : invalid(`${parsed.error} ${BUDGET_USAGE}`);
  }
  // A leading option is never an objective: a flag without an objective, an
  // unknown option, or a malformed budget must not silently create a goal.
  if (trimmed.startsWith("--")) {
    const withBudget = trimmed.match(/^--budget(?:=|\s+)(\S+)(?:\s+([\s\S]*))?$/);
    if (!withBudget) return invalid(/^--budget\b/.test(trimmed) ? CREATE_USAGE : `Unknown option ${JSON.stringify(trimmed.split(/\s/, 1)[0])}. ${CREATE_USAGE}`);
    const parsed = parseTokenBudget(withBudget[1]);
    if (!parsed.ok) return invalid(`${parsed.error} ${CREATE_USAGE}`);
    if (!withBudget[2]?.trim()) return invalid(`Missing objective. ${CREATE_USAGE}`);
    return { action: "createOrReplace", tokenBudget: parsed.value, objective: withBudget[2] };
  }
  return { action: "createOrReplace", objective: trimmed };
}

const CREATE_USAGE = "Usage: /goal --budget <tokens> <objective> (tokens such as 50000, 50k, or 1.5m).";
const BUDGET_USAGE = "Usage: /goal budget <tokens> or /goal budget clear.";

function invalid(error: string): ParsedGoalCommand {
  return { action: "invalid", error };
}

export async function handleGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  const parsed = parseGoalCommand(args);
  if (parsed.action === "invalid") return ctx.ui.notify(parsed.error ?? "Invalid /goal command.", "error");
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
  // An exhausted budget still applies to the edited objective; reactivating it
  // would only re-limit the goal on the next continuation.
  const reactivate = current.status === "complete" || (current.status === "budget_limited" && !isBudgetExceeded(current));
  const mutation: GoalMutation = { schemaVersion: GOAL_SCHEMA_VERSION, kind: "edit", goalId: current.goalId, objective: objective.value, status: reactivate ? "active" : current.status, at: nowIso(), meta: withPiGoalVersion({ source: "command:/goal edit" }) };
  appendGoalMutation(pi, mutation);
  runtime.setGoal(applyGoalMutation(current, mutation));
  runtime.afterGoalChanged(ctx, "Goal updated.");
  if (reactivate) runtime.scheduleContinuation(ctx, "objective_updated");
}

function setGoalStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: CommandRuntime, status: "paused" | "active"): void {
  const current = accountCurrent(pi, ctx, runtime.getGoal());
  if (!current) return ctx.ui.notify("No goal set.", "error");
  const rejected = goalTransitionRejection(current, status);
  if (rejected) return ctx.ui.notify(rejected, "error");
  const transitionedAt = nowIso();
  const time = realizedTimeUsed(current, Date.parse(transitionedAt));
  const activeStartedAt = status === "active" ? transitionedAt : undefined;
  const mutation = statusMutation(current, status, time, activeStartedAt, transitionMeta(status === "active" ? "command:/goal resume" : "command:/goal pause", current, time, transitionedAt));
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
  // Raising or clearing the budget of a budget-limited goal removes the only
  // reason it stopped, so resume it as /goal resume would.
  const resume = next.status === "budget_limited" && (next.tokenBudget == null || next.tokensUsed < next.tokenBudget);
  if (resume) {
    const resumedAt = nowIso();
    const time = realizedTimeUsed(next, Date.parse(resumedAt));
    const resumed = statusMutation(next, "active", time, resumedAt, transitionMeta("command:/goal budget", next, time, resumedAt));
    appendGoalMutation(pi, resumed);
    next = applyGoalMutation(next, resumed)!;
  }
  runtime.setGoal(next);
  const event = budget.value == null ? "Goal budget cleared." : `Goal budget set to ${budget.value}.`;
  runtime.afterGoalChanged(ctx, resume ? `${event} Goal resumed.` : event);
  if (resume) runtime.scheduleContinuation(ctx, "resumed");
}

function accountCurrent(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: GoalState | null): GoalState | null {
  if (!goal) return null;
  const result = accountUsageFromBranch(goal, ctx.sessionManager.getBranch() as any[]);
  if (result.mutation) appendGoalMutation(pi, result.mutation);
  return result.goal;
}

const GOAL_ICON = "\u{f08c9}"; // Nerd Fonts 3 nf-md-bullseye_arrow
const GOAL_STATUS_ICONS: Record<GoalStatus, string> = {
  active: "\u{f040a}", // nf-md-play
  paused: "\u{f03e4}", // nf-md-pause
  blocked: "\u{f033e}", // nf-md-lock
  usage_limited: "\u{f051f}", // nf-md-timer_sand
  budget_limited: "\u{f0199}", // nf-md-counter
  complete: "\u{f012c}", // nf-md-check
};

export function formatGoalFooter(goal: GoalState | null): string | undefined {
  if (!goal) return undefined;
  const summary = goalToSummary(goal);
  const budget = summary.tokenBudget ? ` ${summary.tokensUsed >= 1000 ? Math.round(summary.tokensUsed / 1000) + "k" : summary.tokensUsed}/${summary.tokenBudget >= 1000 ? Math.round(summary.tokenBudget / 1000) + "k" : summary.tokenBudget}` : "";
  return `${GOAL_ICON} ${GOAL_STATUS_ICONS[summary.status]}${budget}`;
}

export function formatWidget(goal: GoalState | null): string[] | undefined {
  if (!goal || goal.status !== "active") return undefined;
  const summary = goalToSummary(goal);
  return [`Goal: ${summary.objective.replace(/\s+/g, " ").slice(0, 120)}`, `Usage: ${goalUsageSummary(summary)} • /goal pause to stop`];
}

export function formatElapsedForSummary(seconds: number): string {
  return formatElapsed(seconds);
}
