import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, after } from "node:test";
import subsUsage from "../index.ts";
import { ENDPOINTS } from "../src/auth.ts";
import { STATUS_KEY, POLL_MS, TICK_MS } from "../src/monitor.ts";
import { REQUEST_TIMEOUT_MS } from "../src/http.ts";
import { cases, model, NOW, legacyToken } from "./fixtures.mjs";

let dir;
const originalEnv = { ...process.env };
const native = { ...cases[0], provider: "openai", baseUrl: "https://api.openai.com/v1", token: "native-fixture" };
const hyper = { ...cases[1], provider: "hyper", baseUrl: "https://hyper.charm.land/v1" };
const flush = () => new Promise(resolve => setImmediate(resolve));
const authKey = m => `${m.provider}/${m.id}`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-subs-usage-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_TELEMETRY = "0";
  delete process.env.PI_OFFLINE;
  await writeFile(join(dir, "auth.json"), JSON.stringify({
    "github-copilot": { type: "oauth", access: cases[2].token, refresh: "unused-github-fixture", expires: Date.now() + 3600000 },
    openai: { type: "oauth", access: native.token, refresh: "unused-fixture", expires: Date.now() + 3600000,
      clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"] },
  }), { mode: 0o600 });
});
after(async () => {
  process.env = originalEnv;
  await rm(dir, { recursive: true, force: true });
});

function harness(t, { mode = "tui", configured = cases, selected = configured[0] } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map([["another-extension", "keep me"]]);
  const history = [];
  const auth = new Map();
  const authReads = [];
  let models = [];
  let availableReads = 0;
  let codexAuth;
  let codexAuthReads = 0;
  const configure = fixtures => {
    models = fixtures.map(model);
    for (const fixture of fixtures) auth.set(authKey(fixture), { ok: true, apiKey: fixture.token });
  };
  configure(configured);
  const ctx = {
    mode, model: selected && model(selected), isProjectTrusted: () => false,
    modelRegistry: {
      getAvailable: () => { availableReads++; return models; },
      getApiKeyAndHeaders: async m => {
        authReads.push(authKey(m));
        const value = auth.get(authKey(m));
        return typeof value === "function" ? value(m) : value ?? { ok: false };
      },
      getProvider: provider => provider === "openai-codex" ? { baseUrl: cases[0].baseUrl } : undefined,
      getProviderAuth: async provider => {
        assert.equal(provider, "openai-codex");
        codexAuthReads++;
        return typeof codexAuth === "function" ? codexAuth() : codexAuth;
      },
    },
    ui: {
      setStatus: (key, value) => { history.push([key, value]); statuses.set(key, value); },
      notify: () => {},
    },
  };
  subsUsage({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(() => emit("session_shutdown"));
  return {
    ctx, statuses, history, emit, configure, authReads,
    get availableReads() { return availableReads; },
    get codexAuthReads() { return codexAuthReads; },
    status: () => statuses.get(STATUS_KEY),
    auth: (value, fixture = ctx.model) => auth.set(authKey(fixture), value),
    codexAuth: value => { codexAuth = value; },
    command: args => commands.get("subs-usage").handler(args, ctx),
    select: fixture => {
      ctx.model = model(fixture);
      return emit("model_select", { model: ctx.model });
    },
  };
}

function mockUsage(t) {
  return t.mock.method(globalThis, "fetch", async (url, init) => {
    const fixture = cases.find(f => ENDPOINTS[f.provider] === url);
    assert.ok(fixture, "only fixed supported quota routes may be called");
    const expected = fixture.provider === "github-copilot" ? "token unused-github-fixture" : `Bearer ${fixture.token}`;
    assert.equal(init.headers.Authorization, expected);
    return Response.json(fixture.payload);
  });
}

test("entrypoint preloads all configured services without blocking startup; switching is a cache-only operation", async t => {
  const h = harness(t);
  const fetch = mockUsage(t);
  assert.equal(h.emit("session_start"), undefined);
  assert.equal(h.status(), "[loading]");
  await flush();
  assert.equal(fetch.mock.callCount(), cases.length);
  assert.equal(h.authReads.length, cases.length);
  for (const fixture of cases) {
    // The reading changes synchronously, not after an auth or HTTP round trip.
    h.select(fixture);
    assert.ok(h.status().startsWith(`[${fixture.expected}`), h.status());
    assert.ok(h.status().endsWith("]"), h.status());
    assert.equal(h.statuses.get("another-extension"), "keep me");
  }
  await h.emit("agent_end");
  assert.equal(h.availableReads, 1);
  assert.equal(h.authReads.length, cases.length);
  assert.equal(fetch.mock.callCount(), cases.length);
  await h.command("refresh");
  assert.equal(fetch.mock.callCount(), cases.length * 2);

  await h.command("off");
  assert.equal(h.status(), undefined);
  h.select(cases[0]);
  await h.command("refresh");
  assert.equal(fetch.mock.callCount(), cases.length * 2);
  await h.command("on");
  await flush();
  assert.equal(fetch.mock.callCount(), cases.length * 3);
  await h.command("");
  assert.equal(fetch.mock.callCount(), cases.length * 4);
  h.select({ ...cases[0], provider: "unsupported" });
  assert.equal(h.status(), undefined);
  await h.emit("session_shutdown");
  assert.equal(h.status(), undefined);
  assert.ok(h.history.every(([key]) => key === STATUS_KEY));
});

test("Hyper has no quota requests or own status; other configured providers still poll while Hyper is selected", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const h = harness(t, { configured: [...cases, hyper], selected: hyper });
  h.statuses.set("provider-extension-usage", "12.5 HC left");
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  assert.equal(h.status(), undefined);
  assert.equal(fetch.mock.callCount(), cases.length);
  assert.equal(h.authReads.length, cases.length);
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.equal(fetch.mock.callCount(), cases.length * 2);
  assert.equal(h.authReads.some(key => key.startsWith("hyper/")), false);
  h.select(cases[4]);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  h.select(hyper);
  assert.equal(h.status(), undefined);
  assert.equal(fetch.mock.callCount(), cases.length * 2);
  assert.equal(h.statuses.get("provider-extension-usage"), "12.5 HC left");
});

test("startup with no selected model still warms the configured providers", async t => {
  const h = harness(t, { selected: null });
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  assert.equal(h.status(), undefined);
  assert.equal(fetch.mock.callCount(), cases.length);
  h.select(cases[3]);
  assert.ok(h.status().startsWith(`[${cases[3].expected}`));
  assert.equal(fetch.mock.callCount(), cases.length);
});

test("Claude model windows are precomputed from one shared request, not queried on model changes", async t => {
  const opus = { ...cases[1], id: "claude-opus-4-6" };
  const h = harness(t, { configured: [cases[1], opus] });
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    ...cases[1].payload, seven_day_sonnet: { utilization: 10 }, seven_day_opus: { utilization: 90 },
  }));
  h.emit("session_start");
  await flush();
  assert.match(h.status(), /sonnet 7d █░░░░░ 10%/);
  h.select(opus);
  assert.match(h.status(), /opus 7d █████░ 90%/);
  assert.doesNotMatch(h.status(), /sonnet/);
  h.select(cases[1]);
  assert.match(h.status(), /sonnet 7d █░░░░░ 10%/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.authReads.length, 2);
});

