import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { ConfirmationQueue } from "../src/confirmation-queue.ts";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test("a cancelled middle waiter cannot let another dialog overtake the active one", async () => {
  const queue = new ConfirmationQueue();
  const first = deferred();
  const middle = new AbortController();
  const last = new AbortController();
  const opened = [];
  const one = queue.confirm(new AbortController().signal, () => {
    opened.push(1);
    return first.promise;
  });
  const two = queue.confirm(middle.signal, async () => { opened.push(2); return true; });
  const three = queue.confirm(last.signal, async () => { opened.push(3); return true; });
  middle.abort();
  await assert.rejects(two, { name: "AbortError" });
  await tick();
  assert.deepEqual(opened, [1]);
  first.resolve(false);
  assert.equal(await one, false);
  assert.equal(await three, true);
  assert.deepEqual(opened, [1, 3]);
  assert.equal(getEventListeners(last.signal, "abort").length, 0);
});

test("already cancelled requests never open a dialog", async () => {
  let opened = false;
  await assert.rejects(new ConfirmationQueue().confirm(AbortSignal.abort(), async () => {
    opened = true;
    return true;
  }), { name: "AbortError" });
  assert.equal(opened, false);
});

test("synchronous UI failure releases the queue and removes abort listeners", async () => {
  const queue = new ConfirmationQueue();
  const controller = new AbortController();
  await assert.rejects(queue.confirm(controller.signal, () => { throw new Error("fixture UI failure"); }), /fixture UI failure/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(await queue.confirm(controller.signal, async () => true), true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort releases the queue even when the old UI never settles", async () => {
  const queue = new ConfirmationQueue();
  const controller = new AbortController();
  const opened = deferred();
  const first = queue.confirm(controller.signal, () => {
    opened.resolve();
    return new Promise(() => {});
  });
  await opened.promise;
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(await queue.confirm(new AbortController().signal, async () => true), true);
});
