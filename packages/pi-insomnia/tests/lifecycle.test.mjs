import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";

const { default: piInsomnia } = await import("../extensions/index.ts");
const { MacSleepInhibitor, createSleepInhibitor } = await import("../src/sleep-inhibitor.ts");
const { LinuxSleepInhibitor } = await import("../src/linux-sleep-inhibitor.ts");
const { EventEmitter } = await import("node:events");
const { PassThrough } = await import("node:stream");

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

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.signals = [];
  child.unref = () => {};
  child.kill = (signal) => {
    child.killed = true;
    child.signals.push(signal);
    return true;
  };
  return child;
}

function makeLinux(overrides = {}) {
  const spawns = [];
  const inhibitor = new LinuxSleepInhibitor({
    platform: "linux",
    exists: () => true,
    spawn: (command, args) => {
      const child = makeFakeChild();
      spawns.push({ command, args, child });
      return child;
    },
    ...overrides,
  });
  return { inhibitor, spawns };
}

function makeTuiContext() {
  const statuses = [];
  const notices = [];
  return {
    statuses,
    notices,
    context: {
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: (key, value) => statuses.push({ key, value }),
        notify: (message, type) => notices.push({ message, type }),
      },
    },
  };
}

test("selects caffeinate on macOS and systemd-inhibit on Linux", () => {
  assert.ok(createSleepInhibitor("darwin") instanceof MacSleepInhibitor);
  assert.ok(createSleepInhibitor("linux") instanceof LinuxSleepInhibitor);
  assert.equal(createSleepInhibitor("win32").acquire(), false);
});

test("holds one systemd-inhibit lock from agent start until the agent settles", async () => {
  const { inhibitor, spawns } = makeLinux();
  const pi = makePi();
  const { context, statuses, notices } = makeTuiContext();
  piInsomnia(pi, inhibitor);

  await emit(pi, "agent_start", context);
  await emit(pi, "agent_start", context);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "/usr/bin/systemd-inhibit");
  assert.deepEqual(spawns[0].args, [
    "--what=idle:sleep",
    "--who=pi-insomnia",
    "--why=Pi agent is working",
    "--mode=block",
    "--no-ask-password",
    "/usr/bin/cat",
  ]);
  assert.deepEqual(statuses.at(-1), { key: "pi-insomnia", value: "\u{f0176}" });

  await emit(pi, "agent_settled", context);
  assert.deepEqual(spawns[0].child.signals, ["SIGTERM"]);
  assert.equal(spawns[0].child.stdin.destroyed, true);
  assert.equal(statuses.at(-1).value, undefined);
  // Our own SIGTERM must not be reported as a refusal.
  spawns[0].child.emit("exit", null, "SIGTERM");
  assert.equal(notices.length, 0);

  await emit(pi, "agent_start", context);
  assert.equal(spawns.length, 2);
  await emit(pi, "session_shutdown", context);
  assert.deepEqual(spawns[1].child.signals, ["SIGTERM"]);
  assert.equal(inhibitor.isInhibiting, false);
});

test("notifies once and stops retrying when systemd-inhibit refuses the lock", async () => {
  const { inhibitor, spawns } = makeLinux();
  const pi = makePi();
  const { context, statuses, notices } = makeTuiContext();
  piInsomnia(pi, inhibitor);

  await emit(pi, "agent_start", context);
  spawns[0].child.stderr.write("Failed to inhibit: Access denied\nmore detail\n");
  await new Promise((resolve) => setImmediate(resolve));
  spawns[0].child.emit("exit", 1, null);

  assert.equal(inhibitor.isInhibiting, false);
  assert.equal(statuses.at(-1).value, undefined);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].message, /refused.*Failed to inhibit: Access denied\)/);

  await emit(pi, "agent_settled", context);
  await emit(pi, "agent_start", context);
  assert.equal(spawns.length, 1);
  assert.equal(notices.length, 1);
});

test("notifies once when systemd-inhibit is missing", async () => {
  const { inhibitor, spawns } = makeLinux({ exists: (path) => path.endsWith("/cat") });
  const pi = makePi();
  const { context, statuses, notices } = makeTuiContext();
  piInsomnia(pi, inhibitor);

  await emit(pi, "agent_start", context);
  await emit(pi, "agent_settled", context);
  await emit(pi, "agent_start", context);

  assert.equal(spawns.length, 0);
  assert.equal(statuses.some((status) => status.value !== undefined), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /systemd-inhibit` was not found/);
});

test("reports spawn errors without a notice outside the TUI", async () => {
  const { inhibitor, spawns } = makeLinux();
  const pi = makePi();
  piInsomnia(pi, inhibitor);
  const context = {
    mode: "print",
    hasUI: false,
    ui: { setStatus: () => assert.fail("no status outside TUI"), notify: () => assert.fail("no notice outside TUI") },
  };

  await emit(pi, "agent_start", context);
  spawns[0].child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
  assert.equal(inhibitor.isInhibiting, false);
  assert.equal(inhibitor.acquire(), false);
});

test("bounds retained systemd-inhibit stderr", async () => {
  const { inhibitor, spawns } = makeLinux();
  const messages = [];
  inhibitor.onUnavailable = (message) => messages.push(message);
  inhibitor.acquire();
  spawns[0].child.stderr.write("x".repeat(10_000));
  await new Promise((resolve) => setImmediate(resolve));
  spawns[0].child.emit("exit", 1, null);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].length < 300);
});
