import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";

const { default: piDcg } = await import("../extensions/index.ts");
const { DcgProcessError } = await import("../src/dcg-client.ts");

function makeConfig(overrides = {}) {
  return {
    binary: "dcg",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    onError: "allow",
    guardUserBash: true,
    ...overrides,
  };
}

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
}

function makeContext({ hasUI = false, confirm = false } = {}) {
  const notifications = [];
  const statuses = [];
  return {
    cwd: "/work/project",
    hasUI,
    mode: hasUI ? "tui" : "print",
    signal: undefined,
    notifications,
    statuses,
    ui: {
      theme: { fg: (_color, text) => text },
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => statuses.push({ key, value }),
      confirm: async () => confirm,
    },
  };
}

function makeClient({ decision = { decision: "allow" }, version = "0.6.8", error } = {}) {
  return {
    checks: [],
    probes: [],
    async check(command, cwd, signal) {
      this.checks.push({ command, cwd, signal });
      if (error) throw error;
      return decision;
    },
    async probe(cwd) {
      this.probes.push(cwd);
      if (error) throw error;
      return { version };
    },
  };
}

function bashEvent(command = "git status") {
  return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
}

async function emitToolCall(pi, event, context) {
  for (const handler of pi.handlers.get("tool_call") ?? []) {
    const result = await handler(event, context);
    if (result?.block) return result;
  }
  return undefined;
}

test("guards agent bash in Pi's cwd and ignores non-bash tools", async () => {
  const pi = makePi();
  const client = makeClient();
  const context = makeContext();
  piDcg(pi, { client, config: makeConfig() });

  const handler = pi.handlers.get("tool_call")[0];
  assert.equal(await handler({ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "x" } }, context), undefined);
  assert.equal(await handler(bashEvent(), context), undefined);
  assert.deepEqual(client.checks[0], { command: "git status", cwd: "/work/project", signal: undefined });
});

test("checks earlier command mutations and blocks later unchecked mutations", async () => {
  const earlierPi = makePi();
  const earlierClient = makeClient();
  earlierPi.on("tool_call", (event) => {
    event.input.command = "git reset --hard HEAD~1";
  });
  piDcg(earlierPi, { client: earlierClient, config: makeConfig() });

  await emitToolCall(earlierPi, bashEvent(), makeContext());
  assert.equal(earlierClient.checks[0].command, "git reset --hard HEAD~1");

  const laterPi = makePi();
  piDcg(laterPi, { client: makeClient(), config: makeConfig() });
  laterPi.on("tool_call", (event) => {
    event.input.command = "git reset --hard HEAD~1";
  });
  const event = bashEvent();

  await assert.rejects(
    emitToolCall(laterPi, event, makeContext()),
    /blocked a bash command mutation after its safety check/,
  );
  assert.equal(event.input.command, "git status");

  const replacementPi = makePi();
  piDcg(replacementPi, { client: makeClient(), config: makeConfig() });
  replacementPi.on("tool_call", (replacementEvent) => {
    replacementEvent.input = { command: "git reset --hard HEAD~1" };
  });

  await assert.rejects(
    emitToolCall(replacementPi, bashEvent(), makeContext()),
    /blocked a bash arguments replacement after its safety check/,
  );

  const duplicatePi = makePi();
  const firstClient = makeClient();
  const secondClient = makeClient();
  piDcg(duplicatePi, { client: firstClient, config: makeConfig() });
  piDcg(duplicatePi, { client: secondClient, config: makeConfig() });
  await emitToolCall(duplicatePi, bashEvent(), makeContext());
  assert.equal(firstClient.checks.length, 1);
  assert.equal(secondClient.checks.length, 1);
});

test("hard dcg denial always blocks with structured guidance", async () => {
  const pi = makePi();
  const client = makeClient({
    decision: {
      decision: "deny",
      hook: {
        permissionDecision: "deny",
        permissionDecisionReason: "Reason: destructive reset",
        ruleId: "core.git:reset-hard",
        severity: "critical",
        allowOnceCode: "123456",
      },
    },
  });
  const context = makeContext({ hasUI: true, confirm: true });
  piDcg(pi, { client, config: makeConfig() });

  const result = await pi.handlers.get("tool_call")[0](bashEvent("git reset --hard"), context);
  assert.equal(result.block, true);
  assert.match(result.reason, /Blocked by dcg/);
  assert.match(result.reason, /core\.git:reset-hard/);
  assert.doesNotMatch(result.reason, /allow-once/);
  assert.match(context.notifications.at(-1).message, /manually: dcg allow-once 123456/);
});

