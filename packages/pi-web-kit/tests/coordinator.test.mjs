import assert from "node:assert/strict";
import test from "node:test";
import { shareFetch, coordinate, requestScope } from "../src/coordinator.ts";
import { requestText, ProviderRequestError } from "../src/http.ts";

test("shared fetch cancellation is waiter-local and all-cancelled requests are cleaned", async () => {
  const a = new AbortController();
  let finish;
  let shared;
  const work = signal => {
    shared = signal;
    return new Promise(resolve => { finish = resolve; });
  };
  const one = shareFetch("waiter-test", a.signal, work);
  const two = shareFetch("waiter-test", undefined, work);
  await Promise.resolve();
  a.abort();
  await assert.rejects(one, /cancelled/);
  assert.equal(shared.aborted, false);
  finish("ok");
  assert.equal(await two, "ok");
  const b = new AbortController();
  const cancelled = shareFetch("cancel-all", b.signal, async signal => {
    shared = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  await Promise.resolve();
  b.abort();
  await assert.rejects(cancelled);
  assert.equal(shared.aborted, true);
  assert.equal(await shareFetch("cancel-all", undefined, async () => "fresh"), "fresh");
});

test("queued cancellation never dispatches and scope identity separates accounts", async () => {
  const scope = requestScope("https://fixture.invalid/a", { authorization: "Bearer synthetic-a" });
  assert.notEqual(scope, requestScope("https://fixture.invalid/a", { authorization: "Bearer synthetic-b" }));
  assert.ok(!scope.includes("synthetic"));
  const pending = [];
  const running = [1, 2, 3].map(() => coordinate(scope, new AbortController().signal,
    () => new Promise(resolve => pending.push(resolve))));
  await Promise.resolve();
  const cancelled = new AbortController();
  let dispatched = false;
  const queued = coordinate(scope, cancelled.signal, async () => { dispatched = true; });
  cancelled.abort();
  await assert.rejects(queued);
  pending.forEach(resolve => resolve());
  await Promise.all(running);
  assert.equal(dispatched, false);
});

test("queue capacity and HTTP total deadline fail without late dispatch", async t => {
  const url = "https://bounded-provider.invalid/";
  const scope = requestScope(url);
  const held = [];
  const running = [1, 2, 3].map(() => coordinate(scope, new AbortController().signal,
    () => new Promise(resolve => held.push(resolve))));
  await Promise.resolve();
  let dispatched = false;
  t.mock.method(globalThis, "fetch", async () => { dispatched = true; return new Response("unexpected"); });
  await assert.rejects(requestText(url, { timeoutMs: 10 }), error => error instanceof ProviderRequestError && /timed out/.test(error.message));
  const cancellations = Array.from({ length: 100 }, () => new AbortController());
  const queued = cancellations.map(cancel => coordinate(scope, cancel.signal, async () => { dispatched = true; }));
  const observed = Promise.allSettled(queued);
  await assert.rejects(requestText(url), error => error instanceof ProviderRequestError && /queue is full/.test(error.message));
  cancellations.forEach(cancel => cancel.abort());
  assert.ok((await observed).every(r => r.status === "rejected"));
  held.forEach(resolve => resolve());
  await Promise.all(running);
  assert.equal(dispatched, false);
});

test("a later Retry-After extends the cooldown of already-waiting HTTP requests", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const url = "https://extended-cooldown.invalid/";
  let calls = 0;
  let secondResponse;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response("limited", { status: 429, headers: { "retry-after": "1" } });
    if (calls === 2) return new Promise(resolve => { secondResponse = resolve; });
    return new Response("permitted");
  });
  const first = assert.rejects(requestText(url), /HTTP 429/);
  const second = assert.rejects(requestText(url), /HTTP 429/);
  await first;
  assert.equal(typeof secondResponse, "function");
  const waiting = requestText(url);
  await new Promise(setImmediate);
  t.mock.timers.tick(500);
  secondResponse(new Response("limited", { status: 429, headers: { "retry-after": "2" } }));
  await second;
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.equal(calls, 2, "the original 1-second timer must not bypass the extended cooldown");
  t.mock.timers.tick(1499);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  assert.equal((await waiting).text, "permitted");
  assert.equal(calls, 3);
});
