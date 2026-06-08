import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildGoalContextMessage } from "./prompts.js";
import { PI_GOAL_VERSION } from "./metadata.js";
import { GOAL_CONTEXT_TYPE } from "./types.js";
import type { GoalContextReason, GoalState } from "./types.js";

export interface ContinuationRuntime {
  getGoal(): GoalState | null;
}

export class GoalContinuationScheduler {
  private scheduled = false;
  private inFlight = false;
  private timer: NodeJS.Timeout | undefined;
  private turnCount = 0;
  private lastGoalId: string | undefined;

  constructor(private readonly pi: ExtensionAPI, private readonly runtime: ContinuationRuntime) {}

  schedule(ctx: ExtensionContext, reason: GoalContextReason | string = "continue"): void {
    const goal = this.runtime.getGoal();
    if (!goal || goal.status !== "active") return;
    if (ctx.hasPendingMessages()) return;
    if (this.scheduled || this.inFlight) return;
    this.scheduled = true;
    this.lastGoalId = goal.goalId;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.fire(ctx, reason as GoalContextReason);
    }, 0);
  }

  private async fire(ctx: ExtensionContext, reason: GoalContextReason): Promise<void> {
    this.scheduled = false;
    const goal = this.runtime.getGoal();
    if (!goal || goal.status !== "active" || goal.goalId !== this.lastGoalId) return;
    if (ctx.hasPendingMessages()) return;
    this.inFlight = true;
    this.turnCount++;
    try {
      this.pi.sendMessage({
        customType: GOAL_CONTEXT_TYPE,
        content: buildGoalContextMessage(goal, reason === "created" || reason === "resumed" || reason === "objective_updated" ? reason : "continue"),
        display: false,
        details: { goalId: goal.goalId, reason, turnCount: this.turnCount, piGoalVersion: PI_GOAL_VERSION, status: goal.status, usage: { tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds } },
      }, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
    } finally {
      this.inFlight = false;
    }
  }

  clear(): void {
    this.scheduled = false;
    this.inFlight = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  isScheduled(): boolean {
    return this.scheduled;
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
