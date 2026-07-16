import assert from "node:assert/strict";
import test from "node:test";

import { formatDcgDecision, parseDcgHookResponse } from "../src/protocol.ts";

test("treats empty hook stdout as allow", () => {
  assert.deepEqual(parseDcgHookResponse(" \n"), { decision: "allow" });
});

test("parses structured denial metadata without regex extraction", () => {
  const result = parseDcgHookResponse(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "BLOCKED by dcg\n\nReason: destructive reset\n\nCommand: git reset --hard",
      ruleId: "core.git:reset-hard",
      packId: "core.git",
      severity: "critical",
      confidence: 0.95,
      allowOnceCode: "123456",
      remediation: {
        safeAlternative: "git stash",
        explanation: "The explanation can contain JSON-like braces: {safe}.",
        allowOnceCommand: "dcg allow-once 123456",
      },
    },
  }));

  assert.equal(result.decision, "deny");
  assert.equal(result.hook.ruleId, "core.git:reset-hard");
  assert.equal(result.hook.remediation.safeAlternative, "git stash");

  const reason = formatDcgDecision(result);
  assert.match(reason, /^Blocked by dcg\./);
  assert.match(reason, /critical · core\.git:reset-hard · confidence 0\.95/);
  assert.match(reason, /Reason: destructive reset/);
  assert.match(reason, /Safer alternative: git stash/);
  assert.match(reason, /dcg allow-once 123456/);
  assert.doesNotMatch(reason, /Command: git reset/);
});

test("parses ask and explicit allow decisions", () => {
  const ask = parseDcgHookResponse(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "ask",
      permissionDecisionReason: "DCG warn: review this command",
      ruleId: "example:warning",
    },
  }));
  assert.equal(ask.decision, "ask");
  assert.match(formatDcgDecision(ask), /^dcg requires confirmation\./);

  assert.deepEqual(parseDcgHookResponse(JSON.stringify({
    hookSpecificOutput: { permissionDecision: "allow" },
  })), { decision: "allow" });
});

test("uses allow-once code when remediation is absent", () => {
  const result = parseDcgHookResponse(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "deny",
      allowOnceCode: "654321",
    },
  }));
  assert.match(formatDcgDecision(result), /dcg allow-once 654321/);
});

test("rejects malformed, unsupported, and unknown responses", () => {
  assert.throws(() => parseDcgHookResponse("not json"), /malformed JSON/);
  assert.throws(() => parseDcgHookResponse("{}"), /unsupported hook response/);
  assert.throws(
    () => parseDcgHookResponse(JSON.stringify({ hookSpecificOutput: { permissionDecision: "maybe" } })),
    /unknown permission decision/,
  );
});

test("bounds formatted denial text", () => {
  const result = parseDcgHookResponse(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: `Reason: ${"x".repeat(30_000)}`,
      remediation: { explanation: "y".repeat(30_000) },
    },
  }));
  assert.ok(formatDcgDecision(result).length <= 12_000);
});
