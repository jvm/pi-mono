import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { initializeLedger, reserveRequest, readEvents, summarizeUsage } from "./live-experiments/support.mjs";

test("live experiment allowance is explicit, persistent, bounded and never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-experiment-budget-test-"));
  const path = join(dir, "ledger.json");
  const oldConsent = process.env.PI_LIVE_COMPACTION;
  const oldLimit = process.env.PI_COMPACTION_APPROVED_REQUESTS;
  try {
    delete process.env.PI_LIVE_COMPACTION;
    await assert.rejects(initializeLedger(path), /Explicit live consent/);
    process.env.PI_LIVE_COMPACTION = "1";
    process.env.PI_COMPACTION_APPROVED_REQUESTS = "72";
    await initializeLedger(path);
    await assert.rejects(initializeLedger(path), { code: "EEXIST" });
    await assert.rejects(reserveRequest(path, 6 * 1024 * 1024 + 1), /input ceiling/);
    assert.equal(await reserveRequest(path, 10), 1);
    for (let i = 1; i < 72; i++) await reserveRequest(path, 10);
    await assert.rejects(reserveRequest(path, 10), /request ceiling/);
    const ledger = JSON.parse(await readFile(path, "utf8"));
    assert.equal(ledger.requests, 72);
    assert.equal(ledger.bytes, 720);
  } finally {
    if (oldConsent === undefined) delete process.env.PI_LIVE_COMPACTION;
    else process.env.PI_LIVE_COMPACTION = oldConsent;
    if (oldLimit === undefined) delete process.env.PI_COMPACTION_APPROVED_REQUESTS;
    else process.env.PI_COMPACTION_APPROVED_REQUESTS = oldLimit;
    await rm(dir, { recursive: true, force: true });
  }
});

test("experiment stream parser requires completed ordered output and counts cache tokens", async () => {
  const events = [
    { type: "response.output_item.done", output_index: 0, item: { type: "compaction", id: "cmp_fixture", encrypted_content: "synthetic" } },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [],
      usage: { input_tokens: 2000, output_tokens: 30, input_tokens_details: { cached_tokens: 1500, cache_write_tokens: 200 } } } },
  ];
  const sse = data => new Response(data.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  const result = await readEvents(sse(events));
  assert.equal(result.output[0].type, "compaction");
  assert.deepEqual(result.usage, { input: 2000, output: 30, cached: 1500, written: 200, reasoning: 0 });
  await assert.rejects(readEvents(sse(events.slice(0, 1))), /Incomplete stream/);
  await assert.rejects(readEvents(sse([{ ...events[0], output_index: 1 }, events[1]])), /contiguous/);
  assert.equal(summarizeUsage(undefined).cached, 0);
});
