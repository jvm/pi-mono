import assert from "node:assert/strict";
import test from "node:test";

import {
  DcgClient,
  isRecommendedDcgVersion,
  MINIMUM_RECOMMENDED_DCG_VERSION,
} from "../src/dcg-client.ts";

function makeConfig(overrides = {}) {
  return {
    binary: "/opt/dcg",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    onError: "allow",
    guardUserBash: true,
    ...overrides,
  };
}

test("sends a Pi-identified, cwd-aware hook request", async () => {
  let request;
  const executor = async (value) => {
    request = value;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const client = new DcgClient(makeConfig(), executor, {
    DCG_PACKS: "database",
    DCG_SELF_HEAL_HOOK: "true",
  });

  assert.deepEqual(await client.check("git status", "/work/project"), { decision: "allow" });
  assert.equal(request.command, "/opt/dcg");
  assert.deepEqual(request.args, []);
  assert.equal(request.cwd, "/work/project");
  assert.equal(request.env.PI_CODING_AGENT, "true");
  assert.equal(request.env.DCG_NO_SELF_HEAL, "1");
  assert.equal(request.env.DCG_NO_COLOR, "1");
  assert.equal(request.env.DCG_PACKS, "database");
  assert.equal(request.env.DCG_SELF_HEAL_HOOK, "true");

  const payload = JSON.parse(request.input);
  assert.deepEqual(payload, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    cwd: "/work/project",
  });
});

test("parses a hook denial from stdout even though hook exit is zero", async () => {
  const executor = async () => ({
    stdout: JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: "deny",
        ruleId: "core.git:reset-hard",
      },
    }),
    stderr: "human warning that must not be parsed",
    exitCode: 0,
  });
  const result = await new DcgClient(makeConfig(), executor).check("git reset --hard", "/work");
  assert.equal(result.decision, "deny");
  assert.equal(result.hook.ruleId, "core.git:reset-hard");
});

test("treats nonzero hook exit as a bridge failure", async () => {
  const executor = async () => ({ stdout: "", stderr: "secret command text", exitCode: 4 });
  await assert.rejects(
    new DcgClient(makeConfig(), executor).check("command", "/work"),
    /exit code 4/,
  );
});

test("probes a bounded version command", async () => {
  let request;
  const executor = async (value) => {
    request = value;
    return { stdout: "dcg v0.6.8\n", stderr: "artwork", exitCode: 0 };
  };
  const client = new DcgClient(makeConfig({ timeoutMs: 9000 }), executor);
  assert.deepEqual(await client.probe("/work"), { version: "0.6.8" });
  assert.deepEqual(request.args, ["--version"]);
  assert.equal(request.timeoutMs, 1500);
});

test("recognizes the recommended dcg version floor", () => {
  assert.equal(MINIMUM_RECOMMENDED_DCG_VERSION, "0.6.8");
  assert.equal(isRecommendedDcgVersion("0.6.7"), false);
  assert.equal(isRecommendedDcgVersion("0.6.8"), true);
  assert.equal(isRecommendedDcgVersion("v0.7.0"), true);
  assert.equal(isRecommendedDcgVersion("unknown"), false);
});
