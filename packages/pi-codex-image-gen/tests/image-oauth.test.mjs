import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import test from "node:test";
import extension from "../.test-dist/extensions/index.js";
import { extractImageAccountId, IMAGE_AUTH_PROVIDER, imageAuthProvider, imageOAuth, parseImageOAuthCallback } from "../.test-dist/src/image-oauth.js";

const REDIRECT = "http://localhost:1455/auth/callback";
const CODE = "test-only-authorization-code";
const REFRESH = "test-only-refresh-token";

function jwt(accountId = "test-account") {
  const data = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${data}.signature`;
}

function callback(authorize, code = CODE) {
  const url = new URL(REDIRECT);
  url.searchParams.set("state", authorize.searchParams.get("state"));
  url.searchParams.set("code", code);
  return url.href;
}

function mockTokenFetch(t, responder = () => Response.json({ access_token: jwt(), refresh_token: REFRESH, expires_in: 3600 })) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://auth.openai.com/oauth/token");
    requests.push(init);
    return responder(init);
  };
  return { requests, original };
}

function interaction(prompt) {
  const events = [];
  const controller = new AbortController();
  let authorize;
  return {
    controller, events,
    get authorize() { return authorize; },
    value: {
      signal: controller.signal,
      notify(event) {
        events.push(event);
        if (event.type === "auth_url") authorize = new URL(event.url);
      },
      prompt: params => prompt(authorize, params, controller),
    },
  };
}

function pendingPrompt(_authorize, { signal }) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("test-only-cancel"));
    else signal.addEventListener("abort", () => reject(new Error("test-only-cancel")), { once: true });
  });
}

test("extension registers an auth-only provider and Pi owns credential persistence and logout", async t => {
  const h = mockTokenFetch(t);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "oauth", access: "test-only-chat-token", refresh: "chat-refresh", expires: Date.now() + 3600000 }));
  const models = createModels({ credentials });
  extension({
    registerProvider(provider) {
      assert.equal(provider.id, IMAGE_AUTH_PROVIDER);
      assert.equal(provider.auth.oauth.isSubscription, true);
      assert.deepEqual(provider.getModels(), []);
      models.setProvider(provider);
    },
    registerTool() {},
    registerCommand() {},
  });
  const ui = interaction(async authorize => callback(authorize));
  await models.login(IMAGE_AUTH_PROVIDER, "oauth", ui.value);
  const saved = await credentials.read(IMAGE_AUTH_PROVIDER);
  assert.equal(saved.access, jwt());
  assert.equal(saved.refresh, REFRESH);
  assert.equal(saved.accountId, "test-account");
  assert.equal((await models.getAuth(IMAGE_AUTH_PROVIDER)).source, "OAuth");
  assert.equal((await models.getAuth(IMAGE_AUTH_PROVIDER)).auth.apiKey, jwt());
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.redirect, "error");
  assert.equal(request.body.get("grant_type"), "authorization_code");
  assert.equal(request.body.get("code"), CODE);
  assert.equal(request.body.get("redirect_uri"), REDIRECT);
  assert.equal(request.body.get("client_id"), ui.authorize.searchParams.get("client_id"));
  assert.equal(createHash("sha256").update(request.body.get("code_verifier")).digest("base64url"),
    ui.authorize.searchParams.get("code_challenge"));
  assert.equal(ui.authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(ui.authorize.searchParams.get("state").length >= 43);
  await models.logout(IMAGE_AUTH_PROVIDER);
  assert.equal(await credentials.read(IMAGE_AUTH_PROVIDER), undefined);
  assert.equal((await credentials.read("openai")).access, "test-only-chat-token");
});

test("loopback callback rejects wrong state, accepts a valid callback, and closes the port", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    const invalid = new URL(callback(authorize));
    invalid.hostname = "127.0.0.1";
    invalid.searchParams.set("state", "wrong-state");
    const rejected = await h.original(invalid);
    assert.equal(rejected.status, 400);
    const text = await rejected.text();
    assert.ok(!text.includes(CODE) && !text.includes("wrong-state"));
    const valid = new URL(callback(authorize));
    valid.hostname = "127.0.0.1";
    const accepted = await h.original(valid);
    assert.equal(accepted.status, 200);
    await accepted.text();
    return pendingPrompt(authorize, params);
  });
  const saved = await imageOAuth.login(ui.value);
  assert.equal(saved.access, jwt());
  assert.equal(h.requests.length, 1);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("occupied callback port falls back to a state-checked full redirect URL", async t => {
  const server = createServer((_request, response) => response.end("test-only-listener"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(1455, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    assert.match(params.message, /local callback port is unavailable/);
    assert.match(params.message, /full redirect URL/);
    return callback(authorize);
  });
  await imageOAuth.login(ui.value);
  assert.ok(ui.events.some(event => event.type === "info" && /port/.test(event.message)));
  const auth = ui.events.find(event => event.type === "auth_url");
  assert.match(auth.instructions, /local callback port is unavailable/);
  assert.match(auth.instructions, /full redirect URL/);
});

test("callback validation rejects stale, duplicate, denied, oversized, and untrusted inputs", () => {
  const valid = `${REDIRECT}?state=expected&code=${CODE}`;
  assert.equal(parseImageOAuthCallback(valid, "expected"), CODE);
  for (const url of [
    CODE, valid.replace("localhost", "evil.example"), valid.replace("/auth/callback", "/other"),
    valid.replace("state=expected", "state=stale"), `${valid}&state=expected`, `${valid}&code=another`,
    `${valid}&error=access_denied`, `${REDIRECT}?state=expected`, `${valid}${"x".repeat(8192)}`,
    valid.replace("localhost", "userinfo@localhost"), `${valid}#fragment`,
  ]) assert.throws(() => parseImageOAuthCallback(url, "expected"), error =>
    /Invalid image OAuth callback|authorization was denied/.test(error.message) && !error.message.includes(CODE));
});