test("hidden per-model auth overrides do not share another account's cache", async t => {
  const other = { ...cases[4], id: "other-model", token: "unused-other-account" };
  const h = harness(t, { configured: [cases[4], other] });
  h.auth({ ok: true, apiKey: cases[4].token, headers: { Authorization: `Bearer ${other.token}` } }, other);
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => Response.json({
    usage: { rolling: { percent: init.headers.Authorization === `Bearer ${other.token}` ? 72 : 31 } },
  }));
  h.emit("session_start");
  await flush();
  assert.match(h.status(), /31%/);
  h.select(other);
  assert.match(h.status(), /72%/);
  assert.equal(fetch.mock.callCount(), 2);
  h.auth({ ok: true, apiKey: cases[4].token, headers: { Authorization: null } }, other);
  await h.command("refresh");
  assert.equal(h.status(), "[auth required]");
  h.select(cases[4]);
  assert.match(h.status(), /31%/);
  assert.equal(fetch.mock.callCount(), 3);
});

for (const [provider, baseUrl] of [
  ["zai", "https://api.z.ai/api/coding/paas/v4"],
  ["zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
]) {
  test(`${provider}: the status filters MCP out and retains model quotas`, async t => {
    const h = harness(t, { configured: [{ ...cases[3], provider, baseUrl }] });
    const mcp = { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 90 };
    const payload = { success: true, code: 200, data: { limits: [
      mcp,
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 20 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40 },
    ] } };
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    h.emit("session_start");
    await flush();
    assert.equal(h.status(), "[5h █░░░░░ 20% | 7d ██░░░░ 40%]");
    payload.data.limits = [mcp];
    await h.command("refresh");
    assert.equal(h.status(), "[quota unavailable]");
  });
}

