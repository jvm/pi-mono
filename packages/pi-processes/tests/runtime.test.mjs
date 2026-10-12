import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRuntime, resolveWorkdir } from "../src/runtime.ts";
import { OutputBuffer } from "../src/output.ts";

const cwd = tmpdir();
const limits = { active: 2, retained: 3, outputBytes: 1024, killGraceMs: 100 };
function fixture(t, completion = () => {}, overrides = {}) {
  const rt = new ProcessRuntime(completion, { ...limits, ...overrides });
  t.after(() => rt.close());
  return rt;
}
const start = (rt, cmd, opts = {}) => rt.start(cmd, opts.cwd ?? cwd, opts.tty ?? false,
  opts.timeout ?? 5000, opts.notify ?? false, opts.wait ?? 1000, opts.bytes ?? 1024, opts.signal);
async function exited(rt, id) {
  let result;
  for (let i = 0; i < 30; i++) {
    result = await rt.interact(id, () => rt.poll(id, 100, 1024));
    if (result.status === "exited") return result;
  }
  throw new Error("process failed to exit");
}

test("bounded output accounts for overflow and does not lose unread budget tail", () => {
  const output = new OutputBuffer(8);
  output.append(Buffer.from("012345"));
  output.append(Buffer.from("6789abc"));
  assert.deepEqual(output.read(4), { output: "5678", dropped_bytes: 5, unread_bytes: 4 });
  assert.deepEqual(output.read(4), { output: "9abc", dropped_bytes: 0, unread_bytes: 0 });
  for (let i = 0; i < 500; i++) { output.append(Buffer.from("ab")); assert.equal(output.read(4).output, "ab"); }
});

test("Unicode budget and overflow preserve complete characters", () => {
  const output = new OutputBuffer(8);
  output.append(Buffer.from("界界界"));
  assert.deepEqual(output.read(4), { output: "界", dropped_bytes: 3, unread_bytes: 3 });
  assert.equal(output.read(4).output, "界");
  assert.equal(output.read(4).output, "");
});

