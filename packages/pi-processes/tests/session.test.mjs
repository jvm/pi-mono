import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import piProcesses from "../extensions/index.ts";
import { fixture, textOf, deferred } from "./process-fixture.mjs";
import { DcgProcessError } from "../../pi-dcg/src/dcg-client.ts";

const proc = (handler) => pi => pi.on("tool_call", (event, ctx) => {
  if (event.toolName === "bash") return handler(event, ctx);
});
const dataOf = result => result.structuredContent ?? result.details ?? JSON.parse(textOf(result));
const processes = async (t, opts = {}) => fixture(t, { ...opts, after: [piProcesses, ...(opts.after ?? [])] });

for (const nested of [false, true]) {
  for (const decision of ["allow", "deny", "ask"]) {
    test(`real Pi ${nested ? "codemode" : "direct"} startup: DCG ${decision}`, async t => {
      const h = await processes(t, { decision });
      const cmd = "printf guarded > started; printf result";
      const result = nested
        ? await h.script(`const r=await tools.bash({command:${JSON.stringify(cmd)},mode:"foreground"}); text(r);`)
        : await h.run("bash", { command: cmd, mode: "foreground" });
      assert.equal(h.checks.length, 1);
      assert.equal(h.checks[0].command, cmd);
      assert.equal(result.isError, decision !== "allow");
      if (decision === "allow") {
        await access(join(h.ctx.cwd, "started"));
        assert.match(textOf(result), /result/);
      } else {
        await assert.rejects(access(join(h.ctx.cwd, "started")));
        assert.match(textOf(result), decision === "deny" ? /Blocked by dcg/ : /No interactive UI/);
      }
      assert.deepEqual(h.errors, []);
    });
  }
}

test("DCG uses canonical command cwd and seals later cwd/command mutations", async t => {
  const h = await processes(t);
  const dir = join(h.ctx.cwd, "work");
  await mkdir(dir);
  const canonical = await realpath(dir);
  const result = await h.run("bash", { command: "pwd", mode: "foreground", workdir: "work" });
  assert.equal(h.checks[0].request.cwd, canonical);
  assert.equal(dataOf(result).output.trim(), canonical);
});

for (const field of ["command", "workdir", "tty", "input"]) {
  test(`DCG blocks a later ${field} mutation before process startup`, async t => {
    const h = await processes(t, { after: [proc(event => {
      if (field === "input") event.input = { command: "printf bad > started", mode: "foreground" };
      else event.input[field] = field === "tty" ? true : "changed";
    })] });
    const result = await h.run("bash", { command: "printf ok > started", mode: "foreground" });
    assert.equal(result.isError, true);
    assert.equal(h.checks.length, 1);
    await assert.rejects(access(join(h.ctx.cwd, "started")));
  });
}

test("negative control: without DCG the same denied command starts", async t => {
  const h = await processes(t, { omitDcg: true, decision: "deny" });
  const result = await h.run("bash", { command: "printf ok", mode: "foreground" });
  assert.equal(result.isError, false);
  assert.equal(dataOf(result).output, "ok");
  assert.equal(h.checks.length, 0);
});

for (const uiMode of ["tui", "rpc"]) {
  test(`${uiMode} confirms exact input, rejection writes nothing, empty poll asks nothing`, async t => {
    let approve = false;
    const h = await processes(t, { uiMode, confirm: async () => approve });
    const launch = dataOf(await h.run("bash", {
      command: "read -r answer; printf 'received:%s\\n' \"$answer\"", tty: true, mode: "service",
    }));
    assert.equal(launch.status, "running");
    const denied = await h.run("write_stdin", { session_id: launch.session_id, chars: "rejected\n" });
    assert.equal(denied.isError, true);
    const poll = dataOf(await h.run("write_stdin", { session_id: launch.session_id, yield_time_ms: 0 }));
    assert.equal(poll.status, "running");
    assert.doesNotMatch(poll.output, /rejected/);
    assert.equal(h.confirmations.length, 1);
    approve = true;
    const accepted = dataOf(await h.run("write_stdin", { session_id: launch.session_id, chars: "approved\n", yield_time_ms: 1000 }));
    assert.equal(accepted.status, "exited");
    assert.match(accepted.output, /received:approved/);
    assert.equal(h.confirmations.length, 2);
    assert.match(h.confirmations[1].message, /approved\\n/);
    assert.ok(h.confirmations[1].opts.signal instanceof AbortSignal);
    assert.equal(h.checks.length, 1, "input is human-approved, not falsely DCG-checked");
  });
}

