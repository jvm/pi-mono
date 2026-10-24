import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import piProcesses from "../extensions/index.ts";
import { ProcessRuntime } from "../src/runtime.ts";
import { fixture, textOf } from "./process-fixture.mjs";
import { requestBody } from "../../../tests/codex-harness.mjs";

const dataOf = result => result.structuredContent ?? result.details ?? JSON.parse(textOf(result));
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

test("execution mode is validated before startup through direct and codemode calls", async t => {
  const h = await harness(t);
  for (const nested of [false, true]) {
    const args = { command: "printf bad > started", mode: "interrupt" };
    const result = nested
      ? await h.script(`text(await tools.bash(${JSON.stringify(args)}));`)
      : await h.run("bash", args);
    assert.equal(result.isError, true);
  }
  assert.equal(h.checks.length, 0);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
});

test("real Pi codemode completion pushes bounded output through DCG and the provider serializer", async t => {
  const h = await harness(t);
  const args = {
    command: "while ! test -f finish; do sleep 0.02; done; printf codemode-result",
    mode: "background", max_output_tokens: 2,
  };
  const launch = await h.script(`text(await tools.bash(${JSON.stringify(args)}));`);
  assert.equal(launch.isError, false);
  assert.equal(h.checks.length, 1);
  assert.equal(h.checks[0].command, args.command);
  const session_id = textOf(launch).match(/"session_id"\s*:\s*"([^"]+)"/)[1];
  const before = h.requests.length;
  await writeFile(join(h.ctx.cwd, "finish"), "");
  await eventually(() => h.requests.slice(before).some(pushed));
  await h.session.waitForIdle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.processes[0].output, "e-result");
  assert.equal(h.sent[0].message.details.processes[0].dropped_bytes, Buffer.byteLength("codemod"));
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
  test(`real Pi ${reason} preserves background delivery ownership`, async t => {
    const h = await harness(t);
    const job = dataOf(await h.run("bash", {
      command: "printf stop-result; sleep 30", mode: "background",
      timeout: reason === "timeout" ? 0.2 : 5,
    }));
    if (reason === "kill") {
      await h.run("process_kill", { session_id: job.session_id });
      await delay(100);
      assert.equal(h.sent.length, 0, "a new user task and explicit kill must not wake the old task");
      assert.equal(dataOf(await h.run("process_output", { session_id: job.session_id })).status, "exited");
      return;
    }
    await eventually(() => h.sent.length === 1);
    await eventually(() => h.requests.some(pushed));
    await h.session.waitForIdle();
    const completion = h.sent[0].message.details.processes[0];
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
  await h.run("bash", {
    command: "printf reload-private; sleep 30", mode: "background",
  });
  const before = h.requests.length;
  await h.session.reload();
  await delay(50);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, before);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
  assert.deepEqual(h.errors, []);
});
