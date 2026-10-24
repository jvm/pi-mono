import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProcessOutput, renderCall, renderResult } from "../src/render.ts";
import piProcesses from "../extensions/index.ts";
import { ProcessPanel } from "../src/process-panel.ts";
import { deferred, fixture, textOf } from "../../pi-dcg/tests/session-fixture.mjs";

const theme = { fg: (_color, value) => value };
const output = Array.from({ length: 200 }, (_, i) => `line ${i} ${"界".repeat(100)}`).join("\n");
const data = { session_id: "12345678-long-id", status: "exited", exit_code: 0, signal: null,
  output, dropped_bytes: 12, unread_bytes: 34, timed_out: false };

test("collapsed output is four visual lines plus a count; expansion remains bounded", () => {
  for (const width of [1, 4, 12, 80]) {
    const compact = new ProcessOutput(output, false).render(width);
    assert.equal(compact.length, 5);
    assert.ok(compact.every(l => visibleWidth(l) <= width));
    const expanded = new ProcessOutput(output, true).render(width);
    assert.equal(expanded.length, 41);
    assert.ok(expanded.every(l => visibleWidth(l) <= width));
  }
  assert.match(new ProcessOutput(output, false).render(80).at(-1), /196 more lines/);
});

test("process renderers show status and loss, not JSON or submitted input", () => {
  const result = { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
  const lines = renderResult(result, { expanded: false, isPartial: false }, theme).render(80);
  assert.equal(lines.length, 6);
  assert.match(lines[0], /done.*12345678.*12 bytes omitted.*34 bytes remaining/);
  assert.doesNotMatch(lines.join("\n"), /session_id|exit_code/);
  const input = renderCall({ session_id: data.session_id, chars: "private-approved-input" }, theme).render(80).join("\n");
  assert.match(input, /Send approved input/);
  assert.doesNotMatch(input, /private-approved-input/);
  const longCall = renderCall({ cmd: "x".repeat(10_000) }, theme);
  assert.equal(longCall.render(1).length, 1, "command previews must not wrap into hundreds of rows");
  assert.ok(visibleWidth(longCall.render(1)[0]) <= 1);
});

test("output previews neutralize terminal and direction-changing controls", () => {
  const lines = new ProcessOutput("\x1b[31mred\x1b[0m\x07\u202efalse", false).render(80);
  assert.equal(stripVTControlCharacters(lines.join("")), lines.join(""));
  assert.doesNotMatch(lines.join(""), /\u202e|\x07/);
  assert.match(lines.join(""), /red\\u202efalse/);
  const progress = new ProcessOutput("first\rsecond\tvalue\r\nthird", false).render(80);
  assert.deepEqual(progress, ["first", "second  value", "third"]);
  assert.ok(progress.every(line => !/[\r\t]/.test(line)));
});

test("real Pi registered write_stdin and output tools use compact rendering without truncating model data", async t => {
  const registered = new Map();
  const capture = pi => piProcesses(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return tool => { registered.set(tool.name, tool); return target.registerTool(tool); };
    return Reflect.get(target, key);
  } }));
  const h = await fixture(t, { after: [capture] });
  // Do not let a fast command deliver the entire buffer in the initial call:
  // this test specifically exercises the legacy poll's registered renderer.
  const launched = await h.run("exec_command", {
    cmd: "while ! test -f render-ready; do sleep 0.02; done; seq 1 200", yield_time_ms: 0,
  });
  const id = (launched.structuredContent ?? launched.details ?? JSON.parse(textOf(launched))).session_id;
  assert.equal((launched.details ?? JSON.parse(textOf(launched))).status, "running");
  await writeFile(join(h.ctx.cwd, "render-ready"), "");
  const polled = await h.run("write_stdin", { session_id: id, yield_time_ms: 5000 });
  assert.ok(textOf(polled).includes("200"));
  const lines = registered.get("write_stdin").renderResult(polled, { expanded: false, isPartial: false }, theme).render(80);
  assert.ok(lines.length <= 6);
  assert.ok(lines.join("\n").includes("more lines"));
  for (const name of ["exec_command", "write_stdin", "process_output", "process_wait", "process_kill", "process_list"]) {
    assert.equal(typeof registered.get(name).renderResult, "function", `renderer missing from ${name}`);
  }
});

