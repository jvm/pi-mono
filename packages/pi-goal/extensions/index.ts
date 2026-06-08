import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountUsageFromBranch, isBudgetExceeded } from "../src/accounting.js";
import { goalCompletions, handleGoalCommand } from "../src/commands.js";
import { filterGoalContextMessages, GoalContinuationScheduler } from "../src/continuation.js";
import { registerGoalRenderers } from "../src/rendering.js";
import { appendGoalMutation, applyGoalMutation, reconstructGoalState, statusMutation } from "../src/state.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { registerGoalTools } from "../src/tools.js";
import type { GoalState } from "../src/types.js";
import { GOAL_EVENT_TYPE } from "../src/types.js";
import { PI_GOAL_VERSION, transitionMeta } from "../src/metadata.js";
import { nowIso, realizedTimeUsed } from "../src/utils.js";
import { classifyAssistantError, classifyProviderLimit } from "../src/provider-limits.js";
import type { ProviderLimitClassification } from "../src/provider-limits.js";
import { clearGoalUi, updateGoalUi } from "../src/ui.js";

export default function piGoal(pi: ExtensionAPI) {
  reportInstallTelemetry();

  let goal: GoalState | null = null;
  let consecutiveAssistantErrors = 0;
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal });

  const setGoal = (next: GoalState | null) => { goal = next; };

  function afterGoalChanged(ctx: ExtensionContext, event?: string): void {
    if (event) consecutiveAssistantErrors = 0;
    updateGoalUi(ctx, goal);
    if (event) {
      ctx.ui.notify(event, "info");
      pi.sendMessage({ customType: GOAL_EVENT_TYPE, content: event, display: true, details: { goal, piGoalVersion: PI_GOAL_VERSION } });
    }
    if (!goal || goal.status !== "active") scheduler.clear();
  }

  function pauseForProviderLimit(ctx: ExtensionContext, classification: ProviderLimitClassification): void {
    if (!goal || goal.status !== "active" || !classification.pause) return;
    const time = realizedTimeUsed(goal);
    const limited = statusMutation(goal, "usage_limited", time, undefined, transitionMeta("provider-limit", goal, time, nowIso(), {
      providerLimit: {
        kind: classification.kind,
        reason: classification.reason,
        resetHint: classification.resetHint,
        retryAfterSeconds: classification.retryAfterSeconds,
      },
    }));
    appendGoalMutation(pi, limited);
    goal = applyGoalMutation(goal, limited);
    const suffix = classification.resetHint ? ` (${classification.resetHint})` : classification.retryAfterSeconds != null ? ` (retry after ${classification.retryAfterSeconds}s)` : "";
    ctx.ui.notify(`Goal paused because the provider hit a usage/rate limit${suffix}.`, "warning");
    updateGoalUi(ctx, goal);
    scheduler.clear();
  }

  function accountAndEnforceBudget(ctx: ExtensionContext): void {
    if (!goal) return;
    const result = accountUsageFromBranch(goal, ctx.sessionManager.getBranch() as any[]);
    if (result.mutation) appendGoalMutation(pi, result.mutation);
    goal = result.goal;
    if (goal.status === "active" && isBudgetExceeded(goal)) {
      const time = realizedTimeUsed(goal);
      const limited = statusMutation(goal, "budget_limited", time, undefined, transitionMeta("budget", goal, time, nowIso()));
      appendGoalMutation(pi, limited);
      goal = applyGoalMutation(goal, limited);
      ctx.ui.notify("Goal token budget reached.", "warning");
      scheduler.clear();
    }
    updateGoalUi(ctx, goal);
  }

  registerGoalRenderers(pi);
  registerGoalTools(pi, {
    getGoal: () => goal,
    setGoal,
    afterGoalChanged,
    clearContinuation: () => scheduler.clear(),
  });

  pi.registerCommand("goal", {
    description: "set or view the goal for a long-running task",
    getArgumentCompletions: goalCompletions,
    handler: async (args, ctx) => {
      await handleGoalCommand(pi, args, ctx, {
        getGoal: () => goal,
        setGoal,
        afterGoalChanged,
        scheduleContinuation: (commandCtx, reason) => scheduler.schedule(commandCtx, reason),
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const diagnostics: string[] = [];
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[], diagnostics);
    if (goal?.status === "active" && !goal.activeStartedAt) {
      const time = realizedTimeUsed(goal);
      const resumed = statusMutation(goal, "active", time, nowIso(), transitionMeta("session_start:reactivate", goal, time, nowIso()));
      appendGoalMutation(pi, resumed);
      goal = applyGoalMutation(goal, resumed);
    }
    if (diagnostics.length) ctx.ui.notify(`pi-goal: ${diagnostics[0]}`, "warning");
    updateGoalUi(ctx, goal);
    if (goal?.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) scheduler.schedule(ctx, "continue");
  });

  pi.on("session_tree", async (_event, ctx) => {
    scheduler.clear();
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[]);
    updateGoalUi(ctx, goal);
    if (goal?.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) scheduler.schedule(ctx, "continue");
  });

  pi.on("session_compact", async (_event, ctx) => {
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[]);
    updateGoalUi(ctx, goal);
  });

  pi.on("message_end", async (event: any, ctx) => {
    if (event.message?.role !== "assistant") return;
    const classification = classifyAssistantError(event.message);
    if (classification.pause) {
      consecutiveAssistantErrors = 0;
      pauseForProviderLimit(ctx, classification);
      return;
    }
    if (event.message?.stopReason === "error" || event.message?.errorMessage) {
      consecutiveAssistantErrors++;
      if (consecutiveAssistantErrors >= 3 && goal?.status === "active") {
        pauseForProviderLimit(ctx, { kind: "provider_error", pause: true, reason: "repeated assistant provider errors" });
      }
      return;
    }
    consecutiveAssistantErrors = 0;
    accountAndEnforceBudget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
    if (goal?.status === "active") scheduler.schedule(ctx, "continue");
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!goal || goal.status !== "active") return;
    pauseForProviderLimit(ctx, classifyProviderLimit({ status: event.status, headers: event.headers }));
  });

  pi.on("context", async (event) => {
    return { messages: filterGoalContextMessages(event.messages as any[], goal) as any };
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
    scheduler.clear();
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
    scheduler.clear();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (goal?.status === "active") {
      const time = realizedTimeUsed(goal);
      const stopped = statusMutation(goal, "active", time, undefined, transitionMeta("session_shutdown", goal, time, nowIso()));
      appendGoalMutation(pi, stopped);
    }
    scheduler.clear();
    clearGoalUi(ctx);
  });
}
