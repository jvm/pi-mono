import assert from "node:assert/strict";
import test from "node:test";

process.env.CI = "1";

const { default: piCodexCompaction } = await import("../extensions/index.ts");
const {
  REMOTE_SUMMARY_MARKER,
  applyRemoteCompactionMarker,
  boundCompactionInput,
  buildFallbackSummary,
  createRemoteCompaction,
  parseCompactionSse,
  requestRemoteCompaction,
  resolveCodexResponsesUrl,
  supportsRemoteCompaction,
} = await import("../src/index.ts");

const model = {
  id: "gpt-5.6-sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 128_000,
  maxTokens: 128_000,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const token = [
  "header",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } })).toString("base64url"),
  "signature",
].join(".");

function preparation(overrides = {}) {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [{ role: "user", content: "discard this", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 50_000,
    fileOps: { read: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    ...overrides,
  };
}

function makePi() {
  const handlers = new Map();
  const pi = {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
  };
  piCodexCompaction(pi);
  return pi;
}

function makeContext(overrides = {}) {
  return {
    model,
    hasUI: false,
    ui: { notify() {} },
    getSystemPrompt: () => "system",
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: token, headers: { "x-test": "yes" } };
      },
    },
    sessionManager: {
      getSessionId: () => "session_test",
      buildContextEntries: () => [],
    },
    ...overrides,
  };
}

test("confirms the Codex provider/API capability contract", () => {
  assert.equal(supportsRemoteCompaction(model), true);
  assert.equal(supportsRemoteCompaction({ ...model, provider: "openai" }), false);
  assert.equal(supportsRemoteCompaction({ ...model, api: "openai-responses" }), false);
});

