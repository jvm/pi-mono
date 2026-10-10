import assert from "node:assert/strict";
import test from "node:test";
import { ENDPOINTS, resolveUsageRequest } from "../src/auth.ts";
import { cases, model, legacyToken } from "./fixtures.mjs";

function registry(auth, codex) {
  return {
    getApiKeyAndHeaders: async () => ({ ok: true, ...auth }),
    getProvider: provider => provider === "openai-codex" ? { baseUrl: cases[0].baseUrl } : undefined,
    getProviderAuth: async provider => {
      assert.equal(provider, "openai-codex");
      return codex;
    },
  };
}
const emptyStore = () => undefined;
for (const fixture of cases.filter(c => c.provider !== "github-copilot")) {
  test(`${fixture.provider}: use exactly Pi's resolved model auth and a fixed URL`, async () => {
    const result = await resolveUsageRequest(fixture.provider, model(fixture), registry({
      apiKey: fixture.token, headers: { "X-Other-Secret": "never-forward" },
    }), emptyStore);
    assert.equal(result.url, ENDPOINTS[fixture.provider]);
    assert.equal(result.provider, fixture.provider);
    assert.equal(result.headers.Authorization, `Bearer ${fixture.token}`);
    assert.equal(result.headers["X-Other-Secret"], undefined);
    if (fixture.provider === "openai-codex") assert.equal(result.headers["ChatGPT-Account-Id"], "fixture-account");
    if (fixture.provider === "anthropic") assert.equal(result.headers["anthropic-beta"], "oauth-2025-04-20");
  });
}

test("Copilot uses the GitHub token only from the exact active Pi grant", async () => {
  const f = cases[2];
  const stored = { type: "oauth", access: f.token, refresh: "unused-github-fixture", expires: Date.now() + 3600000 };
  const run = (auth, credential = stored) => resolveUsageRequest(f.provider, model(f), registry(auth), () => credential);
  const result = await run({ apiKey: f.token });
  assert.equal(result.headers.Authorization, `token ${stored.refresh}`);
  assert.equal(result.headers["X-Github-Api-Version"], "2025-04-01");
  await assert.rejects(run({ apiKey: "another-account" }), /Pi Copilot login required/);
  await assert.rejects(run({ apiKey: f.token, headers: { Authorization: "Bearer another-account" } }), /Pi Copilot login required/);
  await assert.rejects(run({ apiKey: f.token }, { ...stored, enterpriseUrl: "example.ghe.com" }), /enterprise quota unsupported/);
  await assert.rejects(run({ apiKey: f.token }, { type: "api_key", key: f.token }), /Pi Copilot login required/);
});

