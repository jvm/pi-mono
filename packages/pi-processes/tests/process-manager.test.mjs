import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth, TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import { ProcessRuntime } from "../src/runtime.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { ProcessPanel } from "../src/process-panel.ts";
import { ProcessDisplay } from "../src/process-widget.ts";

async function eventually(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(20); }
  assert.ok(check(), "expected process/UI transition");
}
const spawn = (rt, command, mode = "foreground", timeout = 5000, title) =>
  rt.start(command, process.cwd(), false, timeout, false, mode === "foreground" ? timeout + 1000 : 0,
    16_000, undefined, mode === "background" ? "steer" : undefined, { mode, title });

function setup(t, limits) {
  const statuses = new Map();
  let display;
  const rt = new ProcessRuntime(undefined, limits, () => display?.sync());
  display = new ProcessDisplay({ mode: "tui", ui: {
    setStatus: (key, value) => statuses.set(key, value), setWidget() {},
  } }, rt);
  let closed = 0, redraws = 0;
  const removed = [];
  const manager = new ProcessManager(rt, ids => removed.push(...ids), () => closed++,
    () => redraws++, () => 20);
  t.after(async () => { manager.dispose(); display.dispose(); await rt.close(); });
  return { rt, manager, statuses, removed, closed: () => closed, redraws: () => redraws,
    text: () => manager.render(200).join("\n") };
}

test("viewing/acknowledging running output cannot suppress a later failure", async t => {
  const h = setup(t);
  const job = await spawn(h.rt, "sleep 0.2; printf failure-output; exit 7", "service");
  h.manager.handleInput("\r");
  h.manager.handleInput("a");
  h.manager.handleInput("A");
  await eventually(() => h.rt.views()[0]?.attention === "needs_attention");
  assert.match(h.statuses.get("pi-processes-results"), /1 process result.*need attention/);
  h.manager.handleInput("r");
  assert.match(h.text(), /failure-output/);
  h.manager.handleInput("\x1b");
  assert.equal(h.closed(), 0);
  assert.equal(h.rt.views()[0].attention, "needs_attention");
  // Model reads and model control on an already exited record do not acknowledge human attention.
  h.rt.output(job.session_id, 0, 1024);
  await h.rt.kill(job.session_id);
  assert.equal(h.rt.views()[0].attention, "needs_attention");
  h.manager.handleInput("a");
  assert.equal(h.rt.views()[0].attention, "acknowledged");
  assert.equal(h.statuses.get("pi-processes-results"), undefined);
  assert.equal(h.rt.output(job.session_id, 0, 1024).output, "failure-output");
  h.manager.handleInput("\x1b");
  assert.equal(h.closed(), 1);
});

test("attention sorts first; acknowledge all retains records and excludes future failures", async t => {
  const h = setup(t);
  await spawn(h.rt, "printf ok", "foreground", 5000, "Successful build");
  await spawn(h.rt, "exit 2", "foreground", 5000, "Failed test");
  const running = await spawn(h.rt, "sleep 30", "service", 5000, "Dev server");
  h.manager.handleInput("r");
  const text = h.text();
  assert.ok(text.indexOf("! Failed test") < text.indexOf("● Dev server"));
  assert.ok(text.indexOf("● Dev server") < text.indexOf("✓ Successful build"));
  assert.match(text, /service/);
  h.manager.handleInput("A");
  assert.equal(h.rt.views().filter(p => p.attention === "acknowledged").length, 1);
  assert.equal(h.rt.views().length, 3);
  await spawn(h.rt, "exit 3");
  assert.equal(h.rt.views().filter(p => p.attention === "needs_attention").length, 1);
  await h.rt.kill(running.session_id);
});

test("intentional stops are distinct from signals/timeouts and never clear an existing failure", async t => {
  const h = setup(t);
  const stopped = await spawn(h.rt, "sleep 30", "service");
  h.manager.handleInput("s");
  assert.match(h.text(), /y confirm/);
  h.manager.handleInput("\x1b");
  assert.equal(h.rt.views()[0].status, "running", "cancel must not signal");
  h.manager.handleInput("s");
  h.manager.handleInput("y");
  await eventually(() => h.rt.views()[0].stopped && h.rt.views()[0].status === "exited");
  assert.equal(h.rt.views()[0].attention, "none");
  assert.equal(h.rt.output(stopped.session_id, 0, 1024).stopped, true);
  const timed = await spawn(h.rt, "sleep 30", "service", 100);
  await eventually(() => h.rt.views().find(p => p.session_id === timed.session_id)?.status === "exited");
  assert.equal(h.rt.views().find(p => p.session_id === timed.session_id).attention, "needs_attention");
  const signal = await spawn(h.rt, "kill -TERM $$");
  assert.equal(h.rt.views().find(p => p.session_id === signal.session_id).attention, "needs_attention");
});