test("print blocks input but allows polling; control characters also require approval", async t => {
  const h = await processes(t);
  const launch = dataOf(await h.run("bash", { command: "sleep 30", tty: true, mode: "service" }));
  const denied = await h.run("write_stdin", { session_id: launch.session_id, chars: "\x03" });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /requires interactive or RPC/);
  const end = await h.run("process_kill", { session_id: launch.session_id });
  assert.equal(dataOf(end).status, "exited");
  const unknown = await h.run("process_kill", { session_id: "arbitrary-pid" });
  assert.equal(unknown.isError, true);
});

test("dialog exception fails closed and leaves process running", async t => {
  const h = await processes(t, { uiMode: "rpc", confirm: async () => { throw new Error("dialog unavailable"); } });
  const launch = dataOf(await h.run("bash", { command: "read -r answer", tty: true, mode: "service" }));
  const denied = await h.run("write_stdin", { session_id: launch.session_id, chars: "never\n" });
  assert.equal(denied.isError, true);
  assert.equal(dataOf(await h.run("write_stdin", { session_id: launch.session_id, yield_time_ms: 0 })).status, "running");
});

test("reload cleans live processes and invalidates their IDs", async t => {
  const h = await processes(t);
  const listenerCount = process.listenerCount("exit");
  const launch = dataOf(await h.run("bash", { command: "sleep 30", mode: "service" }));
  await h.session.reload();
  assert.equal(process.listenerCount("exit"), listenerCount);
  const poll = await h.run("write_stdin", { session_id: launch.session_id, yield_time_ms: 0 });
  assert.equal(poll.isError, true);
  assert.match(textOf(poll), /Unknown process session/);
  assert.deepEqual(dataOf(await h.run("process_list", {})).processes, []);
});

test("structured codemode results and terminal sanitization survive the real tool path", async t => {
  const h = await processes(t);
  const result = await h.script(`const r = await tools.bash({command:"printf '\\\\033[31mred\\\\033[0m\\\\007'",mode:"foreground"}); text({status:r.status,output:r.output});`);
  assert.equal(result.isError, false);
  assert.match(textOf(result), /"output":\s*"red"/);
  assert.doesNotMatch(textOf(result), /\\u001b|\\u0007/);
});

test("service completion is silent even on the next prompt; final output remains available", async t => {
  const h = await processes(t);
  const launch = dataOf(await h.run("bash", {
    command: "sleep 0.2; printf private-completion-output", mode: "service",
  }));
  await delay(400);
  await h.run("process_list", {});
  const completion = h.session.messages.filter(message => message.customType === "pi-processes-completed");
  assert.equal(completion.length, 0);
  const output = dataOf(await h.run("process_output", { session_id: launch.session_id }));
  assert.equal(output.output, "private-completion-output");
  assert.equal(output.status, "exited");
});

test("turn cancellation releases an input dialog even when UI ignores abort; late approval cannot write", async t => {
  const answer = deferred();
  const shown = deferred();
  const h = await processes(t, { uiMode: "rpc", confirm: async () => { shown.resolve(); return answer.promise; } });
  const launch = dataOf(await h.run("bash", { command: "read -r answer; printf 'unexpected:%s' \"$answer\"", tty: true, mode: "service" }));
  const writing = h.run("write_stdin", { session_id: launch.session_id, chars: "cancelled\n" });
  await shown.promise;
  await h.session.abort();
  await writing;
  answer.resolve(true);
  const poll = dataOf(await h.run("write_stdin", { session_id: launch.session_id, yield_time_ms: 0 }));
  assert.equal(poll.status, "running");
  assert.doesNotMatch(poll.output, /cancelled|unexpected/);
});

test("parallel codemode input writes queue separate approvals and never share a decision", async t => {
  const first = deferred();
  const shown = deferred();
  let count = 0;
  const h = await processes(t, { uiMode: "rpc", confirm: async () => {
    count++;
    if (count === 1) { shown.resolve(); return first.promise; }
    return false;
  } });
  const launch = await h.script(`text(await Promise.all([tools.bash({command:"read -r answer",tty:true,mode:"service"}),tools.bash({command:"read -r answer",tty:true,mode:"service"})]));`);
  assert.equal(launch.isError, false);
  const records = dataOf(await h.run("process_list", {})).processes;
  const writing = h.script(`text(await Promise.allSettled([tools.write_stdin({session_id:${JSON.stringify(records[0].session_id)},chars:"approved\\n"}),tools.write_stdin({session_id:${JSON.stringify(records[1].session_id)},chars:"denied\\n"})]));`);
  await shown.promise;
  await delay(20);
  assert.equal(count, 1);
  first.resolve(true);
  await writing;
  assert.equal(count, 2);
  assert.equal(dataOf(await h.run("write_stdin", { session_id: records[0].session_id, yield_time_ms: 100 })).status, "exited");
  assert.equal(dataOf(await h.run("write_stdin", { session_id: records[1].session_id, yield_time_ms: 0 })).status, "running");
});