test("advisory UI failures cannot turn a denial into an allow", async () => {
  const pi = makePi();
  const client = makeClient({
    decision: {
      decision: "deny",
      hook: { permissionDecision: "deny", permissionDecisionReason: "Reason: destructive" },
    },
  });
  const context = makeContext({ hasUI: true });
  context.ui.setStatus = () => {
    throw new Error("status unavailable");
  };
  piDcg(pi, { client, config: makeConfig() });

  const result = await pi.handlers.get("tool_call")[0](bashEvent("git reset --hard"), context);
  assert.equal(result.block, true);
  assert.match(result.reason, /Blocked by dcg/);
});

test("asks only for dcg warning decisions", async () => {
  const warning = {
    decision: "ask",
    hook: {
      permissionDecision: "ask",
      permissionDecisionReason: "DCG warn: review",
      ruleId: "custom:warning",
    },
  };

  const approvedPi = makePi();
  piDcg(approvedPi, { client: makeClient({ decision: warning }), config: makeConfig() });
  assert.equal(
    await approvedPi.handlers.get("tool_call")[0](bashEvent("risky"), makeContext({ hasUI: true, confirm: true })),
    undefined,
  );

  const rejectedPi = makePi();
  piDcg(rejectedPi, { client: makeClient({ decision: warning }), config: makeConfig() });
  const rejected = await rejectedPi.handlers.get("tool_call")[0](bashEvent("risky"), makeContext({ hasUI: true, confirm: false }));
  assert.equal(rejected.block, true);
  assert.match(rejected.reason, /not approved/);

  const headlessPi = makePi();
  piDcg(headlessPi, { client: makeClient({ decision: warning }), config: makeConfig() });
  const headless = await headlessPi.handlers.get("tool_call")[0](bashEvent("risky"), makeContext());
  assert.equal(headless.block, true);
  assert.match(headless.reason, /No interactive UI/);
});

test("guards user bash with a synthetic failed result", async () => {
  const pi = makePi();
  const client = makeClient({
    decision: {
      decision: "deny",
      hook: { permissionDecision: "deny", permissionDecisionReason: "Reason: destructive" },
    },
  });
  piDcg(pi, { client, config: makeConfig() });

  const result = await pi.handlers.get("user_bash")[0]({
    type: "user_bash",
    command: "git reset --hard",
    cwd: "/other/project",
    excludeFromContext: false,
  }, makeContext());
  assert.equal(result.result.exitCode, 1);
  assert.match(result.result.output, /Blocked by dcg/);
  assert.equal(client.checks[0].cwd, "/other/project");
});

test("can disable user bash coverage", () => {
  const pi = makePi();
  piDcg(pi, { client: makeClient(), config: makeConfig({ guardUserBash: false }) });
  assert.equal(pi.handlers.has("user_bash"), false);
});

test("fails open visibly by default and can fail closed", async () => {
  const error = new Error("dcg unavailable");

  const openPi = makePi();
  piDcg(openPi, { client: makeClient({ error }), config: makeConfig({ onError: "allow" }) });
  const openContext = makeContext({ hasUI: true });
  assert.equal(await openPi.handlers.get("tool_call")[0](bashEvent(), openContext), undefined);
  assert.match(openContext.notifications[0].message, /allowed \(fail-open\)/);

  const closedPi = makePi();
  piDcg(closedPi, { client: makeClient({ error }), config: makeConfig({ onError: "block" }) });
  const closed = await closedPi.handlers.get("tool_call")[0](bashEvent(), makeContext());
  assert.equal(closed.block, true);
  assert.match(closed.reason, /PI_DCG_ON_ERROR=block/);
});

test("a cancelled check blocks even in fail-open mode", async () => {
  const pi = makePi();
  const error = new DcgProcessError("dcg check was cancelled", "aborted");
  piDcg(pi, { client: makeClient({ error }), config: makeConfig({ onError: "allow" }) });

  const result = await pi.handlers.get("tool_call")[0](bashEvent(), makeContext());
  assert.equal(result.block, true);
  assert.match(result.reason, /cancelled/);
});

test("probes on UI session start, exposes diagnostics, and clears status", async () => {
  const pi = makePi();
  const client = makeClient();
  const context = makeContext({ hasUI: true });
  piDcg(pi, { client, config: makeConfig() });

  await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, context);
  assert.deepEqual(client.probes, ["/work/project"]);
  assert.match(context.statuses.at(-1).value, /dcg 0\.6\.8/);

  await pi.commands.get("dcg").handler("", context);
  assert.match(context.notifications.at(-1).message, /Coverage: agent bash and user !\/!! commands \(RPC bash excluded\)/);

  await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, context);
  assert.equal(context.statuses.at(-1).value, undefined);
});

test("warns when the installed dcg is older than the recommended floor", async () => {
  const pi = makePi();
  const context = makeContext({ hasUI: true });
  piDcg(pi, { client: makeClient({ version: "0.6.7" }), config: makeConfig() });

  await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, context);
  assert.match(context.notifications[0].message, /0\.6\.8 or newer is recommended/);
});
