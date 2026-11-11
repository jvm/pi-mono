import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import piProcesses from "../extensions/index.ts";
import { LiveProcessCards } from "../src/live-process-cards.ts";
import { changes, fixture, textOf, until } from "./process-fixture.mjs";

const dataOf = r => r.structuredContent ?? r.details ?? JSON.parse(textOf(r));
// Waits use lifecycle events, not a polling window; `until` rejects a missing
// event, with the rendered card, before this test timeout.
const bounded = { timeout: 30_000 };
function terminal() {
  return {
    columns: 100, rows: 30, kittyProtocolActive: false, output: "",
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() {}, async drainInput() {}, write(text) { this.output += text; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
}
async function cardFixture(t, Engine, args) {
  initTheme("dark", false);
  args = { title: "Live card test", ...args };
  const h = await fixture(t, { after: [piProcesses], uiMode: "tui" });
  const term = terminal();
  const tui = new Engine(term);
  let redraws = 0;
  // Redraw requests and session events are the signals the card and completion depend on.
  const changed = changes();
  const requestRender = tui.requestRender.bind(tui);
  tui.requestRender = (...args) => { redraws++; requestRender(...args); changed.notify(); };
  const launched = await h.run("bash", args);
  const original = structuredClone(launched);
  const card = new ToolExecutionComponent("bash", "launch-card", args, {},
    h.session.getToolDefinition("bash"), tui, h.ctx.cwd);
  card.updateResult({ ...launched, isError: false });
  tui.addChild(card);
  tui.start();
  t.after(() => tui.stop());
  t.after(h.session.subscribe(() => changed.notify()));
  return { ...h, term, tui, card, launched, original, redraws: () => redraws,
    until: check => until(changed.subscribe, check, { describe: lines }),
    lines };
  function lines() { return stripVTControlCharacters(card.render(100).join("\n")); }
}

for (const Engine of [TuiMainScreen, TuiAltScreen]) {
  for (const code of [0, 7]) {
    test(`${Engine.name} launch card updates in place on exit ${code} without polling or changing model output`, bounded, async t => {
      const h = await cardFixture(t, Engine, {
        command: `while ! test -f finish; do sleep 0.02; done; printf late-output; exit ${code}`,
        mode: "background",
      });
      assert.match(h.lines(), /running/);
      const before = h.redraws();
      await writeFile(join(h.ctx.cwd, "finish"), "");
      const expected = code === 0 ? /done ·/ : /exit 7 ·/;
      await h.until(() => expected.test(h.lines()));
      assert.ok(h.redraws() > before, "runtime exit must request a redraw of the tool row");
      assert.doesNotMatch(h.lines(), /running|late-output/, "update the heading, not the original output preview");
      await h.until(() => h.session.messages.some(m => m.customType === "pi-processes-completed"));
      await h.session.waitForIdle();
      const completed = h.session.messages.find(m => m.customType === "pi-processes-completed");
      assert.equal(completed.details.processes[0].exit_code, code);
      assert.equal(completed.details.processes[0].output, "late-output");
      assert.equal(completed.display, false);
      assert.deepEqual(h.launched, h.original, "rendering must not rewrite the stored result");
      assert.equal(dataOf(h.launched).status, "running");
      h.card.setExpanded(true);
      // Pi owns the outer box padding; exercise usable terminal widths here.
      for (const width of [8, 40, 100]) {
        h.term.columns = width;
        h.term.resize();
        h.tui.renderNow();
        assert.ok(h.card.render(width).every(line => visibleWidth(line) <= width));
      }
      const retained = dataOf(await h.run("process_output", { session_id: dataOf(h.launched).session_id }));
      assert.equal(retained.output, "late-output", "live cards must not consume retained output");
      assert.deepEqual(h.errors, []);
    });
  }
}

for (const [outcome, args, expected] of [
  ["stop", { command: "sleep 30", mode: "service" }, /stopped ·/],
  ["timeout", { command: "sleep 30", mode: "service", timeout: 0.2 }, /timed out ·/],
  ["signal", { command: "while ! test -f finish; do sleep 0.02; done; kill -TERM $$", mode: "service" }, /failed · SIGTERM/],
  ["reload", { command: "sleep 30", mode: "service" }, /failed · SIG(?:TERM|KILL)/],
]) {
  test(`launch card tracks ${outcome} and preserves its final heading on later redraws`, bounded, async t => {
    const h = await cardFixture(t, TuiMainScreen, args);
    assert.match(h.lines(), /running/);
    if (outcome === "stop") await h.run("process_kill", { session_id: dataOf(h.launched).session_id });
    if (outcome === "signal") await writeFile(join(h.ctx.cwd, "finish"), "");
    if (outcome === "reload") await h.session.reload();
    await h.until(() => expected.test(h.lines()));
    h.card.invalidate();
    assert.match(h.lines(), expected);
    assert.deepEqual(h.launched, h.original);
    assert.deepEqual(h.errors, []);
  });
}

test("live card snapshots release callbacks, survive eviction, and do not touch logs", () => {
  let listener, subscriptions = 0, redraws = 0;
  let jobs = [{ session_id: "job", status: "running", exit_code: null, signal: null, timed_out: false }];
  const runtime = {
    list: () => jobs,
    subscribe(fn) { listener = fn; subscriptions++; return () => { listener = undefined; subscriptions--; }; },
    output() { assert.fail("cards must not read output"); },
    retain() { assert.fail("cards must not pin retention"); },
  };
  const cards = new LiveProcessCards();
  cards.attach(runtime);
  const result = { content: [], details: { ...jobs[0], output: "original", dropped_bytes: 0, unread_bytes: 0 } };
  const context = { state: {}, invalidate() { redraws++; } };
  cards.result(result, context);
  for (let i = 0; i < 100; i++) cards.result(result, context);
  listener(); // Output/lifecycle events while still running must not redraw the card.
  assert.equal(subscriptions, 1);
  assert.equal(redraws, 0);
  jobs = [{ ...jobs[0], status: "exited", exit_code: 7 }];
  listener();
  listener();
  assert.equal(redraws, 1);
  jobs = []; // Evicted/removed output must not restore the old "running" label.
  listener();
  assert.equal(cards.result(result, context).details.exit_code, 7);
  cards.dispose();
  assert.equal(subscriptions, 0);
  assert.equal(cards.result(result, context).details.exit_code, 7);
  assert.equal(result.details.status, "running");
});
