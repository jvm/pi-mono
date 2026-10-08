import type { AgentBeforeSettleEvent, BoundaryResult, CustomMessageEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildGoalContextMessage } from "./prompts.js";
import { PI_GOAL_VERSION } from "./metadata.js";
import { GOAL_CONTEXT_TYPE, MAX_OBJECTIVE_CHARS } from "./types.js";
import type { GoalContextReason, GoalState } from "./types.js";

export interface ContinuationRuntime {
  getGoal(): GoalState | null;
  beforeContinue?(ctx: ExtensionContext): void;
}

export class GoalContinuationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private turnCount = 0;
  private generation = 0;

  constructor(private readonly pi: ExtensionAPI, private readonly runtime: ContinuationRuntime) {}

  /** Only for explicit activation when there is no running settlement boundary. */
  schedule(ctx: ExtensionContext, reason: GoalContextReason | string = "continue", options: { afterTree?: boolean } = {}): void {
    const goal = this.runtime.getGoal();
    if (!goal || goal.status !== "active" || (!options.afterTree && !ctx.isIdle()) || ctx.hasPendingMessages()) return;
    // A replacement or a second explicit activation supersedes the old timer.
    this.clear();
    const generation = this.generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const fire = () => {
      this.timer = undefined;
      try {
        if (generation !== this.generation || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
        if (ctx.sessionManager.getSessionId() !== sessionId) return;
        if (!ctx.isIdle()) {
          // Pi releases the navigation operation only after ALL session_tree
          // handlers return. A later async handler may still be finishing.
          // agent_start or any invalidation clears this activation meanwhile.
          if (options.afterTree) this.timer = setTimeout(fire, 50);
          return;
        }
        if (leafId && !ctx.sessionManager.getBranch().some((entry) => entry.id === leafId)) return;
        this.runtime.beforeContinue?.(ctx);
        const current = this.runtime.getGoal();
        if (generation !== this.generation || !current || current.status !== "active" || current.goalId !== goal.goalId) return;
        const draft = this.buildDraft(current, reason as GoalContextReason);
        if (!draft) return;
        const { type: _type, ...message } = draft;
        this.pi.sendMessage(message, { triggerTurn: true });
      } catch {
        // A disposed/replaced SDK runtime invalidates captured contexts, even
        // without session_shutdown. Fail closed rather than restart stale work.
      }
    };
    this.timer = setTimeout(fire, 0);
  }

  /** The caller accounts finalized usage before making this synchronous proposal. */
  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
    this.clear();
    const goal = this.runtime.getGoal();
    if (!goal || goal.status !== "active" || event.outcome !== "completed" || ctx.signal?.aborted) return;
    if (goal.objective.length > MAX_OBJECTIVE_CHARS) return;
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return;

    const proposed = event.entries.some((entry) => entry.type === "custom_message"
      && entry.customType === GOAL_CONTEXT_TYPE && (entry.details as { goalId?: string } | undefined)?.goalId === goal.goalId);
    if (proposed && event.context.canContinue) {
      return { continue: true };
    }
    // canContinue describes the preview BEFORE our draft. It is normally false
    // after an assistant reply. This user-role custom message makes it runnable;
    // Pi rebuilds and validates the final preview after all handlers have run.
    const draft = this.buildDraft(goal, "continue");
    if (draft) return { entries: [...event.entries, draft], continue: true };
  }

  private buildDraft(goal: GoalState, reason: GoalContextReason): CustomMessageEntryDraft | undefined {
    // Public inputs are validated already; do not turn oversized legacy/raw
    // session data into an unbounded prompt or silently truncate the objective.
    if (goal.objective.length > MAX_OBJECTIVE_CHARS) return;
    return {
      type: "custom_message",
      customType: GOAL_CONTEXT_TYPE,
      content: buildGoalContextMessage(goal, reason === "created" || reason === "resumed" || reason === "objective_updated" ? reason : "continue"),
      display: false,
      details: { goalId: goal.goalId, reason, turnCount: ++this.turnCount, piGoalVersion: PI_GOAL_VERSION, status: goal.status, usage: { tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds } },
    };
  }

  clear(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  isScheduled(): boolean {
    return this.timer !== undefined;
  }
}

export function filterGoalContextMessages(messages: any[], goal: GoalState | null): any[] {
  if (!goal || goal.status !== "active") return messages.filter((m) => !(m?.role === "custom" && m.customType === GOAL_CONTEXT_TYPE));
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "custom" && m.customType === GOAL_CONTEXT_TYPE && m.details?.goalId === goal.goalId) lastIndex = i;
  }
  return messages.filter((m, i) => {
    if (!(m?.role === "custom" && m.customType === GOAL_CONTEXT_TYPE)) return true;
    return i === lastIndex && m.details?.goalId === goal.goalId;
  });
}