test("remove confirms, clears only owned completed output, and refuses live/pinned records", async t => {
  const h = setup(t);
  const done = await spawn(h.rt, "printf retained");
  const live = await spawn(h.rt, "sleep 30", "service");
  assert.throws(() => h.rt.remove(live.session_id), /Stop the process/);
  const release = h.rt.hold([done.session_id]);
  assert.throws(() => h.rt.remove(done.session_id), /in use/);
  assert.deepEqual(h.rt.clearCompleted(), []);
  release();
  assert.ok((await readdir(h.rt.logs.directory)).includes(done.session_id));
  // All-completed cleanup takes a snapshot and never stops the live service.
  h.manager.handleInput("D");
  h.manager.handleInput("\x1b");
  assert.equal(h.rt.views().length, 2);
  h.manager.handleInput("D");
  h.manager.handleInput("y");
  assert.deepEqual(h.removed, [done.session_id]);
  assert.throws(() => h.rt.output(done.session_id, 0, 1024), /Unknown process/);
  assert.deepEqual(await readdir(h.rt.logs.directory), [live.session_id]);
  assert.equal(h.rt.views()[0].status, "running");
  assert.throws(() => h.rt.remove("../../outside"), /Unknown process/);
});

test("remove works from output view; acknowledgment and cleanup are independent", async t => {
  const h = setup(t);
  const failed = await spawn(h.rt, "printf keep-until-remove; exit 1");
  h.manager.handleInput("\r");
  h.manager.handleInput("a");
  assert.equal(h.rt.views()[0].attention, "acknowledged");
  h.manager.handleInput("d");
  assert.match(h.text(), /retained output/);
  h.manager.handleInput("y");
  assert.equal(h.rt.views().length, 0, "the viewer must release its own pin before removal");
  assert.deepEqual(h.removed, [failed.session_id]);
  assert.match(h.text(), /No retained processes/);
});

test("cleanup skips external readers, preserves quota, and never stops a launch", async t => {
  const h = setup(t);
  const done = await spawn(h.rt, "printf preserved");
  const release = h.rt.hold([done.session_id]);
  const launching = spawn(h.rt, "sleep 0.15; printf pending", "foreground");
  h.manager.handleInput("D");
  h.manager.handleInput("y");
  assert.deepEqual(h.removed, []);
  assert.match(h.text(), /in use/);
  release();
  await launching;
  const completed = h.rt.views().map(p => p.session_id).sort();
  assert.deepEqual(h.rt.clearCompleted().sort(), completed);
  assert.equal(h.rt.views().length, 0);
});

test("unacknowledged failures are not silently evicted to admit new work", async t => {
  const h = setup(t, { active: 2, retained: 1, outputBytes: 1024, killGraceMs: 10 });
  const failure = await spawn(h.rt, "exit 1");
  await assert.rejects(spawn(h.rt, "printf rejected"), /acknowledge or remove/);
  assert.equal(h.rt.views()[0].session_id, failure.session_id);
  h.rt.acknowledge(failure.session_id);
  await spawn(h.rt, "printf admitted");
  assert.equal(h.rt.views().length, 1);
});

test("follow is live and bounded; scrolling pauses it; refresh retains the selected tail", () => {
  let output = "first\nsecond\nthird", reads = [];
  const panel = new ProcessPanel((cursor, tail) => {
    reads.push([cursor, tail]);
    return { session_id: "owned", status: "running", exit_code: null, signal: null, timed_out: false,
      output, dropped_bytes: 0, unread_bytes: 0 };
  }, () => {}, () => {}, () => 8);
  panel.handleInput("f");
  assert.equal(panel.followsOutput, true);
  output += "\nlatest";
  panel.refresh(true);
  assert.match(panel.render(100).join("\n"), /latest/);
  panel.handleInput("\x1b[A");
  assert.equal(panel.followsOutput, false);
  output += "\nnot-followed";
  panel.refresh(true);
  assert.doesNotMatch(panel.render(100).join("\n"), /not-followed/);
  panel.handleInput("r");
  assert.deepEqual(reads.at(-1), [0, true]);
  panel.handleInput("f");
  assert.match(panel.render(100).join("\n"), /not-followed/);
});

