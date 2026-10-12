import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import piProcesses from "../extensions/index.ts";
import { ProcessRuntime } from "../src/runtime.ts";
import { ProcessWidget, WIDGET_KEY } from "../src/process-widget.ts";
import { commandPreview } from "../src/display-text.ts";
import { fixture, textOf } from "../../pi-dcg/tests/session-fixture.mjs";

const dataOf = result => result.structuredContent ?? JSON.parse(textOf(result));
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.ok(check(), "state did not settle");
}
function terminal() {
  return {
    columns: 100, rows: 30, kittyProtocolActive: false, output: "",
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() {}, async drainInput() {}, write(text) { this.output += text; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
}

for (const [mode, Engine] of [["regular", TuiMainScreen], ["fullscreen", TuiAltScreen]]) {
  test(`real Pi ${mode} widget shows only background work, updates idle, and clears on exit/reload`, async t => {
    const term = terminal();
    const tui = new Engine(term);
    const widgets = new Map();
    const neighbor = new Text("Unrelated widget", 0, 0);
    widgets.set("neighbor", neighbor);
    tui.addChild(neighbor);
    let redraws = 0;
    const requestRender = tui.requestRender.bind(tui);
    tui.requestRender = () => { redraws++; requestRender(); };
    const updates = [];
    const h = await fixture(t, {
      uiMode: "tui", after: [piProcesses], uiContext: {
        setWidget(key, content, options) {
          updates.push({ key, content, options });
          const old = widgets.get(key);
          if (old) { old.dispose?.(); tui.removeChild(old); widgets.delete(key); }
          if (content) {
            const widget = content(tui);
            widgets.set(key, widget);
            tui.addChild(widget);
          }
          tui.requestRender();
        },
      },
    });
    tui.start();
    try {
      await h.run("exec_command", { cmd: "printf foreground" });
      assert.ok(!widgets.has(WIDGET_KEY), "foreground calls must not flash a background widget");
      const first = dataOf(await h.run("exec_command", { cmd: "sleep 30", yield_time_ms: 0 }));
      const second = dataOf(await h.run("exec_command", {
        cmd: "printf 'unread-output\\n'; read -r answer", tty: true, yield_time_ms: 0,
      }));
      const widget = widgets.get(WIDGET_KEY);
      assert.ok(widget, "the extension must wire runtime events to setWidget");
      const lines = () => widget.render(120).join("\n");
      assert.match(lines(), /Background processes · 2/);
      assert.match(lines(), new RegExp(first.session_id.slice(0, 8)));
      assert.match(lines(), /pipe/);
      assert.match(lines(), /PTY/);
      assert.doesNotMatch(lines(), /^unread-output$/m, "process output is not rendered");
      assert.equal(updates[0].options.placement, "aboveEditor");
      for (const palette of ["dark", "light", "system"]) {
        initTheme(palette, false);
        tui.invalidate();
        for (const width of [1, 3, 12, 40, 120]) {
          term.columns = width;
          term.resize();
          for (const line of widget.render(width)) {
            assert.ok(visibleWidth(line) <= width, `${mode} widget exceeds width ${width}`);
            assert.equal(line.replace(/\x1b\[0m/g, ""), stripVTControlCharacters(line),
              "only Pi's truncation resets, not stored palette/control escapes");
          }
          tui.renderNow();
        }
      }
      const before = redraws;
      await delay(1100);
      assert.ok(redraws > before, "elapsed time refreshes while Pi is idle");
      assert.match(lines(), /[1-9]\d*s/);
      const polled = dataOf(await h.run("write_stdin", { session_id: second.session_id, yield_time_ms: 0 }));
      assert.match(second.output + polled.output, /unread-output/, "rendering must not consume tool output");
      await h.run("process_kill", { session_id: first.session_id });
      assert.match(lines(), /Background processes · 1/);
      await h.run("process_kill", { session_id: second.session_id });
      assert.ok(!widgets.has(WIDGET_KEY));
      assert.equal(widgets.get("neighbor"), neighbor);
      const quiet = redraws;
      await delay(1100);
      assert.equal(redraws, quiet, "the last exit stops the widget clock");

      await h.run("exec_command", { cmd: "sleep 0.3", yield_time_ms: 0 });
      assert.ok(widgets.has(WIDGET_KEY));
      await eventually(() => !widgets.has(WIDGET_KEY)); // no polling or extra model turn
      await h.run("exec_command", { cmd: "sleep 30", yield_time_ms: 0 });
      await h.session.reload();
      assert.ok(!widgets.has(WIDGET_KEY));
      assert.equal(widgets.get("neighbor"), neighbor);
      assert.deepEqual(h.errors, []);
      assert.ok(term.output.length > 0);
    } finally {
      await h.close();
      tui.stop();
    }
  });
}

test("PTY background remains visible after rejecting input; approval still controls every write", async t => {
  let widget;
  let approve = false;
  const h = await fixture(t, { uiMode: "tui", after: [piProcesses], confirm: async () => approve, uiContext: {
    setWidget(_key, content) {
      widget?.dispose();
      widget = content?.({ requestRender() {} });
    },
  } });
  const job = dataOf(await h.run("exec_command", {
    cmd: "read -r answer; printf 'received:%s' \"$answer\"", tty: true, yield_time_ms: 0,
  }));
  assert.ok(widget);
  assert.equal((await h.run("write_stdin", { session_id: job.session_id, chars: "rejected\n" })).isError, true);
  assert.match(widget.render(100).join("\n"), /PTY/);
  approve = true;
  const done = dataOf(await h.run("write_stdin", { session_id: job.session_id, chars: "approved\n", yield_time_ms: 1000 }));
  assert.match(done.output, /received:approved/);
  assert.ok(!widget);
  assert.equal(h.confirmations.length, 2);
});

for (const uiMode of ["print", "json", "rpc"]) {
  test(`${uiMode} does not create or update terminal widgets`, async t => {
    let calls = 0;
    const h = await fixture(t, { uiMode, after: [piProcesses], uiContext: {
      setWidget() { calls++; },
    } });
    const job = dataOf(await h.run("exec_command", { cmd: "sleep 30", yield_time_ms: 0 }));
    await h.run("process_kill", { session_id: job.session_id });
    await h.session.reload();
    assert.equal(calls, 0);
  });
}

test("runtime background snapshots are metadata-only, detached-only, and exit-driven", async t => {
  const cwd = process.cwd();
  let changes = 0;
  const rt = new ProcessRuntime(undefined, undefined, () => changes++);
  t.after(() => rt.close());
  const foreground = rt.start("sleep 0.2", cwd, false, 5000, false, 1000, 1024);
  await delay(30);
  assert.deepEqual(rt.background(), []);
  await foreground;
  const job = await rt.start("printf retained; sleep 0.2", cwd, false, 5000, false, 0, 1024);
  assert.equal(rt.background().length, 1);
  assert.deepEqual(Object.keys(rt.background()[0]).sort(), ["command_preview", "session_id", "started_at", "tty"]);
  const before = changes;
  await eventually(() => !rt.background().length);
  assert.ok(changes > before);
  assert.equal(job.output + (await rt.poll(job.session_id, 0, 1024)).output, "retained");
  await rt.start("sleep 30", cwd, false, 100, false, 0, 1024);
  await eventually(() => !rt.background().length);
  const abort = new AbortController();
  const initial = rt.start("sleep 30", cwd, false, 5000, false, 5000, 1024, abort.signal);
  abort.abort();
  await assert.rejects(initial, /cancel/);
  assert.deepEqual(rt.background(), []);
});

test("display callback failures never change process results", async t => {
  const rt = new ProcessRuntime(undefined, undefined, () => { throw new Error("UI unavailable"); });
  t.after(() => rt.close());
  const job = await rt.start("printf ok", process.cwd(), false, 5000, false, 1000, 1024);
  assert.equal(job.output, "ok");
});

test("widget teardown failure does not prevent session-owned process cleanup", async t => {
  let widget;
  const h = await fixture(t, { uiMode: "tui", after: [piProcesses], uiContext: {
    setWidget(_key, content) {
      if (!content) throw new Error("terminal already closed");
      widget = content({ requestRender() {} });
    },
  } });
  const job = dataOf(await h.run("exec_command", { cmd: "sleep 30", yield_time_ms: 0 }));
  assert.ok(widget);
  await h.session.reload();
  assert.equal((await h.run("write_stdin", { session_id: job.session_id, yield_time_ms: 0 })).isError, true);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
  assert.deepEqual(h.errors, []);
});

test("command previews escape controls/bidi and fit narrow Unicode terminals", () => {
  const preview = commandPreview("printf \x1b[31m\x07\n界 🦊 é\u202e");
  assert.doesNotMatch(preview, /[\x00-\x1f\x7f-\x9f\u202e]/);
  assert.match(preview, /\\u001b/);
  assert.match(preview, /\\u202e/);
  assert.ok(commandPreview("x".repeat(65_536)).length <= 257);
  const jobs = [{ session_id: "12345678-rest", command_preview: preview, tty: false, started_at: 0 }];
  const widget = new ProcessWidget(() => jobs, () => {}, () => 2500);
  try {
    assert.match(widget.render(200).join("\n"), /2s/);
    assert.deepEqual(widget.render(0), []);
    for (const width of [1, 2, 10, 25, 60]) {
      assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
    }
  } finally { widget.dispose(); }
});