test("paged panel bounds terminal height, scrolls long lines, reads cursor segments, and closes", () => {
  const reads = [];
  let closed = false;
  const panel = new ProcessPanel((cursor, tail) => {
    reads.push([cursor, tail]);
    return { ...data, output: Array.from({ length: 100 }, (_, i) => `line ${i} ${"界".repeat(80)}`).join("\n"),
      next_cursor: cursor + 1000, unread_bytes: 2000 };
  }, () => { closed = true; }, () => {}, () => 10);
  for (const width of [1, 4, 12, 80]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= 10);
    assert.ok(lines.every(l => visibleWidth(l) <= width));
  }
  panel.handleInput("\x1b[B");
  assert.match(panel.render(80).join("\n"), /Line 7/);
  panel.handleInput("\x1b[C");
  assert.match(panel.render(80).join("\n"), /column 10/);
  panel.handleInput("n");
  panel.handleInput("p");
  panel.handleInput("t");
  assert.deepEqual(reads, [[0, false], [1000, false], [0, false], [0, true]]);
  panel.handleInput("\x1b");
  assert.equal(closed, true);
});

test("real /processes command opens local output without a provider call or consuming tool output", async t => {
  let viewed = false;
  const h = await fixture(t, { after: [piProcesses], uiMode: "tui", uiContext: {
    select: async (_title, options) => options[0],
    custom: async factory => {
      let done = false;
      const component = factory({ terminal: { rows: 12 }, requestRender() {} }, theme, {}, () => { done = true; });
      assert.ok(component.render(40).join("\n").includes("1"));
      component.handleInput("\x1b");
      assert.equal(done, true);
      viewed = true;
    },
  } });
  const job = dataOfForPanel(await h.run("exec_command", { cmd: "seq 1 200" }));
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (...args) => { requests++; return fetch(...args); };
  await h.session.prompt("/processes");
  assert.equal(viewed, true);
  assert.equal(requests, 0);
  const output = dataOfForPanel(await h.run("process_output", { session_id: job.session_id }));
  assert.ok(output.output.includes("200"));
  assert.deepEqual(h.errors, []);
});

test("background completion creates footer feedback, not permanent UI notification rows", { timeout: 10_000 }, async t => {
  const statuses = new Map();
  const h = await fixture(t, { after: [piProcesses], uiMode: "tui", uiContext: {
    setStatus(key, value) { statuses.set(key, value); },
    select: async (_title, options) => options[0],
    custom: async factory => {
      const component = factory({ terminal: { rows: 12 }, requestRender() {} }, theme, {}, () => {});
      assert.ok(component.render(40).join("\n").includes("private-output"));
      component.handleInput("\x1b");
    },
  } });
  const delivered = deferred();
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === "message_end" && event.message.customType === "pi-processes-completed") {
      delivered.resolve(event.message);
    }
  });
  t.after(unsubscribe);
  // Gate the child until the initial call settles, then await actual delivery
  // rather than racing the process exit and the idle completion timer.
  await h.run("exec_command", {
    cmd: "while ! test -f footer-ready; do sleep 0.02; done; printf private-output; exit 7",
    mode: "background", title: "Failed test",
  });
  await writeFile(join(h.ctx.cwd, "footer-ready"), "");
  const completion = await delivered.promise;
  await h.session.waitForIdle();
  assert.match(statuses.get("pi-processes-results"), /need attention/);
  assert.equal(h.notifications.length, 0, "ui.notify would append permanent visible conversation rows");
  assert.equal(completion.display, false);
  await h.session.prompt("/processes");
  assert.equal(statuses.get("pi-processes-results"), undefined);
  assert.deepEqual(h.errors, []);
});
const dataOfForPanel = r => r.structuredContent ?? r.details ?? JSON.parse(textOf(r));