test("live screen coalesces output updates, honors selection keys, bounds rows and releases timers", async t => {
  const h = setup(t);
  const job = await spawn(h.rt, "printf first; sleep 0.2; printf latest", "service");
  h.manager.handleInput("\r");
  h.manager.handleInput("f");
  await eventually(() => h.text().includes("latest"));
  assert.ok(h.redraws() > 0);
  for (const width of [1, 4, 20, 80]) {
    assert.ok(h.manager.render(width).length <= 20);
    assert.ok(h.manager.render(width).every(line => visibleWidth(line) <= width));
  }
  h.manager.handleInput("?");
  assert.match(h.text(), /Acknowledgment keeps output/);
  h.manager.handleInput("\x1b");
  h.manager.dispose();
  await delay(150);
  const before = h.redraws();
  await delay(1100);
  assert.equal(h.redraws(), before);
  assert.equal(h.rt.output(job.session_id, 0, 1024).output, "firstlatest");
  h.rt.remove(job.session_id); // dispose released the viewer pin
});

test("an open human viewer never blocks or consumes automatic completion", async t => {
  const delivered = [];
  const rt = new ProcessRuntime(result => delivered.push(result));
  const manager = new ProcessManager(rt, () => {}, () => {}, () => {}, () => 12);
  t.after(async () => { manager.dispose(); await rt.close(); });
  const job = await spawn(rt, "sleep 0.2; printf delivered-with-viewer-open", "background");
  manager.handleInput("\r");
  await eventually(() => delivered.length === 1);
  assert.equal(delivered[0].output, "delivered-with-viewer-open");
  assert.throws(() => rt.remove(job.session_id), /in use/, "the UI still protects retention");
  manager.handleInput("\x1b");
  assert.equal(rt.output(job.session_id, 0, 1024).output, "delivered-with-viewer-open");
  rt.remove(job.session_id);
});

test("custom selection keybindings work in the list, output, and help", async t => {
  const rt = new ProcessRuntime();
  await spawn(rt, "printf first", "foreground", 5000, "First");
  await spawn(rt, "printf second", "foreground", 5000, "Second");
  let closed = false;
  const keys = { matches: (input, action) => input === {
    "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "v", "tui.select.cancel": "q",
  }[action] };
  const manager = new ProcessManager(rt, () => {}, () => { closed = true; }, () => {}, () => 8, keys);
  t.after(async () => { manager.dispose(); await rt.close(); });
  manager.handleInput("j");
  assert.match(manager.render(100).join("\n"), /> ✓ First/);
  manager.handleInput("v");
  assert.match(manager.render(100).join("\n"), /Follow: off/);
  manager.handleInput("q");
  assert.equal(closed, false);
  manager.handleInput("?");
  for (let n = 0; n < 10; n++) manager.handleInput("j");
  assert.match(manager.render(100).join("\n"), /does not change model delivery|pending automatic delivery/);
  assert.ok(manager.render(100).length <= 8);
  manager.handleInput("q");
  manager.handleInput("q");
  assert.equal(closed, true);
});

for (const Engine of [TuiMainScreen, TuiAltScreen]) {
  test(`${Engine.name} renders the live manager and survives narrow resize`, async t => {
    const h = setup(t);
    await spawn(h.rt, "exit 1", "foreground", 5000, "界 test");
    const terminal = { columns: 80, rows: 20, kittyProtocolActive: false,
      start(input, resize) { this.input = input; this.resize = resize; }, stop() {}, async drainInput() {},
      write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
    const tui = new Engine(terminal);
    tui.addChild(h.manager);
    tui.start();
    try {
      h.manager.handleInput("r");
      for (const width of [1, 8, 40, 80]) {
        terminal.columns = width;
        terminal.resize();
        tui.renderNow();
        assert.ok(h.manager.render(width).every(line => visibleWidth(line) <= width));
      }
    } finally { tui.stop(); }
  });
}
