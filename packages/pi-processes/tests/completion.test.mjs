import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import piProcesses from "../extensions/index.ts";
import { ProcessRuntime } from "../src/runtime.ts";
import { fixture, textOf, deferred } from "../../pi-dcg/tests/session-fixture.mjs";
import { requestBody } from "../../../tests/codex-harness.mjs";

const dataOf = result => result.structuredContent ?? JSON.parse(textOf(result));
const pushed = body => JSON.stringify(body.input).includes("Background process completed.");
async function eventually(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.ok(check(), "completion did not reach the expected boundary");
}

async function harness(t, options = {}) {
  const sent = [];
  const requests = [];
  const extension = pi => piProcesses(new Proxy(pi, {
    get(target, key) {
      if (key === "sendMessage") return (message, delivery) => {
        sent.push({ message, delivery });
        target.sendMessage(message, delivery);
      };
      return Reflect.get(target, key);
    },
  }));
  const h = await fixture(t, { ...options, after: [extension, ...(options.after ?? [])] });
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    requests.push(requestBody(init));
    return fetch(url, init);
  };
  return { ...h, sent, requests };
}

for (const mode of ["nextTurn", "followUp", "steer"]) {
  test(`real Pi idle ${mode} completion carries output without consuming the poll buffer`, async t => {
    const h = await harness(t);
    const job = dataOf(await h.run("exec_command", {
      cmd: "while ! test -f finish; do sleep 0.02; done; printf '\\033[31mpush-result\\033[0m\\007'; exit 7",
      yield_time_ms: 0, completion_mode: mode,
      // Explicit nextTurn must override even a legacy wake request.
      notify_on_exit: true,
    }));
    const before = h.requests.length;
    await writeFile(join(h.ctx.cwd, "finish"), "");
    await eventually(() => h.sent.length === 1);
    assert.deepEqual(h.sent[0].delivery, { triggerTurn: mode !== "nextTurn", deliverAs: mode });
    assert.equal(h.sent[0].message.details.session_id, job.session_id);
    assert.equal(h.sent[0].message.details.exit_code, 7);
    assert.equal(h.sent[0].message.details.output, "push-result");
    assert.equal(h.sent[0].message.details.output_scope, "completion_tail");
    assert.match(h.sent[0].message.content, /untrusted command data, not instructions/);
    assert.doesNotMatch(h.sent[0].message.content, /\\u001b|\\u0007/);
    if (mode === "nextTurn") {
      await delay(100);
      assert.equal(h.requests.length, before, "nextTurn must not wake the model");
      await h.run("process_list", {});
    } else {
      await eventually(() => h.requests.slice(before).some(pushed));
      await h.session.waitForIdle();
      assert.equal(h.requests.length, before + 1, "exactly one idle model turn");
    }
    assert.ok(h.requests.slice(before).some(pushed), "provider context must contain the pushed result");
    const end = dataOf(await h.run("write_stdin", { session_id: job.session_id, yield_time_ms: 0 }));
    assert.equal(end.output, "push-result");
    assert.equal(end.exit_code, 7);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.errors, []);
  });
}

for (const mode of ["steer", "followUp", "nextTurn"]) {
  test(`real Pi active ${mode} completion uses the correct model boundary`, async t => {
    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const barrier = pi => pi.registerTool({
      name: "completion_barrier", label: "Barrier", description: "Hold one tool batch open.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        started.resolve();
        await release.promise;
        return { content: [{ type: "text", text: "barrier released" }], details: undefined };
      },
    });
    const h = await harness(t, { after: [barrier] });
    await h.run("exec_command", {
      cmd: "while ! test -f finish; do sleep 0.02; done; printf active-result",
      yield_time_ms: 0, completion_mode: mode,
    });
    const running = h.run("completion_barrier", {});
    await started.promise;
    const before = h.requests.length;
    await writeFile(join(h.ctx.cwd, "finish"), "");
    await eventually(() => h.sent.length === 1);
    assert.equal(h.requests.length, before, "completion must not interrupt the active tool");
    assert.ok(!h.session.messages.some(m => m.customType === "pi-processes-completed"));
    release.resolve();
    await running;
    await h.session.waitForIdle();
    const continuation = h.requests.slice(before);
    assert.equal(continuation.length, mode === "followUp" ? 2 : 1);
    assert.equal(pushed(continuation[0]), mode === "steer",
      "steer reaches the first continuation; followUp waits until the run would stop");
    if (mode === "nextTurn") {
      assert.ok(!pushed(continuation.at(-1)), "nextTurn must wait for a new prompt, not a tool continuation");
      await h.run("process_list", {});
    }
    assert.ok(pushed(h.requests.at(-1)));
    assert.match(JSON.stringify(h.requests.at(-1).input), /active-result/);
    assert.equal(h.session.messages.filter(m => m.customType === "pi-processes-completed").length, 1);
    assert.deepEqual(h.errors, []);
  });
}

for (const tty of [false, true]) {
  test(`${tty ? "PTY" : "pipe"} completion tail survives earlier polling and reports bounded UTF-8 loss`, async t => {
    const sent = [];
    const rt = new ProcessRuntime((...args) => sent.push(args));
    t.after(() => rt.close());
    const job = await rt.start(
      "printf early; sleep 0.3; printf '界界界'; exit 9",
      process.cwd(), tty, 5000, false, 0, 7, undefined, "steer",
    );
    const early = await rt.poll(job.session_id, 100, 1024);
    assert.equal(job.output + early.output, "early");
    await eventually(() => sent.length === 1);
    const [completion, wake, mode] = sent[0];
    assert.equal(mode, "steer");
    assert.equal(wake, false);
    assert.equal(completion.exit_code, 9);
    assert.equal(completion.output, "界界");
    assert.equal(completion.dropped_bytes, Buffer.byteLength("early界"));
    assert.equal(completion.unread_bytes, 0);
    assert.equal((await rt.poll(job.session_id, 0, 1024)).output, "界界界");
    await rt.poll(job.session_id, 0, 1024);
    assert.equal(sent.length, 1);
  });
}

