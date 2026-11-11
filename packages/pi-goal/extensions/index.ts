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
import { nowIso, realizedTimeUsed, truncateOneLine } from "../src/utils.js";
import { classifyAssistantError } from "../src/provider-limits.js";
import type { ProviderLimitClassification, ProviderLimitKind } from "../src/provider-limits.js";
import { clearGoalUi, updateGoalUi } from "../src/ui.js";

/** Only these classifications are evidence that a provider limit stopped the goal. */
const USAGE_LIMIT_KINDS: ReadonlySet<ProviderLimitKind> = new Set(["rate_limit", "usage_limit", "quota_exceeded", "billing_required"]);
/**
 * Consecutive failed runs on one provider/model before a goal without limit
 * evidence pauses. Each run already includes Pi's own retries, if enabled.
 * Between failed runs the goal continues automatically after these delays, so
 * an active goal never waits silently for user input after a failure.
 */
const PROVIDER_ERROR_PAUSE_THRESHOLD = 3;
const FAILED_RUN_RETRY_DELAYS_MS = [30_000, 120_000] as const;

interface AttemptError {
  scope: string;
  errorMessage: string;
  classification: ProviderLimitClassification;
}

export default function piGoal(pi: ExtensionAPI) {
  reportInstallTelemetry();

  let goal: GoalState | null = null;
  // Evidence from the current run's newest failed attempt and HTTP response.
  let lastAttemptError: AttemptError | undefined;
  let lastResponse: { status?: number; headers?: Record<string, string | string[] | undefined> } | undefined;
  // Consecutive failed runs for one provider/model; a success or switch resets it.
  let errorStreak: { scope?: string; count: number } = { count: 0 };
  let automaticCompactionFailed = false;
  const scheduler = new GoalContinuationScheduler(pi, { getGoal: () => goal, beforeContinue: accountAndEnforceBudget });
  let idleAccountingTimer: ReturnType<typeof setInterval> | undefined;

  function stopIdleAccounting(): void {
    if (idleAccountingTimer) clearInterval(idleAccountingTimer);
    idleAccountingTimer = undefined;
  }

  function startIdleAccounting(ctx: ExtensionContext): void {
    stopIdleAccounting();
    let lastLeaf = ctx.sessionManager.getLeafId?.();
    // Pi 1.1 emits warming entry_appended only to SDK listeners, not extensions.
    // Poll the cheap public leaf ID; scan billing history only when it changes.
    idleAccountingTimer = setInterval(() => {
      try {
        if (!ctx.isIdle() || !goal) return;
        const leaf = ctx.sessionManager.getLeafId?.();
        if (leaf === lastLeaf) return;
        accountAndEnforceBudget(ctx);
        lastLeaf = ctx.sessionManager.getLeafId?.();
      } catch {
        // SDK disposal can invalidate contexts without dispatching shutdown.
        // Never keep using a stale context; normal lifecycle checks still apply.
        stopIdleAccounting();
      }
    }, 1000);
    idleAccountingTimer.unref();
  }

  const setGoal = (next: GoalState | null) => { goal = next; };

  function clearProviderErrorState(): void {
    lastAttemptError = undefined;
    lastResponse = undefined;
    errorStreak = { count: 0 };
  }

  function afterGoalChanged(ctx: ExtensionContext, event?: string): void {
    if (event) errorStreak = { count: 0 };
    updateGoalUi(ctx, goal);
    if (event) {
      ctx.ui.notify(event, "info");
      pi.sendMessage({ customType: GOAL_EVENT_TYPE, content: event, display: true, details: { goal, piGoalVersion: PI_GOAL_VERSION } });
    }
    if (!goal || goal.status !== "active") scheduler.clear();
  }

  // Send a visible message to the model so it can react to a terminal
  // status transition (budget exhausted, provider limit hit) instead of
  // silently continuing to spend tokens on work that is about to be cut
  // off. Terminal notices are context-only: they must not buy another request.
  function notifyAgentOfTerminalTransition(
    content: string,
    details: Record<string, unknown>,
  ): void {
    pi.sendMessage(
      {
        customType: GOAL_EVENT_TYPE,
        content,
        display: true,
        details: { ...details, piGoalVersion: PI_GOAL_VERSION },
      },
      { triggerTurn: false },
    );
  }

  function pauseForProviderLimit(ctx: ExtensionContext, classification: ProviderLimitClassification): void {
    if (!goal || goal.status !== "active" || !classification.pause) return;
    const snapshot = goal;
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
    notifyAgentOfTerminalTransition(
      `<provider_limit>\nYour persistent Pi goal has been paused because the provider hit a usage/rate limit${suffix}. The goal is in the "usage_limited" state. Do not do any more work that would use additional tokens. Use /goal resume to continue after the limit resets, or call update_goal with status "complete" or "blocked" to finalize the goal now.\n</provider_limit>`,
      {
        kind: "provider_limit",
        goalId: snapshot.goalId,
        providerLimit: {
          kind: classification.kind,
          reason: classification.reason,
          resetHint: classification.resetHint,
          retryAfterSeconds: classification.retryAfterSeconds,
        },
      },
    );
  }

  // A failure without limit evidence is not a usage limit. Pause it as an
  // ordinary pause with the real reason, and do not suggest finalizing the goal.
  function pauseForProviderError(ctx: ExtensionContext, kind: "provider_error" | "auth_required", reason: string): void {
    if (!goal || goal.status !== "active") return;
    const snapshot = goal;
    const time = realizedTimeUsed(goal);
    const providerLimit = { kind, reason };
    const paused = statusMutation(goal, "paused", time, undefined, transitionMeta("provider-error", goal, time, nowIso(), { providerLimit }));
    appendGoalMutation(pi, paused);
    goal = applyGoalMutation(goal, paused);
    ctx.ui.notify(`Goal paused: ${reason}.`, "warning");
    updateGoalUi(ctx, goal);
    scheduler.clear();
    notifyAgentOfTerminalTransition(
      `<provider_error>\nYour persistent Pi goal has been paused because ${reason}. This is not a confirmed usage or rate limit. The goal is in the "paused" state. Do not continue goal work until the user resumes it. The user can fix the provider problem or switch provider/model, then use /goal resume.\n</provider_error>`,
      { kind: "provider_error", goalId: snapshot.goalId, providerLimit },
    );
  }

  /** Returns the delay of the automatic retry to schedule, if any. */
  function settleFailedRun(ctx: ExtensionContext): number | undefined {
    const failure = lastAttemptError;
    if (!failure || !goal || goal.status !== "active") return;
    const { classification, scope } = failure;
    const lastError = `last error: ${JSON.stringify(failure.errorMessage)}`;
    if (classification.pause && USAGE_LIMIT_KINDS.has(classification.kind)) {
      errorStreak = { count: 0 };
      pauseForProviderLimit(ctx, classification);
      return;
    }
    if (classification.pause && classification.kind === "auth_required") {
      errorStreak = { count: 0 };
      pauseForProviderError(ctx, "auth_required", `${classification.reason} on ${scope} (${lastError})`);
      return;
    }
    if (errorStreak.scope !== scope) errorStreak = { scope, count: 0 };
    errorStreak.count++;
    if (errorStreak.count < PROVIDER_ERROR_PAUSE_THRESHOLD) {
      const delayMs = FAILED_RUN_RETRY_DELAYS_MS[errorStreak.count - 1];
      ctx.ui.notify(`Goal run failed on ${scope} (${lastError}). Continuing automatically in ${Math.round(delayMs / 1000)}s (failed run ${errorStreak.count} of ${PROVIDER_ERROR_PAUSE_THRESHOLD}).`, "warning");
      return delayMs;
    }
    const count = errorStreak.count;
    errorStreak = { count: 0 };
    pauseForProviderError(ctx, "provider_error", `${count} consecutive runs failed on ${scope} (${lastError})`);
  }

  function accountAndEnforceBudget(ctx: ExtensionContext): void {
    if (!goal) return;
    const result = accountUsageFromBranch(goal, ctx.sessionManager.getBranch() as any[]);
    if (result.mutation) appendGoalMutation(pi, result.mutation);
    goal = result.goal;
    if (goal.status === "active" && isBudgetExceeded(goal)) {
      const snapshot = goal;
      const time = realizedTimeUsed(goal);
      const limited = statusMutation(goal, "budget_limited", time, undefined, transitionMeta("budget", goal, time, nowIso()));
      appendGoalMutation(pi, limited);
      goal = applyGoalMutation(goal, limited);
      ctx.ui.notify("Goal token budget reached.", "warning");
      scheduler.clear();
      notifyAgentOfTerminalTransition(
        `<budget_exceeded>\nYour persistent Pi goal's token budget of ${snapshot.tokenBudget} has been reached (used ${snapshot.tokensUsed} tokens). Stop work immediately to avoid burning more tokens. If all requirements are satisfied, call update_goal with status "complete". If the goal cannot be completed, call update_goal with status "blocked". Do not do any more work that would use additional tokens.\n</budget_exceeded>`,
        {
          kind: "budget_exceeded",
          goalId: snapshot.goalId,
          tokensUsed: snapshot.tokensUsed,
          tokenBudget: snapshot.tokenBudget,
        },
      );
    }
    updateGoalUi(ctx, goal);
  }

  registerGoalRenderers(pi);
  registerGoalTools(pi, {
    getGoal: () => goal,
    refreshUsage: accountAndEnforceBudget,
    setGoal,
    afterGoalChanged,
    clearContinuation: () => scheduler.clear(),
  });

  pi.registerCommand("goal", {
    description: "set or view the goal for a long-running task",
    getArgumentCompletions: goalCompletions,
    handler: async (args, ctx) => {
      accountAndEnforceBudget(ctx);
      await handleGoalCommand(pi, args, ctx, {
        getGoal: () => goal,
        setGoal,
        afterGoalChanged,
        scheduleContinuation: (commandCtx, reason) => scheduler.schedule(commandCtx, reason),
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    scheduler.clear();
    automaticCompactionFailed = false;
    clearProviderErrorState();
    const diagnostics: string[] = [];
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[], diagnostics);
    if (goal?.status === "active" && !goal.activeStartedAt) {
      const time = realizedTimeUsed(goal);
      const resumed = statusMutation(goal, "active", time, nowIso(), transitionMeta("session_start:reactivate", goal, time, nowIso()));
      appendGoalMutation(pi, resumed);
      goal = applyGoalMutation(goal, resumed);
    }
    if (diagnostics.length) ctx.ui.notify(`pi-goal: ${diagnostics[0]}`, "warning");
    accountAndEnforceBudget(ctx);
    updateGoalUi(ctx, goal);
    startIdleAccounting(ctx);
    if (goal?.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) scheduler.schedule(ctx, "continue");
  });

  pi.on("session_tree", async (_event, ctx) => {
    scheduler.clear();
    automaticCompactionFailed = false;
    clearProviderErrorState();
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[]);
    accountAndEnforceBudget(ctx);
    updateGoalUi(ctx, goal);
    startIdleAccounting(ctx);
    if (goal?.status === "active" && !ctx.hasPendingMessages()) scheduler.schedule(ctx, "continue", { afterTree: true });
  });

  pi.on("session_compact", async (_event, ctx) => {
    goal = reconstructGoalState(ctx.sessionManager.getBranch() as any[]);
    accountAndEnforceBudget(ctx);
    updateGoalUi(ctx, goal);
  });

  pi.on("session_compact_failed", (event) => {
    if (event.reason !== "manual") {
      automaticCompactionFailed = true;
      scheduler.clear();
    }
  });

  pi.on("agent_start", () => {
    // A real run supersedes any idle activation. Never leave a timer behind
    // that could restart the session after cancellation or recovery.
    scheduler.clear();
    // Each attempt, including Pi's retries, reports its own response and result.
    lastAttemptError = undefined;
    lastResponse = undefined;
  });

  pi.on("agent_settled", () => {
    // agent_start also fires for queued work inside the same high-level run.
    // Keep a compaction failure latched until that entire run has settled.
    automaticCompactionFailed = false;
  });

  pi.on("message_end", async (event: any, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant") return;
    if (message.stopReason === "error" || message.errorMessage) {
      // Pi emits message_end for every failed attempt and decides about its
      // auto-retry only afterwards. Record the evidence; act at settlement.
      // Classify the attempt's response status and error text together: a known
      // status outranks the wording. The response belongs to this attempt only.
      const classification = classifyAssistantError(message, lastResponse);
      lastResponse = undefined;
      lastAttemptError = {
        scope: `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`,
        errorMessage: truncateOneLine(String(message.errorMessage || "unknown error"), 200),
        classification,
      };
      return;
    }
    clearProviderErrorState();
    accountAndEnforceBudget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Unlike message_end, this boundary sees persisted assistant/tool entries.
    accountAndEnforceBudget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
  });

  pi.on("agent_before_settle", (event, ctx) => {
    accountAndEnforceBudget(ctx);
    // Settlement runs only after Pi's own retry loop has given up, so a pause
    // here never races a retry that could still succeed.
    const retryDelayMs = event.outcome === "error" ? settleFailedRun(ctx) : undefined;
    if (event.outcome === "completed") clearProviderErrorState();
    lastAttemptError = undefined;
    lastResponse = undefined;
    if (automaticCompactionFailed) return;
    const result = scheduler.beforeSettle(event, ctx);
    // A failed run cannot continue inside settlement. Retry it after a delay,
    // once Pi is idle; a new run, pause, or session change cancels the retry.
    if (retryDelayMs != null) scheduler.schedule(ctx, "continue", { delayMs: retryDelayMs });
    return result;
  });

  pi.on("cache_warming_decision", async (_event, ctx) => {
    accountAndEnforceBudget(ctx);
    // Never enable warming or change no-goal sessions. Pi chains actions in
    // registration order, so a later handler can explicitly override this stop.
    if (ctx.isIdle() && goal && (goal.tokenBudget != null || goal.status === "budget_limited" || goal.status === "usage_limited")) {
      return { action: "stop" };
    }
  });

  pi.on("after_provider_response", async (event) => {
    // Pi retries HTTP 429 itself. Keep the newest response until the attempt's
    // message_end classifies it with the error text; settlement acts on it.
    lastResponse = { status: event.status, headers: event.headers };
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
  pi.on("session_before_tree", (_event, ctx) => {
    accountAndEnforceBudget(ctx);
    scheduler.clear();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopIdleAccounting();
    accountAndEnforceBudget(ctx);
    if (goal?.status === "active") {
      const time = realizedTimeUsed(goal);
      const stopped = statusMutation(goal, "active", time, undefined, transitionMeta("session_shutdown", goal, time, nowIso()));
      appendGoalMutation(pi, stopped);
    }
    scheduler.clear();
    clearGoalUi(ctx);
  });
}
