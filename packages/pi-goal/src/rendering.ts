import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { GOAL_EVENT_TYPE, GOAL_SUMMARY_TYPE } from "./types.js";

export function registerGoalRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(GOAL_SUMMARY_TYPE, (message: any, options: any, theme: any) => {
    const goal = message.details?.goal;
    let text = goal ? `${theme.fg("accent", theme.bold("Goal"))} ${theme.fg("muted", goal.status)}\n${goal.objective}` : theme.fg("muted", String(message.content ?? ""));
    if (goal && options.expanded) text += `\n${JSON.stringify(goal, null, 2)}`;
    return new Text(text, 0, 0);
  });
  pi.registerMessageRenderer(GOAL_EVENT_TYPE, (message: any, _options: any, theme: any) => {
    return new Text(`${theme.fg("accent", "Goal")} ${String(message.content ?? "")}`, 0, 0);
  });
}