test("a slow provider does not block other providers, and switching neither cancels nor replaces its background request", async t => {
  const h = harness(t, { configured: [cases[0], cases[4]] });
  let resolveOld;
  let oldSignal;
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === ENDPOINTS["openai-codex"]) {
      oldSignal = init.signal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return Response.json(cases[4].payload);
  });
  h.emit("session_start");
  await flush();
  assert.equal(h.status(), "[loading]");
  h.select(cases[4]);
  assert.equal(oldSignal.aborted, false);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  resolveOld(Response.json(cases[0].payload));
  await flush();
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  h.select(cases[0]);
  assert.ok(h.status().startsWith(`[${cases[0].expected}`));
  assert.equal(fetch.mock.callCount(), 2);
});

for (const stop of ["off", "session_shutdown"]) {
  test(`${stop} cancels all providers and ignores late auth and HTTP results`, async t => {
    const h = harness(t, { configured: [cases[0], cases[4]] });
    let resolveAuth;
    let resolveFetch;
    let signal;
    h.auth(() => new Promise(resolve => { resolveAuth = resolve; }), cases[0]);
    const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
      signal = init.signal;
      return new Promise(resolve => { resolveFetch = resolve; });
    });
    h.emit("session_start");
    await flush();
    const pending = h.command("refresh"); // Joins the current cycle.
    if (stop === "off") await h.command("off");
    else h.emit(stop);
    assert.equal(signal.aborted, true);
    resolveAuth({ ok: true, apiKey: cases[0].token });
    resolveFetch(Response.json(cases[4].payload));
    await pending;
    await flush();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(h.status(), undefined);
  });
}