test("removed legacy completion options are rejected before startup", async t => {
  const h = await processes(t);
  for (const extra of [{ notify_on_exit: true }, { completion_mode: "steer" }, { yield_time_ms: 0 }]) {
    const r = await h.run("bash", { command: "printf bad > started", mode: "background", ...extra });
    assert.equal(r.isError, true);
    await assert.rejects(access(join(h.ctx.cwd, "started")));
  }
  const completion = h.session.messages.filter(message => message.customType === "pi-processes-completed");
  assert.equal(completion.length, 0);
  assert.equal(h.checks.length, 0);
});

for (const [onError, allowed] of [["allow", true], ["block", false]]) {
  test(`process startup preserves DCG bridge ${onError} posture`, async t => {
    const h = await processes(t, {
      config: { onError },
      process: async () => { throw new DcgProcessError("fixture unavailable", "spawn_failed"); },
    });
    const result = await h.run("bash", { command: "printf marker > started", mode: "foreground" });
    assert.equal(result.isError, !allowed);
    if (allowed) await access(join(h.ctx.cwd, "started"));
    else await assert.rejects(access(join(h.ctx.cwd, "started")));
  });
}

for (const approved of [false, true]) {
  test(`RPC DCG ask startup approval=${approved} is preserved`, async t => {
    const h = await processes(t, { uiMode: "rpc", decision: "ask", confirm: async () => approved });
    const result = await h.run("bash", { command: "printf approved > started", mode: "foreground" });
    assert.equal(result.isError, !approved);
    assert.equal(h.confirmations.length, 1);
    if (approved) await access(join(h.ctx.cwd, "started"));
    else await assert.rejects(access(join(h.ctx.cwd, "started")));
  });
}

test("earlier in-place rewrites are checked and executed, and later approval hooks can block", async t => {
  const h = await processes(t, {
    before: [proc(event => { event.input.command = "printf rewritten"; })],
    after: [proc(event => { if (event.input.tty) return { block: true, reason: "other policy denied PTY" }; })],
  });
  const first = await h.run("bash", { command: "printf original", mode: "foreground" });
  assert.equal(dataOf(first).output, "rewritten");
  assert.equal(h.checks[0].command, "printf rewritten");
  const blocked = await h.run("bash", { command: "printf original", mode: "foreground", tty: true });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /other policy denied/);
});

test("process_kill never waits behind an unresolved input approval", async t => {
  const answer = deferred();
  const killed = deferred();
  t.after(() => answer.resolve(false));
  const h = await processes(t, { uiMode: "rpc", confirm: () => answer.promise });
  const launch = dataOf(await h.run("bash", { command: "read -r answer", tty: true, mode: "service" }));
  h.session.subscribe(event => {
    if (event.type === "tool_execution_end" && event.toolName === "process_kill") killed.resolve(event);
  });
  const script = h.script(`text(await Promise.allSettled([tools.write_stdin({session_id:${JSON.stringify(launch.session_id)},chars:"never\\n"}),tools.process_kill({session_id:${JSON.stringify(launch.session_id)}})]));`);
  const event = await Promise.race([killed.promise, delay(3000).then(() => { throw new Error("kill blocked behind approval"); })]);
  assert.equal(event.isError, false);
  answer.resolve(false);
  await script;
});

test("input confirmation escapes Unicode bidi characters without changing approved input", async t => {
  const h = await processes(t, { uiMode: "rpc", confirm: async () => true });
  const launch = dataOf(await h.run("bash", { command: "read -r answer; printf '%s' \"$answer\"", tty: true, mode: "service" }));
  const chars = "界\u202e\n";
  const end = dataOf(await h.run("write_stdin", { session_id: launch.session_id, chars, yield_time_ms: 1000 }));
  assert.match(h.confirmations[0].message, /\\u754c\\u202e\\n/);
  assert.ok(!h.confirmations[0].message.includes("\u202e"));
  assert.ok(end.output.includes("界\u202e"));
});
