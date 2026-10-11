import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";

const { default: piInsomnia } = await import("../extensions/index.ts");
const { MacSleepInhibitor } = await import("../src/sleep-inhibitor.ts");

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function makeContext() {
  return {
    hasUI: false,
    ui: { setStatus() {} },
  };
}

function makeInhibitor() {
  return {
    acquireCalls: 0,
    releaseCalls: 0,
    forceStopCalls: 0,
    isInhibiting: false,
    acquire() {
      this.acquireCalls += 1;
      this.isInhibiting = true;
      return true;
    },
    release() {
      this.releaseCalls += 1;
      this.isInhibiting = false;
    },
    forceStop() {
      this.forceStopCalls += 1;
      this.isInhibiting = false;
    },
  };
}

async function emit(pi, event, context) {
  await pi.handlers.get(event)({}, context);
}

test("models repeated acquisition as one busy interval", () => {
  const inhibitor = new MacSleepInhibitor({
    platform: "darwin",
    caffeinatePath: "/usr/bin/true",
  });

  inhibitor.acquire();
  inhibitor.acquire();
  assert.equal(inhibitor.isActive, true);

  inhibitor.release();
  assert.equal(inhibitor.isActive, false);
  inhibitor.forceStop();
});

test("holds inhibition across retries until agent settles", async () => {
  const pi = makePi();
  const inhibitor = makeInhibitor();
  const context = makeContext();
  piInsomnia(pi, inhibitor);

  assert.equal(pi.handlers.has("agent_end"), false);
  await emit(pi, "agent_start", context);
  assert.equal(inhibitor.isInhibiting, true);

  await emit(pi, "agent_start", context);
  assert.equal(inhibitor.isInhibiting, true);
  assert.equal(inhibitor.releaseCalls, 0);

  await emit(pi, "agent_settled", context);
  assert.equal(inhibitor.isInhibiting, false);
  assert.equal(inhibitor.releaseCalls, 1);
});

test("holds inhibition across queued follow-up runs", async () => {
  const pi = makePi();
  const inhibitor = makeInhibitor();
  const context = makeContext();
  piInsomnia(pi, inhibitor);

  await emit(pi, "agent_start", context);
  await emit(pi, "agent_start", context);
  assert.equal(inhibitor.releaseCalls, 0);

  await emit(pi, "agent_settled", context);
  assert.equal(inhibitor.releaseCalls, 1);
});

test("forces cleanup on session shutdown", async () => {
  const pi = makePi();
  const inhibitor = makeInhibitor();
  const context = makeContext();
  piInsomnia(pi, inhibitor);

  await emit(pi, "agent_start", context);
  await emit(pi, "session_shutdown", context);

  assert.equal(inhibitor.forceStopCalls, 1);
  assert.equal(inhibitor.isInhibiting, false);
});

test("shows only the static coffee icon during TUI inhibition without animation timers", async (t) => {
  t.mock.method(globalThis, "setInterval", () => assert.fail("insomnia must not animate"));
  const pi = makePi();
  const inhibitor = makeInhibitor();
  const statuses = [];
  const context = {
    mode: "tui", hasUI: true,
    ui: { setStatus: (key, value) => statuses.push({ key, value }) },
  };
  piInsomnia(pi, inhibitor);
  await emit(pi, "agent_start", context);
  assert.deepEqual(statuses.at(-1), { key: "pi-insomnia", value: "\u{f0176}" });
  await emit(pi, "agent_start", context);
  assert.equal(statuses.at(-1).value, "\u{f0176}");
  assert.equal(inhibitor.releaseCalls, 0);
  await emit(pi, "agent_settled", context);
  assert.equal(statuses.at(-1).value, undefined);
  await emit(pi, "agent_start", context);
  await emit(pi, "session_shutdown", context);
  assert.equal(statuses.at(-1).value, undefined);
  assert.equal(inhibitor.forceStopCalls, 1);
});

test("does not show an awake icon when inhibition cannot be acquired", async () => {
  const pi = makePi();
  const inhibitor = makeInhibitor();
  inhibitor.acquire = () => false;
  piInsomnia(pi, inhibitor);
  await emit(pi, "agent_start", {
    mode: "tui", hasUI: true,
    ui: { setStatus: () => assert.fail("no icon without inhibition") },
  });
});
