import assert from "node:assert/strict";
import test from "node:test";
import { formatGoalFooter, formatWidget } from "../src/commands.ts";
import { applyGoalMutation, createGoalMutation } from "../src/state.ts";

const states = {
  active: "\u{f040a}",
  paused: "\u{f03e4}",
  blocked: "\u{f033e}",
  usage_limited: "\u{f051f}",
  budget_limited: "\u{f0199}",
  complete: "\u{f012c}",
};

test("goal footer distinguishes every state and retains numbers without changing widget text", () => {
  const goal = applyGoalMutation(null, createGoalMutation("Synthetic goal", 50_000));
  assert.equal(new Set(Object.values(states)).size, 6);
  assert.equal(formatGoalFooter(null), undefined);
  for (const [status, icon] of Object.entries(states)) {
    const state = { ...goal, status, tokensUsed: 12_000 };
    assert.equal(formatGoalFooter(state), `\u{f08c9} ${icon} 12k/50k`);
    assert.equal(formatGoalFooter({ ...state, tokenBudget: undefined }), `\u{f08c9} ${icon}`);
    assert.equal(formatGoalFooter({ ...state, tokensUsed: 125, tokenBudget: 500 }), `\u{f08c9} ${icon} 125/500`);
    if (status === "active") {
      assert.equal(formatWidget(state)[0], "Goal: Synthetic goal");
      assert.match(formatWidget(state)[1], /^Usage: tokens 12k\/50k, time .*\/goal pause to stop$/);
    } else {
      assert.equal(formatWidget(state), undefined);
    }
  }
  assert.equal(formatGoalFooter({ ...goal, status: "budget_limited", tokensUsed: 52_000 }), "\u{f08c9} \u{f0199} 52k/50k");
});
