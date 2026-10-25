// Explicitly authorized synthetic experiments only. Never imported by production.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, writeFile, rename, unlink } from "node:fs/promises";

export const ENDPOINT = "https://api.openai.com/v1/responses";
export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function initializeLedger(path) {
  assert.equal(process.env.PI_LIVE_COMPACTION, "1", "Explicit live consent required");
  assert.equal(process.env.PI_COMPACTION_APPROVED_REQUESTS, "72", "New 72-request allowance required");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ limit: 72, byteLimit: 6 * 1024 * 1024, requests: 0, bytes: 0 })); }
  finally { await file.close(); }
}
export async function reserveRequest(path, size) {
  assert.equal(process.env.PI_LIVE_COMPACTION, "1", "Explicit live consent required");
  assert.ok(Number.isSafeInteger(size) && size > 0);
  // One shared allowance across processes, including failed HTTP requests.
  const lock = await open(`${path}.lock`, "wx", 0o600);
  try {
    const ledger = JSON.parse(await readFile(path, "utf8"));
    assert.equal(ledger.limit, 72);
    assert.equal(ledger.byteLimit, 6 * 1024 * 1024);
    assert.ok(Number.isSafeInteger(ledger.requests) && ledger.requests >= 0 && ledger.requests < ledger.limit,
      "Approved request ceiling reached");
    assert.ok(Number.isSafeInteger(ledger.bytes) && ledger.bytes >= 0 && ledger.bytes + size <= ledger.byteLimit,
      "Approved input ceiling reached");
    ledger.requests++;
    ledger.bytes += size;
    await writeFile(`${path}.next`, JSON.stringify(ledger), { mode: 0o600 });
    await rename(`${path}.next`, path);
    return ledger.requests;
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}
export function summarizeUsage(usage) {
  return {
    input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0,
    cached: usage?.input_tokens_details?.cached_tokens ?? 0,
    written: usage?.input_tokens_details?.cache_write_tokens ?? 0,
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}
export async function readEvents(response) {
  assert.equal(response.ok, true, `HTTP ${response.status}; raw body withheld`);
  assert.ok(response.body);
  let bytes = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const events = [];
  // Synthetic text only; keep checkpoint material in memory, never in logs.
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(bytes <= 16 * 1024 * 1024, "Bounded experiment response");
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") events.push(JSON.parse(data));
    }
  }
  assert.ok(events.some(e => e.type === "response.completed"), "Incomplete stream; no retry");
  assert.equal(events.some(e => ["error", "response.failed", "response.incomplete"].includes(e.type)), false);
  const items = events.filter(e => e.type === "response.output_item.done").sort((a, b) => a.output_index - b.output_index);
  assert.ok(items.every((e, i) => e.output_index === i), "Require contiguous completed items");
  const complete = events.find(e => e.type === "response.completed").response;
  assert.equal(complete.status, "completed");
  return { output: items.map(e => e.item), usage: summarizeUsage(complete.usage), responseId: complete.id };
}
export const functionTool = (name, revision = 1) => ({
  type: "function", name, description: `Harmless synthetic fixture, revision ${revision}.`,
  parameters: { type: "object", properties: { value: { type: "string", enum: [revision === 1 ? "ORCHID" : "IRIS"] } },
    required: ["value"], additionalProperties: false }, strict: true,
});
export const rawTool = { type: "custom", name: "raw_fixture", description: "Harmless grammar fixture. Input is PING.",
  format: { type: "grammar", syntax: "lark", definition: 'start: "PING"' } };
export const namespace = tools => ({ type: "namespace", name: "functions", description: "Synthetic fixtures", tools });
export const inline = tools => ({ type: "additional_tools", role: "developer", tools });
export const developer = text => ({ role: "developer", content: [{ type: "input_text", text }] });
export const user = text => ({ role: "user", content: [{ type: "input_text", text }] });
export const stableNotes = (label, lines = 160) => `Synthetic experiment ${label}. ORCHID port 4317; rollback SAFE_MODE.\n` +
  Array.from({ length: lines }, (_, i) => `Reference ${i}: the synthetic ledger records an approved ORCHID deployment; preserve the port and rollback switch.`).join("\n");
export function toolOutputs(output) {
  return output.filter(i => ["function_call", "custom_tool_call"].includes(i.type)).map(i => ({
    type: i.type === "function_call" ? "function_call_output" : "custom_tool_call_output",
    call_id: i.call_id, output: "ORCHID port 4317; SAFE_MODE. Synthetic fixture succeeded.",
  }));
}