test("resolves only HTTPS Codex Responses endpoints", () => {
  assert.equal(resolveCodexResponsesUrl("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(resolveCodexResponsesUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/codex/responses");
  assert.throws(() => resolveCodexResponsesUrl("http://localhost:1234"), /HTTPS/);
  assert.throws(() => resolveCodexResponsesUrl("https://user:pass@chatgpt.com/backend-api"), /credentials/);
});

test("parses the completed remote compaction checkpoint", () => {
  const sse = [
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque-checkpoint" } })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}`,
    "",
  ].join("\n\n");
  assert.equal(parseCompactionSse(sse), "opaque-checkpoint");
  assert.throws(() => parseCompactionSse("data: {}\n\n"), /before response completion/);
});

test("uses the remote checkpoint and keeps Pi's retained user out of the request", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response([
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque-checkpoint" } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}`,
      "",
    ].join("\n\n"), { status: 200 });
  };

  try {
    const context = makeContext({
      sessionManager: {
        getSessionId: () => "session_test",
        buildContextEntries: () => [{
          type: "message",
          message: { role: "user", content: "retained", timestamp: 0 },
        }],
      },
    });
    const result = await createRemoteCompaction(
      { preparation: preparation(), signal: new AbortController().signal },
      context,
      () => [],
    );

    assert.equal(result.details.encryptedContent, "opaque-checkpoint");
    assert.equal(result.summary.includes(REMOTE_SUMMARY_MARKER), true);
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.input.at(-1).type, "compaction_trigger");
    assert.equal(body.input.some((item) => JSON.stringify(item).includes("discard this")), true);
    assert.equal(body.input.some((item) => JSON.stringify(item).includes("retained")), false);
    assert.equal(requests[0].init.headers.get("x-codex-beta-features"), "remote_compaction_v2");
    assert.equal(requests[0].init.headers.get("chatgpt-account-id"), "acct_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("honors an already-aborted compaction signal", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSignal;
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    throw new Error("fetch called");
  };

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  try {
    await assert.rejects(
      () => requestRemoteCompaction({ model, apiKey: token, body: {}, signal: controller.signal }),
      /fetch called/,
    );
    assert.equal(capturedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rehydrates an opaque checkpoint only in the textual compaction slot", () => {
  const payload = {
    model: model.id,
    input: [
      { role: "user", content: [{ type: "input_text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${REMOTE_SUMMARY_MARKER}\nfallback\n</summary>` }] },
      { role: "user", content: [{ type: "input_text", text: "kept" }] },
    ],
  };
  const updated = applyRemoteCompactionMarker(payload, {
    kind: "pi-codex-compaction",
    version: 1,
    provider: "openai-codex",
    model: model.id,
    encryptedContent: "opaque-checkpoint",
  });

  assert.deepEqual(updated.input[0], { type: "compaction", encrypted_content: "opaque-checkpoint" });
  assert.equal(payload.input[0].content[0].text.includes(REMOTE_SUMMARY_MARKER), true);

  const summarizationPrompt = {
    input: [{ role: "user", content: [{ type: "input_text", text: `<conversation>${REMOTE_SUMMARY_MARKER}</conversation>` }] }],
  };
  assert.equal(applyRemoteCompactionMarker(summarizationPrompt, {
    kind: "pi-codex-compaction",
    version: 1,
    provider: "openai-codex",
    model: model.id,
    encryptedContent: "opaque-checkpoint",
  }), undefined);
});

test("reduces tool outputs before rejecting an input that cannot fit the active model", () => {
  const input = [
    { type: "function_call_output", call_id: "call", output: "x".repeat(50_000) },
    { type: "tool_search_output", call_id: "search", tools: [{ name: "large", description: "x".repeat(10_000) }] },
    { type: "compaction_trigger" },
  ];
  const bounded = boundCompactionInput(input, "system", [], 20_000);
  assert.equal(bounded[0].output.startsWith("[Tool output omitted"), true);
  assert.deepEqual(bounded[1].tools, []);
  assert.equal(boundCompactionInput([{ type: "message", content: [{ text: "x".repeat(100_000) }] }], "system", [], 1_000), undefined);
  assert.equal(boundCompactionInput([{ type: "message", content: [{ text: "a".repeat(2_000) }] }], "system", [], 1_000), undefined);
});

test("keeps a bounded readable fallback for model switches", () => {
  const summary = buildFallbackSummary(
    preparation({ messagesToSummarize: [{ role: "user", content: "x".repeat(50_000), timestamp: 1 }] }),
    [{ role: "user", content: "x".repeat(50_000), timestamp: 1 }],
  );
  assert.equal(summary.length <= 12_000 + 200, true);
  assert.match(summary, /codex-compaction-fallback/);
});

test("registers and wires the compaction/request hooks", async () => {
  const pi = makePi();
  assert.equal(typeof pi.handlers.get("session_before_compact"), "function");
  assert.equal(typeof pi.handlers.get("before_provider_headers"), "function");
  assert.equal(typeof pi.handlers.get("before_provider_request"), "function");

  const headers = {};
  await pi.handlers.get("before_provider_headers")({ headers }, makeContext());
  assert.equal(headers["x-codex-beta-features"], "remote_compaction_v2");

  const existingHeaders = { "x-codex-beta-features": "other, remote_compaction_v2" };
  await pi.handlers.get("before_provider_headers")({ headers: existingHeaders }, makeContext());
  assert.equal(existingHeaders["x-codex-beta-features"], "other,remote_compaction_v2");

  const details = {
    kind: "pi-codex-compaction",
    version: 1,
    provider: "openai-codex",
    model: model.id,
    encryptedContent: "opaque-checkpoint",
  };
  const context = makeContext({
    sessionManager: {
      getSessionId: () => "session_test",
      buildContextEntries: () => [{ type: "compaction", details }],
    },
  });
  const rewritten = await pi.handlers.get("before_provider_request")({
    payload: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `The conversation history before this point was compacted into the following summary:\n${REMOTE_SUMMARY_MARKER}` }],
      }],
    },
  }, context);
  assert.deepEqual(rewritten.input[0], { type: "compaction", encrypted_content: "opaque-checkpoint" });
});