test("denied loopback authorization ends login without exposing backend error details", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    const url = new URL(callback(authorize));
    url.hostname = "127.0.0.1";
    url.searchParams.delete("code");
    url.searchParams.set("error", "test-only-private-error");
    url.searchParams.set("error_description", REFRESH);
    const response = await h.original(url);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes(REFRESH));
    return pendingPrompt(authorize, params);
  });
  await assert.rejects(imageOAuth.login(ui.value), error =>
    /authorization was denied/.test(error.message) && !error.message.includes(REFRESH));
  assert.equal(h.requests.length, 0);
});

test("manual callback errors never reach token exchange", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async () => `${REDIRECT}?state=stale&code=${CODE}`);
  await assert.rejects(imageOAuth.login(ui.value), /Invalid image OAuth callback/);
  assert.equal(h.requests.length, 0);
});

test("login cancellation stops promptly and closes its callback listener", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params, controller) => {
    controller.abort();
    return pendingPrompt(authorize, params);
  });
  await assert.rejects(imageOAuth.login(ui.value), /cancelled/);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("Pi serializes refresh and persists the rotated image credential once", async t => {
  const h = mockTokenFetch(t);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(IMAGE_AUTH_PROVIDER, async () => ({ type: "oauth", access: jwt(), refresh: "old-test-refresh", expires: 0 }));
  const models = createModels({ credentials });
  models.setProvider(imageAuthProvider);
  const results = await Promise.all([models.getAuth(IMAGE_AUTH_PROVIDER), models.getAuth(IMAGE_AUTH_PROVIDER)]);
  assert.ok(results.every(result => result.auth.apiKey === jwt()));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.get("grant_type"), "refresh_token");
  assert.equal(h.requests[0].body.get("refresh_token"), "old-test-refresh");
  assert.equal((await credentials.read(IMAGE_AUTH_PROVIDER)).refresh, REFRESH);
});

test("OAuth failures are sanitized and failed refresh preserves existing credentials", async t => {
  for (const response of [
    () => new Response(`PRIVATE_BODY_${REFRESH}`, { status: 400 }),
    () => Response.json({ access_token: jwt(), refresh_token: REFRESH }),
    () => Response.json({ access_token: "not-an-image-token", refresh_token: REFRESH, expires_in: 3600 }),
    () => Response.json({ access_token: jwt(), refresh_token: REFRESH, expires_in: -1 }),
    () => { throw new Error(`PRIVATE_FETCH_${REFRESH}`); },
  ]) await t.test("rejected token response", async t => {
    mockTokenFetch(t, response);
    const credentials = new InMemoryCredentialStore();
    const existing = { type: "oauth", access: jwt(), refresh: REFRESH, expires: 0 };
    await credentials.modify(IMAGE_AUTH_PROVIDER, async () => existing);
    const models = createModels({ credentials });
    models.setProvider(imageAuthProvider);
    await assert.rejects(models.getAuth(IMAGE_AUTH_PROVIDER), error =>
      /login codex-images/.test(error.message) && !error.message.includes(REFRESH) && !error.message.includes("PRIVATE"));
    assert.deepEqual(await credentials.read(IMAGE_AUTH_PROVIDER), existing);
  });
});

test("token response bounds and cancellation do not expose credentials or hang", async t => {
  let cancelled = false;
  mockTokenFetch(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(65537)); },
    cancel() { cancelled = true; },
  })));
  const credential = { type: "oauth", access: jwt(), refresh: REFRESH, expires: 0 };
  await assert.rejects(imageOAuth.refresh(credential, new AbortController().signal), /exchange failed/);
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Promise(() => {});
  const controller = new AbortController();
  const request = imageOAuth.refresh(credential, controller.signal);
  controller.abort();
  await assert.rejects(request, /cancelled/);
});

test("token request deadline aborts a stalled exchange even without caller cancellation", async t => {
  const timeout = AbortSignal.timeout;
  const deadline = new AbortController();
  const signal = new AbortController().signal;
  t.after(() => { AbortSignal.timeout = timeout; });
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 30000);
    return deadline.signal;
  };
  const h = mockTokenFetch(t, () => new Promise(() => {}));
  const request = imageOAuth.refresh({ type: "oauth", access: jwt(), refresh: REFRESH, expires: 0 }, signal);
  deadline.abort();
  await assert.rejects(request, /exchange failed/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(signal.aborted, false);
});

test("login deadline closes the callback and never exchanges a code", async t => {
  const timeout = AbortSignal.timeout;
  const deadline = new AbortController();
  t.after(() => { AbortSignal.timeout = timeout; });
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 600000);
    return deadline.signal;
  };
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    deadline.abort();
    return pendingPrompt(authorize, params);
  });
  await assert.rejects(imageOAuth.login(ui.value), /timed out/);
  assert.equal(h.requests.length, 0);
  assert.equal(ui.controller.signal.aborted, false);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("account routing claim cannot inject headers and does not authenticate a JWT locally", () => {
  assert.equal(extractImageAccountId(jwt()), "test-account");
  for (const value of [jwt("bad\r\nInjected: value"), jwt("test-account\n"), jwt("test-account\r"),
    jwt("test-account\u2028"), `${jwt()}\n`, jwt(""), jwt(null), "not-a-jwt",
    `header.${Buffer.from("null").toString("base64url")}.signature`]) {
    assert.throws(() => extractImageAccountId(value), error =>
      /valid ChatGPT account ID/.test(error.message) && !error.message.includes(value));
  }
});
