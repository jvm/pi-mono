import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import piProcesses from "../extensions/index.ts";
import { fixture, textOf, deferred, hookResponse } from "../../pi-dcg/tests/session-fixture.mjs";

const setup = (t, options = {}) => fixture(t, {
  ...options, omitShell: true, after: [piProcesses, ...(options.after ?? [])],
});
const dataOf = r => r.structuredContent ?? r.details;
const bashHook = handler => pi => pi.on("tool_call", (event, ctx) => {
  if (event.toolName === "bash") return handler(event, ctx);
});

for (const nested of [false, true]) {
  for (const mode of [undefined, "foreground", "background", "service"]) {
    for (const decision of ["allow", "deny", "ask"]) {
      test(`bash ${nested ? "codemode" : "direct"} ${mode ?? "built-in"}: DCG ${decision}`, async t => {
        const h = await setup(t, { decision });
        const args = { command: "printf guarded > started; printf result", ...(mode ? { mode } : {}) };
        const r = nested ? await h.script(`text(await tools.bash(${JSON.stringify(args)}));`)
          : await h.run("bash", args);
        assert.equal(r.isError, decision !== "allow");
        assert.equal(h.checks.length, 1);
        assert.equal(h.checks[0].command, args.command);
        if (decision === "allow") {
          if (mode === "background" || mode === "service") {
            // Startup does not promise readiness; wait on the owned process.
            const jobs = await h.run("process_list", {});
            await h.run("process_wait", { session_ids: dataOf(jobs).processes.map(p => p.session_id) });
          }
          await access(join(h.ctx.cwd, "started"));
        } else {
          await assert.rejects(access(join(h.ctx.cwd, "started")));
        }
        assert.deepEqual(h.errors, []);
      });
    }
  }
}

