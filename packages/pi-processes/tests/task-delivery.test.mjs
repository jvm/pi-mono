import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import piProcesses from "../extensions/index.ts";
import { CompletionCoordinator } from "../src/completion.ts";
import { ProcessRuntime } from "../src/runtime.ts";
import { fixture as dcgFixture, textOf, deferred } from "../../pi-dcg/tests/session-fixture.mjs";
import { requestBody, textResponse } from "../../../tests/codex-harness.mjs";

const dataOf = result => result.structuredContent ?? result.details ?? JSON.parse(textOf(result));
const fixture = (t, options = {}) => dcgFixture(t, { ...options, omitShell: true });
const notices = h => h.session.messages.filter(m => m.customType === "pi-processes-completed");
async function eventually(check) {
  for (let n = 0; n < 150; n++) { if (check()) return; await delay(20); }
  assert.ok(check(), "expected lifecycle transition did not occur");
}
function response(calls, n) {
  const output = calls.map((c, i) => ({
    type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`,
    name: c.name, arguments: JSON.stringify(c.args),
  }));
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index, item },
  ]);
  events.push({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 10, output_tokens: 1 } } });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
/** Scripted provider, real Pi scheduling/DCG/serialization and real child processes. */
async function scripted(t, steps, extra = {}) {
  const h = await fixture(t, { ...extra, mode: "off", after: [piProcesses, ...(extra.after ?? [])] });
  const requests = [];
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    const step = steps[n++];
    return step ? response(typeof step === "function" ? step(h) : step, n) : textResponse("Task result handled.");
  };
  return { ...h, requests, next: step => { steps[n] = step; } };
}
const command = (command, mode = "background", extra = {}) => [{ name: "bash", args: { command, mode, ...extra } }];
const lastJob = h => dataOf(h.session.messages.findLast(m => m.role === "toolResult" && m.toolName === "bash")).session_id;

test("background idle resumes once with bounded sanitized output, never a visible bookkeeping message", async t => {
  const h = await scripted(t, [command("sleep 0.25; printf '\\033[31mfinal-result\\033[0m\\007'; exit 7")]);
  await h.session.prompt("Run validation.");
  const launched = dataOf(h.session.messages.find(m => m.role === "toolResult" && m.toolName === "bash"));
  assert.equal(launched.completion_delivery, "automatic");
  await eventually(() => notices(h).length === 1);
  await h.session.waitForIdle();
  assert.equal(h.requests.length, 3, "launch, normal continuation, one completion continuation");
  const message = notices(h)[0];
  assert.equal(message.display, false);
  assert.equal(message.details.processes[0].output, "final-result");
  assert.equal(message.details.processes[0].exit_code, 7);
  assert.match(message.content, /untrusted command data/);
  assert.doesNotMatch(JSON.stringify(message.details), /\\u001b|\\u0007|sleep/);
  assert.match(JSON.stringify(h.requests.at(-1).input), /final-result/);
  assert.equal(h.checks.length, 1);
  assert.deepEqual(h.errors, []);
});

test("background results reach the first safe continuation after independent work", async t => {
  const h = await scripted(t, [
    command("sleep 0.1; printf background-result"),
    command("sleep 0.4; printf independent-result", "foreground"),
  ]);
  await h.session.prompt("Run validation and independent inspection.");
  assert.equal(h.requests.length, 3);
  assert.equal(notices(h).length, 1);
  assert.match(JSON.stringify(h.requests[2].input), /background-result/);
  assert.match(JSON.stringify(h.requests[2].input), /independent-result/);
  assert.deepEqual(h.errors, []);
});

test("simultaneous completions batch, while independent foreground calls run concurrently", async t => {
  const h = await scripted(t, [[
    ...command("sleep 0.15; printf first"),
    ...command("sleep 0.15; printf second"),
    ...command("sleep 0.15; printf third"),
    ...command("printf ready > a.ready; while ! test -f b.ready; do sleep 0.02; done; printf independent-a", "foreground", { timeout: 2 }),
    ...command("printf ready > b.ready; while ! test -f a.ready; do sleep 0.02; done; sleep 0.4; printf independent-b", "foreground", { timeout: 2 }),
  ]]);
  const start = Date.now();
  await h.session.prompt("Parallel operations.");
  assert.ok(Date.now() - start < 1500, "must not serialize the process lifetimes");
  assert.equal(h.requests.length, 2, "one combined continuation, not one wake per exit");
  assert.equal(notices(h).length, 1);
  assert.equal(notices(h)[0].details.processes.length, 3);
  const foreground = h.session.messages.filter(m => m.role === "toolResult")
    .map(dataOf).filter(p => p.mode === "foreground");
  assert.equal(foreground.length, 2);
  assert.ok(foreground.every(p => p.exit_code === 0 && !p.timed_out), "foreground calls must overlap to release each other's dependency");
  assert.equal(h.checks.length, 5);
  assert.deepEqual(h.errors, []);
});

test("a later extension replacing a boundary draft does not silently lose its result", async t => {
  let replaced = false;
  const replace = pi => pi.on("turn_end", event => {
    if (replaced || !event.entries.some(e => e.customType === "pi-processes-completed")) return;
    replaced = true;
    return { entries: event.entries.filter(e => e.customType !== "pi-processes-completed") };
  });
  const h = await scripted(t, [[
    ...command("sleep 0.1; printf retried-result"),
    ...command("sleep 0.3; printf independent", "foreground"),
  ]], { after: [replace] });
  await h.session.prompt("Run independent work.");
  assert.equal(replaced, true);
  assert.equal(notices(h).length, 1);
  assert.match(JSON.stringify(h.requests.at(-1).input), /retried-result/);
  assert.deepEqual(h.errors, []);
});

test("one direct dependency wait consumes completion without a duplicate push", async t => {
  const h = await scripted(t, [
    command("sleep 0.25; printf awaited-result"),
    h => [{ name: "process_wait", args: { session_ids: [lastJob(h)], timeout_ms: 5000 } }],
  ]);
  await h.session.prompt("Wait once when the result becomes required.");
  await delay(200);
  assert.equal(h.requests.length, 3);
  assert.equal(notices(h).length, 0);
  const waited = dataOf(h.session.messages.findLast(m => m.role === "toolResult"));
  assert.equal(waited.wait_status, "completed");
  assert.equal(waited.processes[0].output, "awaited-result");
  assert.deepEqual(h.errors, []);
});

test("new user task disarms old auto-resume but retains output", async t => {
  const h = await scripted(t, [command("while ! test -f finish; do sleep 0.02; done; printf old-result")]);
  await h.session.prompt("Old task.");
  const id = lastJob(h);
  await h.session.prompt("Different task.");
  const before = h.requests.length;
  await writeFile(join(h.ctx.cwd, "finish"), "");
  await delay(300);
  assert.equal(h.requests.length, before);
  assert.equal(notices(h).length, 0);
  // A non-consuming output read is still available through the real tool path.
  const tool = h.api.getAllTools().find(t => t.name === "process_output");
  assert.ok(tool);
  assert.deepEqual(h.errors, []);
  const next = h.api.getAllTools().find(t => t.name === "bash");
  assert.ok(next.description.includes("do not poll"));
  assert.ok(id);
  h.next([{ name: "process_output", args: { session_id: id } }]);
  await h.session.prompt("Inspect the old process result.");
  const retained = dataOf(h.session.messages.findLast(m => m.role === "toolResult"));
  assert.equal(retained.session_id, id);
  assert.equal(retained.status, "exited");
  assert.equal(retained.output, "old-result");
});

test("foreground attachment yields to a user steer without killing its newly created process", async t => {
  const started = deferred();
  const h = await scripted(t, [command("while ! test -f finish; do sleep 0.02; done; printf foreground-final", "foreground")]);
  h.session.subscribe(e => { if (e.type === "tool_execution_start" && e.toolName === "bash") started.resolve(); });
  const run = h.session.prompt("Foreground command.");
  await Promise.race([started.promise, delay(3000).then(() => { throw new Error("foreground did not start"); })]);
  await h.session.steer("Change direction.");
  await run;
  const job = dataOf(h.session.messages.findLast(m => m.role === "toolResult"));
  assert.equal(job.status, "running");
  assert.equal(job.wait_status, "interrupted_by_input");
  await writeFile(join(h.ctx.cwd, "finish"), "");
  await delay(200);
  assert.equal(notices(h).length, 0);
  assert.deepEqual(h.errors, []);
});

test("validation warns when Pi file-editing tools ran during the command", async t => {
  const edit = pi => pi.registerTool({
    name: "apply_patch", label: "Fixture edit", description: "Mutate an input.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _args, _signal, _update, ctx) {
      await writeFile(join(ctx.cwd, "changed-input"), "new input");
      await writeFile(join(ctx.cwd, "finish"), "");
      return { content: [{ type: "text", text: "edited" }], details: undefined };
    },
  });
  const h = await scripted(t, [
    command("while ! test -f finish; do sleep 0.02; done; printf validation-result"),
    [{ name: "apply_patch", args: {} }],
    h => [{ name: "process_wait", args: { session_ids: [lastJob(h)] } }],
  ], { after: [edit] });
  await h.session.prompt("Validate while changing an input.");
  const wait = dataOf(h.session.messages.findLast(m => m.role === "toolResult"));
  assert.equal(wait.processes[0].input_changes_observed, true);
  assert.deepEqual(h.errors, []);
});

test("queued SDK steer releases a long dependency wait without stopping the process or waking the old task", async t => {
  const started = deferred();
  const h = await scripted(t, [
    command("while ! test -f finish; do sleep 0.02; done; printf old-task"),
    h => [{ name: "process_wait", args: { session_ids: [lastJob(h)], timeout_ms: 60_000 } }],
  ]);
  h.session.subscribe(e => { if (e.type === "tool_execution_start" && e.toolName === "process_wait") started.resolve(); });
  const run = h.session.prompt("Wait for this result.");
  await Promise.race([started.promise, delay(3000).then(() => { throw new Error("dependency wait did not start"); })]);
  const before = Date.now();
  await h.session.steer("Change direction; do not wait for that result.");
  await run;
  assert.ok(Date.now() - before < 1000);
  const waited = dataOf(h.session.messages.findLast(m => m.role === "toolResult"));
  assert.equal(waited.wait_status, "interrupted_by_input");
  assert.equal(waited.processes[0].status, "running");
  const requests = h.requests.length;
  await writeFile(join(h.ctx.cwd, "finish"), "");
  await delay(300);
  assert.equal(h.requests.length, requests);
  assert.equal(notices(h).length, 0);
  assert.deepEqual(h.errors, []);
});

test("service mode is immediate, silent on exit, and does not promise readiness", async t => {
  const h = await fixture(t, { after: [piProcesses] });
  const launched = await h.run("bash", { command: "sleep 0.2; printf service-output", mode: "service", title: "Development server" });
  assert.equal(dataOf(launched).status, "running");
  assert.equal(dataOf(launched).completion_delivery, "manual");
  assert.match(textOf(launched), /Check readiness separately/);
  await delay(350);
  assert.equal(notices(h).length, 0);
  const output = dataOf(await h.run("process_output", { session_id: dataOf(launched).session_id }));
  assert.equal(output.output, "service-output");
  const again = dataOf(await h.run("process_output", { session_id: output.session_id, cursor: output.next_cursor }));
  assert.equal(again.output, "");
  assert.deepEqual(h.errors, []);
});

for (const acknowledge of [false, true]) {
  test(`codemode nested final result ${acknowledge ? "explicitly consumes" : "does not silently consume"} auto-delivery`, async t => {
    const h = await fixture(t, { after: [piProcesses] });
    const code = `const j=await tools.bash({command:"sleep 0.15; printf nested-result",mode:"background"});
      const r=await tools.process_wait({session_ids:[j.session_id],acknowledge:${acknowledge}});
      ${acknowledge ? "text(r);" : "text('Result deliberately not exposed');"}`;
    await h.script(code);
    await delay(200);
    assert.equal(notices(h).length, acknowledge ? 0 : 1);
    assert.deepEqual(h.errors, []);
  });
}

test("coordinator protects failed observations, early exits and task generations", () => {
  const c = new CompletionCoordinator();
  const terminal = { session_id: "job", status: "exited", output: "result" };
  c.complete(terminal);
  c.arm("job");
  c.observe("reader", ["job"]);
  assert.deepEqual(c.take(), []);
  c.finish("reader", ["job"], false);
  assert.deepEqual(c.take(), [terminal]);
  c.arm("other");
  c.complete({ ...terminal, session_id: "other" });
  c.observe("reader2", ["other"]);
  c.finish("reader2", ["other"], true);
  assert.deepEqual(c.take(), []);
  const old = c.taskId;
  c.newTask();
  assert.equal(c.arm("stale", old), false);
});

for (const nested of [false, true]) {
  test(`completion before initial background return is ${nested ? "not lost by a discarded nested result" : "consumed by direct final delivery"}`, async t => {
    const start = ProcessRuntime.prototype.start;
    ProcessRuntime.prototype.start = function(...args) {
      if (args[9]?.mode === "background") args[5] = 1000; // deterministic early-exit boundary
      return start.apply(this, args);
    };
    t.after(() => { ProcessRuntime.prototype.start = start; });
    const h = await fixture(t, { after: [piProcesses] });
    if (nested) {
      await h.script('const job=await tools.bash({command:"printf quick-result",mode:"background"}); text({id:job.session_id});');
    } else {
      const result = dataOf(await h.run("bash", { command: "printf quick-result", mode: "background" }));
      assert.equal(result.status, "exited");
      assert.equal(result.output, "quick-result");
    }
    await delay(150);
    assert.equal(notices(h).length, nested ? 1 : 0);
    if (nested) assert.equal(notices(h)[0].details.processes[0].output, "quick-result");
    assert.deepEqual(h.errors, []);
  });
}

test("explicit mode/legacy ambiguity is rejected before a process starts, including codemode", async t => {
  const h = await fixture(t, { after: [piProcesses] });
  for (const nested of [false, true]) {
    const args = { command: "printf bad > started", mode: "background", yield_time_ms: 0 };
    const r = nested ? await h.script(`text(await tools.bash(${JSON.stringify(args)}));`) : await h.run("bash", args);
    assert.equal(r.isError, true);
  }
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
});