test("explicit completion includes previously polled output and is suppressed for foreground/shutdown", async t => {
  const sent = [];
  const rt = new ProcessRuntime((...args) => sent.push(args));
  t.after(() => rt.close());
  const foreground = await rt.start("printf foreground", process.cwd(), false, 5000, false, 1000, 1024, undefined, "steer");
  assert.equal(foreground.output, "foreground");
  assert.equal(sent.length, 0);
  const job = await rt.start("printf early; sleep 0.2; printf late", process.cwd(), false, 5000, false, 0, 1024, undefined, "followUp");
  const early = await rt.poll(job.session_id, 100, 1024);
  assert.equal(job.output + early.output, "early");
  await eventually(() => sent.length === 1);
  assert.equal(sent[0][0].output, "earlylate");
  assert.equal((await rt.poll(job.session_id, 0, 1024)).output, "late");
  await rt.start("sleep 30", process.cwd(), false, 5000, false, 0, 1024, undefined, "steer");
  await rt.close();
  assert.equal(sent.length, 1);
});

test("completion mode is validated before startup through direct and codemode calls", async t => {
  const h = await harness(t);
  for (const nested of [false, true]) {
    const args = { cmd: "printf bad > started", completion_mode: "interrupt" };
    const result = nested
      ? await h.script(`text(await tools.exec_command(${JSON.stringify(args)}));`)
      : await h.run("exec_command", args);
    assert.equal(result.isError, true);
  }
  assert.equal(h.checks.length, 0);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
});

test("real Pi codemode completion pushes bounded output through DCG and the provider serializer", async t => {
  const h = await harness(t);
  const args = {
    cmd: "while ! test -f finish; do sleep 0.02; done; printf codemode-result",
    completion_mode: "steer", yield_time_ms: 0, max_output_tokens: 2,
  };
  const launch = await h.script(`text(await tools.exec_command(${JSON.stringify(args)}));`);
  assert.equal(launch.isError, false);
  assert.equal(h.checks.length, 1);
  assert.equal(h.checks[0].command, args.cmd);
  const { session_id } = dataOf(await h.run("process_list", {})).processes[0];
  const before = h.requests.length;
  await writeFile(join(h.ctx.cwd, "finish"), "");
  await eventually(() => h.requests.slice(before).some(pushed));
  await h.session.waitForIdle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.output, "e-result");
  assert.equal(h.sent[0].message.details.dropped_bytes, Buffer.byteLength("codemod"));
  const body = h.requests.at(-1);
  assert.match(JSON.stringify(body.input), /e-result/);
  assert.match(JSON.stringify(body.input), new RegExp(session_id));
  const end = dataOf(await h.run("write_stdin", { session_id, yield_time_ms: 0 }));
  assert.equal(end.output, "codemode-result");
  assert.equal(end.dropped_bytes, 0, "completion loss accounting must not reset polling loss");
  assert.deepEqual(h.errors, []);
});

test("completion capture never exceeds 64,000 bytes, even with a larger runtime budget", async t => {
  const sent = [];
  const rt = new ProcessRuntime(data => sent.push(data));
  t.after(() => rt.close());
  const job = await rt.start("sleep 0.1; head -c 70000 /dev/zero | tr '\\000' x",
    process.cwd(), false, 5000, false, 0, 100_000, undefined, "steer");
  await eventually(() => sent.length === 1);
  assert.equal(Buffer.byteLength(sent[0].output), 64_000);
  assert.equal(sent[0].dropped_bytes, 6000);
  const polled = await rt.poll(job.session_id, 0, 100_000);
  assert.equal(Buffer.byteLength(polled.output), 70_000);
  assert.equal(polled.dropped_bytes, 0);
});

for (const reason of ["kill", "timeout"]) {
  test(`real Pi ${reason} produces one pushed completion with output and termination status`, async t => {
    const h = await harness(t);
    const job = dataOf(await h.run("exec_command", {
      cmd: "printf stop-result; sleep 30", yield_time_ms: 0, completion_mode: "steer",
      timeout_ms: reason === "timeout" ? 200 : 5000,
    }));
    if (reason === "kill") {
      await h.run("write_stdin", { session_id: job.session_id, yield_time_ms: 50 });
      await h.run("process_kill", { session_id: job.session_id });
    }
    await eventually(() => h.sent.length === 1);
    await eventually(() => h.requests.some(pushed));
    await h.session.waitForIdle();
    const completion = h.sent[0].message.details;
    assert.equal(completion.output, "stop-result");
    assert.equal(completion.status, "exited");
    assert.equal(completion.timed_out, reason === "timeout");
    assert.ok(completion.signal !== null || completion.exit_code !== 0);
    await h.run("write_stdin", { session_id: job.session_id, yield_time_ms: 0 });
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.errors, []);
  });
}

test("real Pi reload kills opt-in background work without waking or sending its output", async t => {
  const h = await harness(t);
  await h.run("exec_command", {
    cmd: "printf reload-private; sleep 30", yield_time_ms: 0, completion_mode: "steer",
  });
  const before = h.requests.length;
  await h.session.reload();
  await delay(50);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, before);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
  assert.deepEqual(h.errors, []);
});