test("ordinary bash preserves the built-in structured result, cwd, and error behavior", async t => {
  const h = await setup(t);
  const command = "printf ordinary; printf stderr >&2";
  const expected = await createBashToolDefinition(h.ctx.cwd).execute("reference", { command }, undefined, undefined, h.ctx);
  const r = await h.run("bash", { command });
  assert.equal(r.isError, false);
  assert.deepEqual(r.content, expected.content);
  assert.equal(r.details, expected.details);
  assert.equal(textOf(await h.run("bash", { command: "pwd" })).trim(), await realpath(h.ctx.cwd));
  const failed = await h.run("bash", { command: "printf failure; exit 7" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /failure[\s\S]*code 7/);
  const nested = await h.script('const r=await tools.bash({command:"printf structured"}); text({output:r.output,exit_code:r.exit_code});');
  assert.equal(nested.isError, false);
  assert.match(textOf(nested), /"output":"structured","exit_code":0/);
  assert.equal(dataOf(await h.run("process_list", {})).processes.length, 0);
});

for (const [shell, prefix] of [[true, false], [false, true], [true, true]]) {
  test(`ordinary bash preserves configured shell=${shell} and prefix=${prefix}, including codemode`, async t => {
    const h = await setup(t);
    const wrapper = join(h.ctx.cwd, "fixture-shell");
    await writeFile(wrapper, '#!/bin/sh\nexport PI_SHELL_FIXTURE=custom\nexec /bin/bash "$@"\n', { mode: 0o700 });
    if (shell) h.session.settingsManager.setShellPath(pathToFileURL(wrapper).href);
    if (prefix) h.session.settingsManager.setShellCommandPrefix("export PI_PREFIX_FIXTURE=configured");
    const args = { command: 'printf "%s/%s" "${PI_SHELL_FIXTURE:-default}" "${PI_PREFIX_FIXTURE:-none}"' };
    const expected = `${shell ? "custom" : "default"}/${prefix ? "configured" : "none"}`;
    const result = await h.run("bash", args);
    assert.equal(result.isError, false);
    assert.equal(textOf(result), expected);
    const nested = await h.script(`text((await tools.bash(${JSON.stringify(args)})).output);`);
    assert.equal(nested.isError, false);
    assert.ok(textOf(nested).includes(expected));
    // Effective settings are read per call, not cached in a stale executor.
    h.session.settingsManager.setShellCommandPrefix("export PI_PREFIX_FIXTURE=updated");
    assert.equal(textOf(await h.run("bash", args)), `${shell ? "custom" : "default"}/updated`);
  });
}

for (const mode of [undefined, "foreground"]) {
  test(`bash ${mode ?? "built-in"} timeout uses seconds`, async t => {
    const h = await setup(t);
    const r = await h.run("bash", { command: "sleep 5; printf unexpected", timeout: 0.1, ...(mode ? { mode } : {}) });
    if (mode) assert.equal(dataOf(r).timed_out, true);
    else {
      assert.equal(r.isError, true);
      assert.match(textOf(r), /timed out/);
    }
    assert.doesNotMatch(textOf(r), /unexpected/);
  });
}

test("managed bash resolves cwd for DCG and execution and bounds output", async t => {
  const h = await setup(t);
  await mkdir(join(h.ctx.cwd, "work"));
  const r = await h.run("bash", { command: "pwd; printf 'xxxxxxxxxxxxxxxxxxxx'", mode: "foreground", workdir: "work", max_output_tokens: 2 });
  assert.equal(r.isError, false);
  assert.equal(h.checks[0].request.cwd, await realpath(join(h.ctx.cwd, "work")));
  assert.ok(Buffer.byteLength(dataOf(r).output) <= 8);
  assert.ok(dataOf(r).unread_bytes > 0 || dataOf(r).dropped_bytes > 0);
});

for (const field of ["command", "workdir", "mode", "tty", "timeout", "input"]) {
  test(`managed bash blocks later ${field} mutation`, async t => {
    const h = await setup(t, { after: [bashHook(event => {
      if (field === "input") event.input = { command: "printf bad > started", mode: "background" };
      else event.input[field] = field === "tty" ? true : "changed";
    })] });
    const r = await h.run("bash", { command: "printf bad > started", mode: "foreground" });
    assert.equal(r.isError, true);
    await assert.rejects(access(join(h.ctx.cwd, "started")));
    assert.equal(h.checks.length, 1);
  });
}

test("bash detects argument mutation during async approval", async t => {
  const ready = deferred();
  const release = deferred();
  let input;
  const h = await setup(t, {
    before: [bashHook(event => { input = event.input; })],
    process: async () => { ready.resolve(); await release.promise; return hookResponse("allow"); },
  });
  const pending = h.run("bash", { command: "printf bad > started", mode: "foreground" });
  await ready.promise;
  input.mode = "background";
  release.resolve();
  assert.equal((await pending).isError, true);
  await assert.rejects(access(join(h.ctx.cwd, "started")));
});

test("bash is the only command contract; exec_command is not registered or callable", async t => {
  const h = await setup(t);
  assert.ok(!h.api.getActiveTools().includes("exec_command"));
  assert.equal(h.api.getAllTools().find(t => t.name === "exec_command"), undefined);
  const old = await h.script('text(await tools.exec_command({cmd:"printf legacy"}));');
  assert.equal(old.isError, true);
  assert.equal(h.checks.length, 0);
  const direct = await h.run("exec_command", { cmd: "printf legacy" });
  assert.equal(direct.isError, true);
  for (const extra of [{ cmd: "ignored" }, { max_output_chars: 100 }, { timeout_ms: 1000 }]) {
    const r = await h.run("bash", { command: "printf bad > started", ...extra });
    assert.equal(r.isError, true);
    await assert.rejects(access(join(h.ctx.cwd, "started")));
  }
});

test("managed-only options require mode and invalid timeouts never start", async t => {
  const h = await setup(t);
  for (const extra of [{ workdir: "." }, { tty: false }, { title: "job" }, { max_output_tokens: 10 },
    { mode: "background", timeout: 0 }, { mode: "foreground", timeout: 86_401 }]) {
    const r = await h.run("bash", { command: "printf bad > started", ...extra });
    assert.equal(r.isError, true);
    await assert.rejects(access(join(h.ctx.cwd, "started")));
  }
  for (const command of ["", " ".repeat(65_537)]) {
    const r = await h.run("bash", { command, mode: "foreground" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /1 to 65536/);
  }
});

test("managed bash PTY input still requires per-write RPC approval", async t => {
  let approve = false;
  const h = await setup(t, { uiMode: "rpc", confirm: async () => approve });
  const r = await h.run("bash", { command: "read -r answer; printf 'received:%s' \"$answer\"", mode: "service", tty: true });
  const session_id = dataOf(r).session_id;
  const denied = await h.run("write_stdin", { session_id, chars: "rejected\n" });
  assert.equal(denied.isError, true);
  approve = true;
  const accepted = await h.run("write_stdin", { session_id, chars: "approved\n", yield_time_ms: 1000 });
  assert.match(dataOf(accepted).output, /received:approved/);
  assert.doesNotMatch(dataOf(accepted).output, /rejected/);
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.checks.length, 1);
});

test("print sessions do not require terminal-only acknowledgment to admit more failed jobs", async t => {
  const h = await setup(t);
  const r = await h.script(`
    for (let i=0;i<33;i++) await tools.bash({command:"exit 1",mode:"foreground"});
    const records = await tools.process_list({});
    text({count:records.processes.length,lastExit:records.processes.at(-1).exit_code});
  `);
  assert.equal(r.isError, false);
  assert.match(textOf(r), /"count":32,"lastExit":1/);
});