test("fresh account auth clears old usage and failures never retain a misleading bar", async t => {
  const h = harness(t, { configured: [cases[4]] });
  let resolveNew;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.Authorization === "Bearer new-account-fixture") return new Promise(resolve => { resolveNew = resolve; });
    return Response.json({ usage: { rolling: { percent: 99 } } });
  });
  h.emit("session_start");
  await flush();
  assert.equal(h.status(), "[5h ██████ 99%]");
  h.auth({ ok: true, apiKey: "new-account-fixture" });
  const pending = h.command("refresh");
  await flush();
  assert.equal(h.status(), "[loading]");
  resolveNew(new Response("Bearer sensitive", { status: 403 }));
  await pending;
  assert.equal(h.status(), "[access denied]");
  h.auth({ ok: false, error: "secret failure details" });
  await h.command("refresh");
  assert.equal(h.status(), "[auth required]");
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode}: no quota discovery, auth, requests, or UI calls`, async t => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
    const h = harness(t, { mode, configured: [...cases, native] });
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
    h.emit("session_start");
    h.select(cases[4]);
    h.codexAuth({ source: "OAuth", auth: { apiKey: legacyToken } });
    h.select(native);
    await h.emit("agent_end");
    await h.command("on");
    t.mock.timers.tick(POLL_MS * 3);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(h.availableReads, 0);
    assert.equal(h.authReads.length, 0);
    assert.equal(h.codexAuthReads, 0);
    assert.equal(h.history.length, 0);
  });
}

test("offline mode makes no quota request or auth resolution for any configured provider", async t => {
  process.env.PI_OFFLINE = "true";
  t.after(() => delete process.env.PI_OFFLINE);
  const h = harness(t, { configured: [...cases, native] });
  t.mock.method(globalThis, "fetch", async () => assert.fail("offline"));
  h.emit("session_start");
  assert.equal(h.status(), "[offline]");
  h.select(native);
  assert.equal(h.status(), "[offline]");
  assert.equal(h.availableReads, 0);
  assert.equal(h.authReads.length, 0);
  assert.equal(h.codexAuthReads, 0);
});

test("native OpenAI without a Codex login caches the limitation without a quota request", async t => {
  const h = harness(t, { configured: [native] });
  t.mock.method(globalThis, "fetch", async () => assert.fail("native OAuth must not query quota"));
  h.emit("session_start");
  await flush();
  assert.equal(h.status(), "[native quota unavailable]");
});

test("Codex and native OpenAI fallback share one quota request without changing inference", async t => {
  const h = harness(t, { configured: [native, cases[0]] });
  h.codexAuth({ source: "OAuth", auth: { apiKey: legacyToken } });
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  assert.match(h.status(), /^\[5h █░░░░░ 19%.*7d █░░░░░ 20%.*\]$/);
  assert.equal(h.ctx.model.provider, "openai");
  h.select(cases[0]);
  h.select(native);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(h.authReads, [authKey(cases[0])]);
  assert.equal(h.codexAuthReads, 1);
});

test("fallback failures and logout clear former readings without sending the native bearer", async t => {
  const h = harness(t, { configured: [native] });
  h.codexAuth({ source: "OAuth", auth: { apiKey: legacyToken } });
  let fail = false;
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, ENDPOINTS["openai-codex"]);
    assert.equal(init.headers.Authorization, `Bearer ${legacyToken}`);
    return fail ? new Response("sensitive", { status: 403 }) : Response.json(cases[0].payload);
  });
  h.emit("session_start");
  await flush();
  fail = true;
  await h.command("refresh");
  assert.equal(h.status(), "[access denied]");
  h.codexAuth(undefined);
  await h.command("refresh");
  assert.equal(h.status(), "[native quota unavailable]");
  h.codexAuth(async () => { throw new Error("sensitive OAuth refresh error"); });
  await h.command("refresh");
  assert.equal(h.status(), "[request failed]");
  assert.equal(fetch.mock.callCount(), 2);
});

test("late fallback auth warms its cache after switching but cannot replace the selected provider's meter", async t => {
  const h = harness(t, { configured: [native, cases[4]] });
  let resolveAuth;
  h.codexAuth(() => new Promise(resolve => { resolveAuth = resolve; }));
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  h.select(cases[4]);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  resolveAuth({ source: "OAuth", auth: { apiKey: legacyToken } });
  await flush();
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  h.select(native);
  assert.match(h.status(), /19%/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("switching fallback accounts clears the former account's cache before the next response", async t => {
  const h = harness(t, { configured: [native] });
  const nextToken = `fixture.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "next-fixture-account" },
  })).toString("base64url")}.fixture`;
  h.codexAuth({ source: "OAuth", auth: { apiKey: legacyToken } });
  let resolveNext;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.Authorization === `Bearer ${nextToken}`) {
      assert.equal(init.headers["ChatGPT-Account-Id"], "next-fixture-account");
      return new Promise(resolve => { resolveNext = resolve; });
    }
    return Response.json(cases[0].payload);
  });
  h.emit("session_start");
  await flush();
  h.codexAuth({ source: "OAuth", auth: { apiKey: nextToken } });
  const pending = h.command("refresh");
  await flush();
  assert.equal(h.status(), "[loading]");
  resolveNext(Response.json({ rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 18000 } } }));
  await pending;
  assert.equal(h.status(), "[5h ████░░ 70%]");
  assert.equal(h.authReads.length, 0);
});

test("idle polling refreshes every provider on the original clock, not on turns or switches", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const h = harness(t);
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  t.mock.timers.tick(POLL_MS - TICK_MS);
  h.select(cases[4]);
  await h.emit("agent_end");
  assert.equal(fetch.mock.callCount(), cases.length);
  assert.match(h.status(), /↻9m/); // Cached relative reset has not moved forward on selection.
  t.mock.timers.tick(TICK_MS);
  await flush();
  assert.equal(fetch.mock.callCount(), cases.length * 2);
  assert.match(h.status(), /↻10m/);
  h.emit("session_shutdown");
  t.mock.timers.tick(POLL_MS * 10);
  assert.equal(fetch.mock.callCount(), cases.length * 2);
});

test("usage drained by another session updates an inactive provider's cache", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const h = harness(t, { configured: [cases[0], cases[4]] });
  let percent = 3;
  const fetch = t.mock.method(globalThis, "fetch", async url => Response.json(
    url === ENDPOINTS["openai-codex"] ? cases[0].payload : { usage: { rolling: { percent } } },
  ));
  h.emit("session_start");
  await flush();
  percent = 67;
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.equal(h.ctx.model.provider, "openai-codex"); // Go has never been selected.
  assert.equal(fetch.mock.callCount(), 4);
  h.select(cases[4]);
  assert.equal(h.status(), "[5h ████░░ 67%]");
  assert.equal(fetch.mock.callCount(), 4);
});

test("background refresh retains cached readings; in-flight refreshes deduplicate and a timeout affects only unfinished providers", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const h = harness(t, { configured: [cases[0], cases[4]] });
  let hang = false;
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    if (url === ENDPOINTS["openai-codex"]) return hang ? new Promise(() => {}) : Response.json(cases[0].payload);
    return Response.json(cases[4].payload);
  });
  h.emit("session_start");
  await flush();
  hang = true;
  const first = h.command("refresh");
  const second = h.command("refresh");
  await flush();
  assert.equal(fetch.mock.callCount(), 4);
  assert.ok(h.status().startsWith(`[${cases[0].expected}`));
  h.select(cases[4]);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await Promise.all([first, second]);
  h.select(cases[0]);
  assert.equal(h.status(), "[request failed]");
  h.select(cases[4]);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  assert.equal(fetch.mock.callCount(), 4);
});

test("auth timeout is bounded for a whole provider, cannot block other providers, and permits the next poll", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const extra = { ...cases[0], id: "other-codex-model" };
  const h = harness(t, { configured: [cases[0], extra, cases[4]] });
  h.auth(() => new Promise(() => {}), cases[0]);
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  h.select(cases[4]);
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await flush();
  h.select(extra);
  assert.equal(h.status(), "[request failed]");
  assert.equal(fetch.mock.callCount(), 1);
  h.auth({ ok: true, apiKey: cases[0].token }, cases[0]);
  t.mock.timers.tick(POLL_MS - REQUEST_TIMEOUT_MS);
  await flush();
  assert.ok(h.status().startsWith(`[${cases[0].expected}`));
  assert.equal(fetch.mock.callCount(), 3);
});

test("each poll discovers newly configured providers and removes obsolete cached models", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  const h = harness(t, { configured: [cases[0]] });
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  h.configure([cases[0], cases[4]]);
  h.select(cases[4]);
  assert.equal(h.status(), "[usage unavailable]");
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  assert.equal(fetch.mock.callCount(), 3);
  h.configure([cases[4]]);
  t.mock.timers.tick(POLL_MS);
  await flush();
  h.select(cases[0]);
  assert.equal(h.status(), "[usage unavailable]");
  assert.equal(fetch.mock.callCount(), 4);
});

test("inactive custom endpoints fail closed without preventing safe providers from loading", async t => {
  const custom = { ...cases[0], baseUrl: "https://proxy.example/v1" };
  const h = harness(t, { configured: [custom, cases[4]], selected: cases[4] });
  const fetch = mockUsage(t);
  h.emit("session_start");
  await flush();
  assert.ok(h.status().startsWith(`[${cases[4].expected}`));
  h.select(custom);
  assert.equal(h.status(), "[custom endpoint unsupported]");
  assert.deepEqual(h.authReads, [authKey(cases[4])]);
  assert.equal(fetch.mock.callCount(), 1);
});

test("a replacement session ignores every old provider response without clearing the new cache", async t => {
  const h = harness(t, { configured: [cases[0], cases[4]] });
  const old = [];
  let hang = true;
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (hang) return new Promise(resolve => old.push({ resolve, signal: init.signal }));
    return Response.json(url === ENDPOINTS["openai-codex"] ? cases[0].payload : cases[4].payload);
  });
  h.emit("session_start");
  await flush();
  assert.equal(old.length, 2);
  hang = false;
  h.emit("session_start");
  await flush();
  assert.ok(old.every(({ signal }) => signal.aborted));
  for (const { resolve } of old) resolve(new Response("sensitive late failure", { status: 403 }));
  await flush();
  for (const fixture of [cases[0], cases[4]]) {
    h.select(fixture);
    assert.ok(h.status().startsWith(`[${fixture.expected}`));
  }
  assert.equal(fetch.mock.callCount(), 4);
  await h.command("refresh");
  assert.equal(fetch.mock.callCount(), 6);
});

test("going offline cancels all in-flight quota work and resuming warms every provider", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: NOW });
  t.after(() => delete process.env.PI_OFFLINE);
  const h = harness(t, { configured: [cases[0], cases[4]] });
  const old = [];
  let hang = true;
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (hang) return new Promise(resolve => old.push({ resolve, signal: init.signal }));
    return Response.json(url === ENDPOINTS["openai-codex"] ? cases[0].payload : cases[4].payload);
  });
  h.emit("session_start");
  await flush();
  process.env.PI_OFFLINE = "true";
  await h.command("refresh");
  assert.ok(old.every(({ signal }) => signal.aborted));
  for (const { resolve } of old) resolve(Response.json({}));
  await flush();
  assert.equal(h.status(), "[offline]");
  assert.equal(fetch.mock.callCount(), 2);
  hang = false;
  delete process.env.PI_OFFLINE;
  t.mock.timers.tick(TICK_MS);
  await flush();
  for (const fixture of [cases[0], cases[4]]) {
    h.select(fixture);
    assert.ok(h.status().startsWith(`[${fixture.expected}`));
  }
  assert.equal(fetch.mock.callCount(), 4);
});
