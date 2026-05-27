import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverModels,
  discoverOllamaProvider,
  normalizeBaseUrl,
  toOpenAIBaseUrl,
  toPiModel,
} from "../src/index.ts";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

test("normalizes Ollama host variants", () => {
  assert.equal(normalizeBaseUrl("localhost:11434"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("http://localhost:11434/api/"), "http://localhost:11434");
  assert.equal(toOpenAIBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
});

test("maps Ollama metadata to Pi model settings", () => {
  const model = toPiModel(
    { model: "gemma3:4b", details: { parameter_size: "4.3B", quantization_level: "Q4_K_M" } },
    {
      parameters: "temperature 0.7\nnum_ctx 8192\nnum_predict 2048",
      capabilities: ["completion", "vision"],
      details: { family: "gemma3", parameter_size: "4.3B", quantization_level: "Q4_K_M" },
      model_info: { "gemma3.context_length": 131072 },
    },
  );

  assert.deepEqual(model, {
    id: "gemma3:4b",
    name: "gemma3:4b (4.3B Q4_K_M, Ollama)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    },
  });
});

test("detects thinking models and uses model_info context length", () => {
  const model = toPiModel(
    { name: "qwen3:8b" },
    {
      capabilities: ["completion", "tools"],
      details: { family: "qwen3" },
      model_info: { "qwen3.context_length": 40960 },
    },
  );

  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 40960);
  assert.equal(model?.maxTokens, 16384);
  assert.deepEqual(model?.thinkingLevelMap, {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
  });
});

test("detects known vision families when Ollama omits the vision capability", () => {
  const model = toPiModel(
    { name: "gemma4:e2b-nvfp4" },
    {
      capabilities: ["completion", "tools", "thinking"],
      details: { family: "gemma4" },
      model_info: { "gemma4.context_length": 131072 },
    },
  );

  assert.deepEqual(model?.input, ["text", "image"]);
});

test("discovers all locally tagged models with show details", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init?.method });
    if (url.endsWith("/api/tags")) {
      return jsonResponse({ models: [{ model: "llama3.2:3b" }, { name: "gpt-oss:20b" }] });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(init.body);
      if (body.model === "gpt-oss:20b") {
        return jsonResponse({ capabilities: ["completion", "thinking"], parameters: "num_ctx 32768" });
      }
      return jsonResponse({ capabilities: ["completion"], model_info: { "llama.context_length": 128000 } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const models = await discoverModels("http://localhost:11434", 1000, fetch);

  assert.deepEqual(models.map((model) => model.id), ["gpt-oss:20b", "llama3.2:3b"]);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].thinkingLevelMap.off, null);
  assert.equal(models[1].contextWindow, 128000);
  assert.equal(requests.length, 3);
});

test("registers an empty provider when Ollama is unavailable", async () => {
  const provider = await discoverOllamaProvider({
    baseUrl: "http://localhost:11434",
    timeoutMs: 1000,
    fetch: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(provider.name, "Ollama (local)");
  assert.equal(provider.baseUrl, "http://localhost:11434/v1");
  assert.deepEqual(provider.models, []);
});
