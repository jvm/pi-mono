import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { accountUsageFromBranch } from "./accounting.js";
import { appendGoalMutation, applyGoalMutation, createGoalMutation, statusMutation } from "./state.js";
import { findToolCallContext, transitionMeta } from "./metadata.js";
import type { BranchEntry, GoalState, GoalStatus } from "./types.js";
import { goalToSummary, goalUsageSummary, nowIso, realizedTimeUsed, truncateOneLine } from "./utils.js";
import { validateObjective, validateTokenBudget } from "./validation.js";

export interface ToolRuntime {
  getGoal(): GoalState | null;
  setGoal(goal: GoalState | null): void;
  afterGoalChanged(ctx: ExtensionContext, event?: string): void;
  clearContinuation(): void;
}

const CreateGoalParams = Type.Object({
  objective: Type.String({ description: "Goal objective explicitly requested by the user/system/developer.", maxLength: 4000 }),
  token_budget: Type.Optional(Type.Integer({ description: "Optional positive token budget.", minimum: 1 })),
}, { additionalProperties: false });

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, { description: "Terminal model-controlled goal status." }),
  verification: Type.Optional(Type.Object({
    summary: Type.Optional(Type.String({ description: "Concise verification/blocker summary based on already-inspected evidence.", maxLength: 2000 })),
    checked_requirements: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 })),
    commands: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
    worktree_status: Type.Optional(StringEnum(["clean", "dirty", "unknown"] as const)),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export function registerGoalTools(pi: ExtensionAPI, runtime: ToolRuntime): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Return the current persistent Pi goal and usage for this session branch.",
    promptSnippet: "Inspect the active persistent goal and token/time budget.",
    promptGuidelines: ["Use get_goal when you need current pi-goal objective, status, usage, or remaining budget."],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const goal = runtime.getGoal();
      const payload = goal ? goalToSummary(goal) : null;
      return { content: [{ type: "text", text: payload ? JSON.stringify({ goal: payload }, null, 2) : "No goal is set." }], details: { goal: payload } };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const goal = (result.details as any)?.goal;
      return new Text(goal ? `${theme.fg("success", "Goal")} ${theme.fg("accent", goal.status)} ${theme.fg("muted", goalUsageSummary(goal))}` : theme.fg("muted", "No goal set"), 0, 0);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a persistent Pi goal only when explicitly requested by user/system/developer instructions. Fails if a goal already exists.",
    promptSnippet: "Create a new persistent goal when explicitly requested.",
    promptGuidelines: [
      "Use create_goal only when the user/system/developer explicitly asks to create or set a persistent goal.",
      "Do not use create_goal to invent goals or replace an existing goal.",
    ],
    parameters: CreateGoalParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (runtime.getGoal()) throw new Error("A goal already exists. Ask the user to clear or replace it.");
      const objective = validateObjective(params.objective);
      if (!objective.ok) throw new Error(objective.error);
      const budget = validateTokenBudget(params.token_budget, { allowEmpty: true });
      if (!budget.ok) throw new Error(budget.error);
      const mutation = createGoalMutation(objective.value, budget.value, { source: "tool:create_goal", trigger: { toolCallId } });
      appendGoalMutation(pi, mutation);
      const goal = applyGoalMutation(null, mutation)!;
      runtime.setGoal(goal);
      runtime.afterGoalChanged(ctx, "Goal created.");
      const summary = goalToSummary(goal);
      return { content: [{ type: "text", text: JSON.stringify({ goal: summary }, null, 2) }], details: { goal: summary } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("create_goal"))} ${theme.fg("accent", truncateOneLine(String((args as any).objective ?? "")))}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const goal = (result.details as any)?.goal;
      return new Text(goal ? `${theme.fg("success", "✓ Goal created")} ${theme.fg("muted", goalUsageSummary(goal))}` : theme.fg("error", "Goal creation failed"), 0, 0);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the current Pi goal complete or blocked. Only model-controlled terminal goal updates are accepted.",
    promptSnippet: "Mark the persistent goal complete or blocked after strict verification.",
    promptGuidelines: [
      "Use update_goal with status complete only after explicit requirement-by-requirement verification proves the full goal is satisfied.",
      "Use update_goal with status blocked only after the same blocker repeats for at least three consecutive goal turns.",
      "Never use update_goal for pause, resume, budget_limited, usage_limited, or edits; those are user/system-controlled.",
    ],
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete" && params.status !== "blocked") throw new Error("update_goal only accepts status complete or blocked.");
      const branch = ctx.sessionManager.getBranch() as BranchEntry[];
      const toolContext = assertStandaloneUpdateGoalCall(branch, toolCallId);
      const current = runtime.getGoal();
      if (!current) throw new Error("No goal exists.");
      let goal = current;
      const accounting = accountUsageFromBranch(goal, branch);
      if (accounting.mutation) appendGoalMutation(pi, accounting.mutation);
      goal = accounting.goal;
      const time = realizedTimeUsed(goal);
      const verification = params.verification ? {
        summary: params.verification.summary,
        checkedRequirements: params.verification.checked_requirements,
        commands: params.verification.commands,
        worktreeStatus: params.verification.worktree_status,
      } : undefined;
      const mutation = statusMutation(goal, params.status as GoalStatus, time, undefined, transitionMeta(`tool:update_goal:${params.status}`, goal, time, nowIso(), {
        trigger: toolContext ? { messageId: toolContext.messageId, toolCallId: toolContext.toolCallId, siblingToolCalls: toolContext.siblingToolCalls } : { toolCallId },
        verification,
      }));
      appendGoalMutation(pi, mutation);
      goal = applyGoalMutation(goal, mutation)!;
      runtime.setGoal(goal);
      runtime.clearContinuation();
      runtime.afterGoalChanged(ctx, params.status === "complete" ? "Goal achieved." : "Goal blocked.");
      const summary = goalToSummary(goal);
      const report = params.status === "complete" && summary.tokenBudget ? `Completion budget report: used ${summary.tokensUsed}/${summary.tokenBudget} tokens; remaining ${summary.remainingTokens}.` : undefined;
      return { content: [{ type: "text", text: JSON.stringify({ goal: summary, report }, null, 2) }], details: { goal: summary, report }, terminate: true };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("update_goal"))} ${theme.fg("accent", String((args as any).status ?? ""))}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const goal = (result.details as any)?.goal;
      const ok = goal?.status === "complete" ? "✓ Goal complete" : goal?.status === "blocked" ? "⚠ Goal blocked" : "Goal updated";
      return new Text(`${theme.fg(goal?.status === "complete" ? "success" : "warning", ok)} ${goal ? theme.fg("muted", goalUsageSummary(goal)) : ""}`, 0, 0);
    },
  });
}

export function assertStandaloneUpdateGoalCall(branchEntries: BranchEntry[], toolCallId: string) {
  const toolContext = findToolCallContext(branchEntries, toolCallId);
  if (!toolContext) return undefined;
  if (toolContext.siblingToolCalls.length > 1) {
    throw new Error("update_goal must be the only tool call in its assistant turn. Run verification commands first, inspect their results, then call update_goal in a separate final turn.");
  }
  return toolContext;
}

export function usageLimitedMutation(goal: GoalState) {
  return statusMutation(goal, "usage_limited", realizedTimeUsed(goal), undefined);
}

export const _testNowIso = nowIso;