test("native SIWC without a Codex login remains unavailable and never supplies the legacy bearer", async () => {
  const m = { ...model(cases[0]), provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const read = provider => {
    assert.equal(provider, "openai");
    return { type: "oauth", access: "native-fixture", clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"] };
  };
  await assert.rejects(resolveUsageRequest("openai", m, registry({ apiKey: "native-fixture" }), read), /native quota unavailable/);
  await assert.rejects(resolveUsageRequest("openai", m, registry({ apiKey: "api-key-override" }), read), /subscription auth required/);
  await assert.rejects(resolveUsageRequest("openai-codex", model(cases[0]), registry({ apiKey: "native-fixture" }), read), /subscription auth required/);
});

test("openai resolves its temporary Codex fallback through Pi, independently of native auth", async () => {
  const m = { ...model(cases[0]), provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const r = registry({}, { source: "OAuth", auth: {
    apiKey: legacyToken, headers: { "X-Other-Secret": "never-forward" },
  } });
  r.getApiKeyAndHeaders = async () => assert.fail("Native auth is not the quota source");
  const result = await resolveUsageRequest("openai", m, r, () => assert.fail("Use Pi's resolver, not raw stored tokens"));
  assert.deepEqual(result, {
    provider: "openai-codex",
    url: ENDPOINTS["openai-codex"],
    headers: { Accept: "application/json", Authorization: `Bearer ${legacyToken}`, "ChatGPT-Account-Id": "fixture-account" },
  });
  assert.equal(m.provider, "openai");
});

test("Codex fallback rejects custom origins and respects effective auth overrides", async () => {
  const m = { ...model(cases[0]), provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const run = auth => resolveUsageRequest("openai", m, registry({}, { source: "OAuth", auth }), emptyStore);
  await assert.rejects(run({ apiKey: legacyToken, baseUrl: "https://proxy.invalid/v1" }), /custom endpoint unsupported/);
  const r = registry({});
  r.getProviderAuth = async () => assert.fail("Must reject custom origin before resolving its auth");
  for (const baseUrl of [undefined, "https://proxy.invalid/v1"]) {
    r.getProvider = () => ({ baseUrl });
    await assert.rejects(resolveUsageRequest("openai", m, r, emptyStore), /custom endpoint unsupported/);
  }
  await assert.rejects(resolveUsageRequest("openai", { ...m, baseUrl: "https://proxy.invalid/v1" }, r, emptyStore), /custom endpoint unsupported/);
  for (const headers of [
    { Authorization: null }, { Authorization: "Basic nope" },
    { authorization: "Bearer one", Authorization: "Bearer two" },
    { "x-api-key": "other" }, { "ChatGPT-Account-Id": "other-account" },
  ]) await assert.rejects(run({ apiKey: legacyToken, headers }), /auth required/);
  await assert.rejects(run({ apiKey: "native-fixture" }), /subscription auth required/);
  const result = await run({ apiKey: "unused-original", headers: { Authorization: `Bearer ${legacyToken}` } });
  assert.equal(result.headers.Authorization, `Bearer ${legacyToken}`);
});

test("Codex fallback does not use non-OAuth auth or raw expired credentials after refresh failure", async () => {
  const m = { ...model(cases[0]), provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const native = { type: "oauth", access: "native-fixture", clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"] };
  for (const codex of [undefined, { source: "API key", auth: { apiKey: legacyToken } }]) {
    await assert.rejects(resolveUsageRequest("openai", m, registry({ apiKey: native.access }, codex), () => native), /native quota unavailable/);
  }
  const noProvider = registry({ apiKey: native.access });
  noProvider.getProvider = () => undefined;
  noProvider.getProviderAuth = async () => assert.fail("Missing provider has no usable login");
  await assert.rejects(resolveUsageRequest("openai", m, noProvider, () => native), /native quota unavailable/);
  const r = registry({});
  r.getProviderAuth = async () => { throw new Error("refresh failed"); };
  await assert.rejects(resolveUsageRequest("openai", m, r, () => assert.fail("Do not bypass failed Pi refresh")), /refresh failed/);
});

test("custom model and resolved-auth origins are rejected before credential forwarding", async () => {
  for (const baseUrl of ["http://api.z.ai/v1", "https://api.z.ai.evil.test/v1", "https://key@api.z.ai/v1", "https://api.z.ai:123/v1", "not a url"]) {
    let called = false;
    const f = cases[3];
    await assert.rejects(resolveUsageRequest("zai", { ...model(f), baseUrl }, {
      getApiKeyAndHeaders: async () => { called = true; throw new Error("must not resolve"); },
    }, emptyStore), /custom endpoint unsupported/);
    assert.equal(called, false);
    await assert.rejects(resolveUsageRequest("zai", model(f), registry({ apiKey: f.token, baseUrl }), emptyStore), /custom endpoint unsupported/);
  }
  const cn = { ...model(cases[3]), provider: "zai-coding-cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" };
  const result = await resolveUsageRequest("zai-coding-cn", cn, registry({ apiKey: "cn-fixture" }), emptyStore);
  assert.equal(result.url, ENDPOINTS["zai-coding-cn"]);
  await assert.rejects(resolveUsageRequest("zai", cn, registry({ apiKey: "cn-fixture" }), emptyStore), /custom endpoint unsupported/);
});

test("auth overrides, removals and malformed tokens never fall back to stored auth", async () => {
  const f = cases[3];
  const run = headers => resolveUsageRequest("zai", model(f), registry({ apiKey: f.token, headers }), emptyStore);
  assert.equal((await run({ authorization: "Bearer override-fixture" })).headers.Authorization, "Bearer override-fixture");
  for (const headers of [
    { Authorization: null }, { Authorization: "Basic nope" },
    { authorization: "Bearer one", Authorization: "Bearer two" }, { "x-api-key": "other" },
    { Authorization: "Bearer secret\ninjection" },
  ]) await assert.rejects(run(headers), /auth required/);
  await assert.rejects(resolveUsageRequest("openai-codex", model(cases[0]), registry({
    apiKey: legacyToken, headers: { "ChatGPT-Account-Id": "other-account" },
  }), emptyStore), /auth required/);
  await assert.rejects(resolveUsageRequest("anthropic", model(cases[1]), registry({ apiKey: "sk-ant-api-fixture" }), emptyStore), /subscription auth required/);
});
