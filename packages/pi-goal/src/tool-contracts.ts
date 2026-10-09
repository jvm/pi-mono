import { Type } from "typebox";
import type { GoalSummary } from "./types.js";

export const GOAL_NAMESPACE = {
  name: "goal",
  description: "Inspect or explicitly create the current branch's persistent goal.",
  instructions: "get_goal and create_goal return { goal }, with goal:null only when no goal is set. Await dependent calls: create_goal mutates branch state and fails if a goal exists. get_goal refreshes usage bookkeeping before returning a snapshot. Errors reject rather than returning a success object. Creation requires an explicit user/system/developer request. update_goal remains model-only: call it directly, alone in a final assistant turn after verification, never from a script.",
};

const summary = Type.Object({
  goalId: Type.String(),
  // Creation is limited to 4,000 chars; legacy stored objectives remain readable.
  objective: Type.String(),
  status: Type.Union(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].map(value => Type.Literal(value))),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  tokensUsed: Type.Number({ minimum: 0 }),
  remainingTokens: Type.Optional(Type.Number()),
  timeUsedSeconds: Type.Number({ minimum: 0 }),
  createdAt: Type.String(), updatedAt: Type.String(), activeStartedAt: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const GET_GOAL_OUTPUT = Type.Object({ goal: Type.Union([summary, Type.Null()]) }, { additionalProperties: false });
export const CREATE_GOAL_OUTPUT = Type.Object({ goal: summary }, { additionalProperties: false });

export function goalResult(goal: GoalSummary | null) {
  const text = JSON.stringify({ goal }, null, 2);
  const payload = JSON.parse(text);
  return {
    content: [{ type: "text" as const, text: goal ? text : "No goal is set." }],
    structuredContent: payload,
    details: payload,
  };
}
