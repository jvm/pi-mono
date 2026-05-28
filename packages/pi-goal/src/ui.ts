import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalState } from "./types.js";
import { formatGoalFooter, formatWidget } from "./commands.js";

export function updateGoalUi(ctx: ExtensionContext, goal: GoalState | null): void {
  ctx.ui.setStatus("pi-goal", formatGoalFooter(goal));
  ctx.ui.setWidget("pi-goal", formatWidget(goal), { placement: "belowEditor" });
}

export function clearGoalUi(ctx: ExtensionContext): void {
  ctx.ui.setStatus("pi-goal", undefined);
  ctx.ui.setWidget("pi-goal", undefined);
}
