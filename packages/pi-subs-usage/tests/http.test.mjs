import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsageJson, MAX_RESPONSE_BYTES, abortable } from "../src/http.ts";
import { ENDPOINTS } from "../src/auth.ts";
import { errorMessage } from "../src/types.ts";

const request = { provider: "opencode-go", url: ENDPOINTS["opencode-go"], headers: { Authorization: "Bearer unused-fixture" } };
const signal = () => new AbortController().signal;

test("quota HTTP uses read-only requests, no redirect forwarding, and no response cache", async () => {
  const result = await fetchUsageJson(request, signal(), async (url, init) => {
    assert.equal(url, ENDPOINTS["opencode-go"]);
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    return Response.json({ usage: { rolling: { percent: 5 } } });
  });
  assert.deepEqual(result, { usage: { rolling: { percent: 5 } } });
});

test("rejects arbitrary destinations, oversized bodies, invalid JSON, and HTTP failures", async () => {
  for (const url of ["https://evil.test", "https://hyper.charm.land/v1/credits"]) {
    await assert.rejects(fetchUsageJson({ ...request, url }, signal(), () => {
      assert.fail("must not fetch");
    }), /custom endpoint unsupported/);
  }
  for (const response of [
    new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    new Response(" ".repeat(MAX_RESPONSE_BYTES + 1)),
    new Response("this is not json"),
  ]) await assert.rejects(fetchUsageJson(request, signal(), async () => response), /invalid quota data/);
  for (const [status, message] of [[401, "access denied"], [403, "access denied"], [429, "rate limited"], [500, "request failed"], [302, "request failed"]]) {
    const response = new Response("sensitive upstream message", { status });
    await assert.rejects(fetchUsageJson(request, signal(), async () => response), new RegExp(message));
    assert.equal(response.bodyUsed, true);
  }
  assert.equal(errorMessage(new Error("Bearer secret")), "request failed");
});

test("auth and stream-body hangs can be cancelled without unhandled late results", async () => {
  const controller = new AbortController();
  const hung = abortable(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(hung, /request failed/);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const c = new AbortController();
  const pending = fetchUsageJson(request, c.signal, async () => new Response(body));
  await new Promise(resolve => setImmediate(resolve));
  c.abort();
  await assert.rejects(pending, /request failed/);
  assert.equal(cancelled, true);
});