for (const tty of [false, true]) {
  test(`real ${tty ? "PTY" : "pipe"} launch, terminal detection and exit`, async t => {
    const rt = fixture(t);
    const data = await start(rt, "if test -t 1; then printf terminal; else printf pipe; fi; printf '\\n'; exit 7", { tty });
    assert.equal(data.status, "exited");
    assert.equal(data.exit_code, 7);
    assert.match(data.output, tty ? /terminal/ : /pipe/);
    assert.equal(data.dropped_bytes, 0);
    assert.equal(rt.list()[0].session_id, data.session_id);
  });

  test(`${tty ? "PTY" : "pipe"} background completion is once and metadata-only`, async t => {
    const notifications = [];
    let completed;
    const completion = new Promise(resolve => { completed = resolve; });
    const rt = fixture(t, (...args) => { notifications.push(args); completed(); });
    const data = await start(rt, "sleep 0.4; printf private-output", { tty, wait: 0, notify: true });
    assert.equal(data.status, "running");
    // CI scheduling and stream draining can exceed 250 ms. Wait for the
    // notification itself, not process polling (which could hide missing wiring).
    let timer;
    try {
      await Promise.race([completion, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Background completion notification did not arrive")), 5000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0].output, "");
    assert.equal(notifications[0][1], true);
    assert.match((await exited(rt, data.session_id)).output, /private-output/);
    await rt.poll(data.session_id, 0, 1024);
    assert.equal(notifications.length, 1);
  });

  test(`${tty ? "PTY" : "pipe"} timeout terminates and reports status`, async t => {
    const rt = fixture(t);
    const data = await start(rt, "sleep 30", { tty, wait: 0, timeout: 100 });
    const end = await exited(rt, data.session_id);
    assert.equal(end.timed_out, true);
  });

  test(`${tty ? "PTY" : "pipe"} kills descendants, including a TERM-ignoring child`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "pi-processes-group-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const rt = fixture(t);
    const cmd = `trap '' TERM; (trap '' TERM; sleep 30) & echo "$!" > child.pid; wait`;
    const data = await start(rt, cmd, { cwd: dir, tty, wait: 100 });
    const pid = Number((await readFile(join(dir, "child.pid"), "utf8")).trim());
    assert.ok(pid > 1);
    await rt.kill(data.session_id);
    assert.equal((await exited(rt, data.session_id)).status, "exited");
    // Zombies are dead but may wait for the host init to reap them.
    const { execFileSync } = await import("node:child_process");
    let state = "";
    try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch {}
    assert.ok(!state || state.startsWith("Z"), `child still alive: ${state}`);
  });
}

test("PTY stdin works; pipe input is closed and cannot be written", async t => {
  const rt = fixture(t);
  const data = await start(rt, "read -r value; printf 'received:%s\\n' \"$value\"", { tty: true, wait: 0 });
  rt.write(data.session_id, "hello\n");
  assert.match((await exited(rt, data.session_id)).output, /received:hello/);
  const pipe = await start(rt, "if read -r value; then printf unexpected; else printf closed; fi");
  assert.equal(pipe.output, "closed");
  assert.throws(() => rt.write(pipe.session_id, "x"), /no longer running/);
});

test("independent sessions do not block, while same-session reads serialize", async t => {
  const rt = fixture(t);
  const slow = await start(rt, "sleep 30", { wait: 0 });
  const started = Date.now();
  const fast = await start(rt, "printf fast");
  assert.equal(fast.output, "fast");
  assert.ok(Date.now() - started < 1000);
  const first = rt.interact(slow.session_id, () => rt.poll(slow.session_id, 100, 1024));
  let secondDone = false;
  const second = rt.interact(slow.session_id, async () => { secondDone = true; return rt.poll(slow.session_id, 0, 1024); });
  await delay(20);
  assert.equal(secondDone, false);
  await Promise.all([first, second]);
});

test("cancel initial wait kills the new job; cancel polling leaves it alive", async t => {
  const rt = fixture(t);
  const initial = new AbortController();
  const pending = start(rt, "sleep 30", { wait: 5000, signal: initial.signal });
  setTimeout(() => initial.abort(), 50);
  await assert.rejects(pending, /cancel/);
  assert.equal(rt.list()[0].status, "exited");
  const data = await start(rt, "sleep 30", { wait: 0 });
  const poll = new AbortController();
  const reading = rt.interact(data.session_id, () => rt.poll(data.session_id, 5000, 1024, poll.signal));
  poll.abort();
  await assert.rejects(reading, /cancel/);
  assert.equal(rt.list().find(job => job.session_id === data.session_id).status, "running");
  await rt.close();
  assert.deepEqual(rt.list(), []);
  await rt.close();
});

test("active cap includes concurrent launch reservations and completed records evict", async t => {
  const rt = fixture(t);
  const jobs = await Promise.allSettled([1, 2, 3].map(() => start(rt, "sleep 30", { wait: 0 })));
  assert.equal(jobs.filter(item => item.status === "fulfilled").length, 2);
  assert.equal(jobs.filter(item => item.status === "rejected").length, 1);
  for (const item of jobs) if (item.status === "fulfilled") await rt.kill(item.value.session_id);
  let first;
  for (let i = 0; i < 6; i++) { const data = await start(rt, "printf ok"); first ??= data.session_id; }
  assert.equal(rt.list().length, 3);
  assert.throws(() => rt.poll(first, 0, 1024), /Unknown/);
});

test("canonical cwd and invalid cwd", async t => {
  assert.equal(await resolveWorkdir(".", cwd), await resolveWorkdir(undefined, cwd));
  await assert.rejects(resolveWorkdir("missing-pi-processes-directory", cwd), /ENOENT/);
  const rt = fixture(t);
  await assert.rejects(start(rt, "printf bad", { cwd: "/missing-pi-processes-directory" }));
  assert.deepEqual(rt.list(), []);
});

test("an exiting pipe shell cannot leave inherited output descriptors open", async t => {
  const rt = fixture(t);
  const begin = Date.now();
  const data = await start(rt, "sleep 30 & printf completed; exit 0");
  assert.equal(data.status, "exited");
  assert.equal(data.output, "completed");
  assert.ok(Date.now() - begin < 2000);
});

test("foreground completion does not notify; output overflow stays bounded", async t => {
  let count = 0;
  const rt = fixture(t, () => count++);
  const data = await start(rt, "head -c 8192 /dev/zero | tr '\\000' x");
  assert.equal(count, 0);
  assert.equal(Buffer.byteLength(data.output), 1024);
  assert.equal(data.dropped_bytes, 8192 - 1024);
});

test("cancelled queued reader returns promptly without overtaking the first reader", async t => {
  const rt = fixture(t);
  const data = await start(rt, "sleep 30", { wait: 0 });
  const first = rt.interact(data.session_id, () => rt.poll(data.session_id, 300, 1024));
  const abort = new AbortController();
  const second = rt.interact(data.session_id, () => rt.poll(data.session_id, 0, 1024), abort.signal);
  let thirdCalled = false;
  const third = rt.interact(data.session_id, () => { thirdCalled = true; return rt.poll(data.session_id, 0, 1024); });
  abort.abort();
  await assert.rejects(second, /cancelled/);
  assert.equal(thirdCalled, false);
  await Promise.all([first, third]);
});
