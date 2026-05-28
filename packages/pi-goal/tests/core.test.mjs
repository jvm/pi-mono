import test from "node:test";
import assert from "node:assert/strict";
import { accountUsageFromBranch, assistantUsageTokens, buildGoalContextMessage, createGoalMutation, formatElapsed, formatTokensCompact, parseGoalCommand, reconstructGoalState, validateObjective, validateTokenBudget } from "../src/index.ts";

test("validation rejects empty and long objectives", () => {
  assert.equal(validateObjective("  ").ok, false);
  assert.equal(validateObjective("x".repeat(4001)).ok, false);
  assert.deepEqual(validateObjective(" do it "), { ok: true, value: "do it" });
});

test("budget validation requires positive integers", () => {
  assert.equal(validateTokenBudget(0).ok, false);
  assert.equal(validateTokenBudget(1.2).ok, false);
  assert.deepEqual(validateTokenBudget(undefined, { allowEmpty: true }), { ok: true, value: undefined });
  assert.deepEqual(validateTokenBudget("500"), { ok: true, value: 500 });
});

test("formats usage compactly", () => {
  assert.equal(formatTokensCompact(999), "999");
  assert.equal(formatTokensCompact(1200), "1.2k");
  assert.equal(formatElapsed(3661), "1h 1m");
});

test("parses goal commands", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand("pause"), { action: "pause" });
  assert.deepEqual(parseGoalCommand("budget clear"), { action: "clearBudget" });
  assert.deepEqual(parseGoalCommand("budget 100"), { action: "setBudget", tokenBudget: 100 });
  assert.deepEqual(parseGoalCommand("--budget 100 build x"), { action: "createOrReplace", tokenBudget: 100, objective: "build x" });
});

test("reconstructs branch state from custom entries", () => {
  const create = createGoalMutation("ship it", 1000);
  const goal = reconstructGoalState([{ type: "custom", customType: "pi-goal", id: "1", data: create }]);
  assert.equal(goal.objective, "ship it");
  assert.equal(goal.status, "active");
  assert.equal(goal.tokenBudget, 1000);
});

test("accounts assistant usage once", () => {
  const create = createGoalMutation("ship it");
  const goal = reconstructGoalState([{ type: "custom", customType: "pi-goal", id: "1", timestamp: create.at, data: create }]);
  const branch = [
    { type: "custom", customType: "pi-goal", id: "1", timestamp: create.at, data: create },
    { type: "message", id: "a", timestamp: create.at, message: { role: "assistant", usage: { totalTokens: 42 } } },
  ];
  const result = accountUsageFromBranch(goal, branch);
  assert.equal(result.addedTokens, 42);
  const again = accountUsageFromBranch(result.goal, branch);
  assert.equal(again.addedTokens, 0);
});

test("extracts usage fallback fields", () => {
  assert.equal(assistantUsageTokens({ role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }), 10);
});

test("prompt includes strict goal instructions", () => {
  const create = createGoalMutation("verify all requirements");
  const goal = reconstructGoalState([{ type: "custom", customType: "pi-goal", id: "1", data: create }]);
  const prompt = buildGoalContextMessage(goal, "continue");
  assert.match(prompt, /objective below is user-provided task data/);
  assert.match(prompt, /update_goal\(\{ status: "complete" \}\)/);
});
