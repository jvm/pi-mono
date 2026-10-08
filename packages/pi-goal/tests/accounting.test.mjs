import assert from "node:assert/strict";
import test from "node:test";
import { accountUsageFromBranch } from "../src/accounting.ts";
import { applyGoalMutation, reconstructGoalState } from "../src/state.ts";

const at = "2026-07-01T00:00:00.000Z";
const end = Date.parse(at) + 1000;
const create = { schemaVersion: 1, kind: "create", goalId: "fixture", objective: "Fixture", at };
const custom = (id, data) => ({ type: "custom", customType: "pi-goal", id, timestamp: data.at, data });
const start = custom("start", create);
const usage = (totalTokens) => ({ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens });
const message = (id, role, tokens, extra = {}) => ({
  type: "message", id, timestamp: at, message: { role, usage: usage(tokens), ...extra },
});
const scan = (entries, goal = applyGoalMutation(null, create)) => accountUsageFromBranch(goal, entries, end);

test("counts supported billing entries once, including failed and cancelled tool results", () => {
  const branch = [
    start, message("assistant", "assistant", 22),
    message("tool", "toolResult", 500, { nestedCalls: { calls: [{ usage: usage(500) }] } }),
    message("failed", "toolResult", 5, { isError: true }),
    message("cancelled", "toolResult", 7, { isError: true }),
    ...["usage", "compaction", "branch_summary"].map((type) => ({ type, id: type, timestamp: at, usage: usage(10) })),
    message("user", "user", 999),
  ];
  branch.push(branch[2]);
  const first = scan(branch);
  assert.equal(first.addedTokens, 564);
  assert.equal(first.addedEntryIds.length, 7);
  assert.equal(scan(branch, first.goal).addedTokens, 0);
  const reconstructed = reconstructGoalState([...branch, custom("account", first.mutation)]);
  assert.equal(scan(branch, reconstructed).addedTokens, 0);
});

test("uses creation order and timestamps, then closes at replacement or clear", () => {
  for (const kind of ["replace", "clear"]) {
    const branch = [
      message("same-ms-before", "assistant", 1000), start,
      { ...message("old", "assistant", 1000), timestamp: "2026-06-30T23:59:59Z" },
      { ...message("invalid", "assistant", 1000), timestamp: "bad" },
      { ...message("future", "assistant", 1000), timestamp: "2026-07-02T00:00:00Z" },
      custom("malformed-clear", { kind: "clear", at }),
      message("ours", "toolResult", 5),
      custom("end", { ...create, kind, goalId: "next" }),
      message("later", "assistant", 1000),
    ];
    assert.equal(scan(branch).addedTokens, 5);
  }
});

test("pause, resume, and terminal status stop continuation, not lifetime accounting", () => {
  const branch = [start];
  for (const [index, status] of ["paused", "active", "budget_limited", "usage_limited", "blocked", "complete"].entries()) {
    branch.push(custom(`status-${index}`, { ...create, kind: "status", status }));
    branch.push(message(`usage-${index}`, "toolResult", 10));
  }
  assert.equal(scan(branch).addedTokens, 60);
});

test("raw billing history survives context omission, compaction, and independent branches", () => {
  const shared = [start, message("shared", "assistant", 22)];
  const once = scan(shared);
  shared.push(custom("account", once.mutation));
  const branchA = [...shared, message("a", "toolResult", 500),
    { type: "context_edit", id: "edit", targetId: "a", replacement: null },
    { type: "compaction", id: "compact", timestamp: at, usage: usage(10) }];
  const branchB = [...shared, message("b", "toolResult", 30)];
  assert.equal(scan(branchA, reconstructGoalState(branchA)).goal.tokensUsed, 532);
  assert.equal(scan(branchB, reconstructGoalState(branchB)).goal.tokensUsed, 52);
  assert.equal(scan(shared, reconstructGoalState(shared)).goal.tokensUsed, 22);
});

test("schema-v1 assistant accounting is retained while missing usage is backfilled", () => {
  const legacy = { ...create, kind: "account", tokens: 22, entryIds: ["assistant"],
    meta: { accounting: { scannedAssistantEntries: 1 } } };
  const branch = [start, message("assistant", "assistant", 22), message("tool", "toolResult", 500), custom("legacy", legacy)];
  const result = scan(branch, reconstructGoalState(branch));
  assert.equal(result.goal.tokensUsed, 522);
  assert.deepEqual(result.addedEntryIds, ["tool"]);
  assert.equal(result.mutation.schemaVersion, 1);
});

test("malformed usage is bounded to nonnegative finite numeric fields", () => {
  const branch = [start, ...[
    null, "bad", {}, { totalTokens: -10 }, { totalTokens: 2.9 },
    { totalTokens: NaN, input: 3.9, output: -2, cacheRead: 4, cacheWrite: Infinity },
    { input: "20", output: 1 },
  ].map((value, index) => ({ type: "usage", id: `usage-${index}`, timestamp: at, usage: value }))];
  assert.equal(scan(branch).addedTokens, 10);
  assert.deepEqual(scan(branch).addedEntryIds, ["usage-4", "usage-5", "usage-6"]);
});
