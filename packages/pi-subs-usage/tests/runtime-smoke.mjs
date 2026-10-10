import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, FooterComponent, initTheme, ModelRegistry,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import subsUsage from "../index.ts";
import { resolveUsageRequest } from "../src/auth.ts";
import { STATUS_KEY } from "../src/monitor.ts";
import { cases } from "./fixtures.mjs";

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "background usage cache did not become ready");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function runtimeSmoke() {
  const dir = await mkdtemp(join(tmpdir(), "pi-subs-usage-runtime-"));
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  let session;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_TELEMETRY = "0";
    delete process.env.PI_OFFLINE;
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("zai", async () => ({ type: "api_key", key: cases[3].token }));
    await credentials.modify("opencode-go", async () => ({ type: "api_key", key: cases[4].token }));
    await credentials.modify("github-copilot", async () => ({
      type: "oauth", access: cases[2].token, refresh: "unused-github-fixture", expires: Date.now() + 3600000,
    }));
    await credentials.modify("openai", async () => ({
      type: "oauth", access: "unused-native-fixture", refresh: "unused-fixture",
      expires: Date.now() + 3600000, clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"],
    }));
    // Mirror only synthetic fixtures for Pi's public readStoredCredential helper.
    const stored = {};
    for (const provider of ["zai", "opencode-go", "github-copilot", "openai"]) stored[provider] = await credentials.read(provider);
    await writeFile(join(dir, "auth.json"), JSON.stringify(stored), { mode: 0o600 });
    const otherGoId = "fixture-go-other-account";
    const otherGoToken = "unused-other-go-account";
    const modelsPath = join(dir, "models.json");
    // Pi hides configured model headers from the model catalog. Sharing quota
    // merely by provider would silently display the wrong account for this model.
    await writeFile(modelsPath, JSON.stringify({ providers: {
      "opencode-go": {
        baseUrl: cases[4].baseUrl, api: "openai-completions",
        models: [{ id: otherGoId, headers: { Authorization: `Bearer ${otherGoToken}` } }],
      },
    } }), { mode: 0o600 });
    const requests = [];
    const refreshUrl = "https://auth.openai.com/oauth/token";
    const codexUrl = "https://chatgpt.com/backend-api/wham/usage";
    globalThis.fetch = async (url, init) => {
      requests.push(url);
      if (url === refreshUrl) {
        // Exercise Pi's actual refresh flow, never the extension's own refresh.
        assert.equal(init.method, "POST");
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "unused-expired-codex-refresh");
        assert.ok(body.get("client_id"));
        return Response.json({
          access_token: cases[0].token, refresh_token: "unused-rotated-codex-refresh", expires_in: 3600,
        });
      }
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      if (url === codexUrl) {
        assert.equal(init.headers.Authorization, `Bearer ${cases[0].token}`);
        assert.equal(init.headers["ChatGPT-Account-Id"], "fixture-account");
        return Response.json(cases[0].payload);
      }
      if (url === "https://api.z.ai/api/monitor/usage/quota/limit") {
        assert.equal(init.headers.Authorization, `Bearer ${cases[3].token}`);
        return Response.json(cases[3].payload);
      }
      if (url === "https://opencode.ai/zen/go/v1/usage") {
        if (init.headers.Authorization === `Bearer ${otherGoToken}`) {
          return Response.json({ usage: { rolling: { percent: 75 } } });
        }
        assert.equal(init.headers.Authorization, `Bearer ${cases[4].token}`);
        return Response.json(cases[4].payload);
      }
      if (url === "https://api.github.com/copilot_internal/user") {
        assert.equal(init.headers.Authorization, "token unused-github-fixture");
        return Response.json(cases[2].payload);
      }
      assert.fail(`Unexpected network destination in smoke test: ${new URL(url).origin}`);
    };
    const runtime = await ModelRuntime.create({
      credentials, modelsPath, modelsStorePath: join(dir, "models-store.json"),
    });
    const pick = provider => {
      const model = runtime.getModels(provider)[0];
      assert.ok(model, `No ${provider} model in host catalog`);
      return model;
    };
    const registry = new ModelRegistry(runtime);
    await assert.rejects(resolveUsageRequest("zai", {
      ...pick("zai"), headers: { Authorization: null },
    }, registry), /auth required/);
    await assert.rejects(resolveUsageRequest("openai", pick("openai"), registry), /native quota unavailable/);
    await runtime.setRuntimeApiKey("openai", "unused-api-key-override");
    await assert.rejects(resolveUsageRequest("openai", pick("openai"), registry), /subscription auth required/);
    const settingsManager = SettingsManager.inMemory({});
    const originalFooterRender = FooterComponent.prototype.render;
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [subsUsage],
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd: dir, agentDir: dir, model: pick("zai"), modelRuntime: runtime, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: true,
    });
    session = result.session;
    assert.deepEqual(result.extensionsResult.errors, []);
    const errors = [];
    const statuses = new Map([["a-before", "Fast on"], ["z-after", "sleep inhibited"]]);
    await session.bindExtensions({
      mode: "tui", uiContext: {
        setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
        notify: () => {},
      },
      onError: error => errors.push(error),
    });
    // session_start is deliberately non-blocking. Wait for the last model of
    // each configured provider, proving all of its model-specific caches warmed.
    const warm = async () => {
      for (const provider of ["zai", "opencode-go", "github-copilot", "openai"]) {
        const last = registry.getAvailable().filter(m => m.provider === provider).at(-1);
        assert.ok(last, `No configured ${provider} models`);
        await session.setModel(last);
        await waitFor(() => {
          const status = statuses.get(STATUS_KEY);
          return status !== undefined && status !== "[loading]" && status !== "[usage unavailable]";
        });
      }
    };
    await warm();
    // Three provider accounts plus the Go model's separate account. Native
    // OpenAI has no quota route yet, despite many configured models per provider.
    assert.equal(requests.length, 4);
    await session.setModel(pick("zai"));
    assert.match(statuses.get(STATUS_KEY), /^\[5h.*\]$/);
    // Use Pi's actual default footer to verify separation from adjacent packages.
    const footer = new FooterComponent(session, {
      getGitBranch: () => null, getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 1,
    });
    const renderFooter = width => footer.render(width).map(stripVTControlCharacters);
    for (const theme of ["dark", "light"]) {
      initTheme(theme, false);
      for (const width of [28, 100, 240]) {
        const lines = renderFooter(width);
        assert.equal(lines.length, 3);
        assert.ok(lines.every(line => line.length <= width));
        assert.doesNotMatch(lines[1], /\[5h/); // Keep the current status-line placement.
        if (width === 240) {
          assert.equal(lines[2], `Fast on ${statuses.get(STATUS_KEY)} sleep inhibited`);
        }
      }
    }
    assert.equal(FooterComponent.prototype.render, originalFooterRender);
    await session.setModel(pick("opencode-go"));
    assert.match(statuses.get(STATUS_KEY), /^\[5h.*\]$/);
    const otherGo = registry.find("opencode-go", otherGoId);
    assert.ok(otherGo);
    assert.equal(otherGo.headers, undefined);
    await session.setModel(otherGo);
    assert.equal(statuses.get(STATUS_KEY), "[5h █████░ 75%]");
    await session.setModel(pick("github-copilot"));
    assert.match(statuses.get(STATUS_KEY), /^\[premium.*\]$/);
    assert.equal(requests.length, 4); // All switches read the initial cache.

    // A custom Pi credential store, with no Codex credential in auth.json.
    await credentials.modify("openai-codex", async () => ({
      type: "oauth", access: "unused-expired-codex-access",
      refresh: "unused-expired-codex-refresh", expires: Date.now() - 1,
    }));
    const nativeBefore = await credentials.read("openai");
    await session.setModel(pick("openai"));
    assert.equal(statuses.get(STATUS_KEY), "[subscription auth required]");
    assert.equal(requests.length, 4); // New credentials do not make selection poll.
    await session.prompt("/subs-usage refresh");
    assert.match(statuses.get(STATUS_KEY), /^\[5h.*19%.*7d.*20%.*\]$/);
    assert.equal(session.model.provider, "openai");
    assert.deepEqual(await credentials.read("openai"), nativeBefore);
    assert.equal((await registry.getApiKeyAndHeaders(session.model)).apiKey, "unused-api-key-override");
    const rotated = await credentials.read("openai-codex");
    assert.equal(rotated.access, cases[0].token);
    assert.equal(rotated.refresh, "unused-rotated-codex-refresh");
    assert.ok(rotated.expires > Date.now());
    assert.equal(requests.filter(url => url === refreshUrl).length, 1);
    assert.equal(requests.filter(url => url === codexUrl).length, 1);

    // Native API keys and native OAuth both leave inference unchanged.
    await runtime.removeRuntimeApiKey("openai");
    await session.prompt("/subs-usage refresh");
    assert.match(statuses.get(STATUS_KEY), /^\[5h/);
    assert.deepEqual(await credentials.read("openai"), stored.openai);
    assert.equal((await registry.getApiKeyAndHeaders(session.model)).apiKey, stored.openai.access);
    assert.equal(requests.filter(url => url === refreshUrl).length, 1);
    assert.equal(requests.filter(url => url === codexUrl).length, 2);

    await credentials.delete("openai-codex");
    const beforeLogoutRefresh = requests.length;
    await session.prompt("/subs-usage refresh");
    assert.equal(statuses.get(STATUS_KEY), "[native quota unavailable]");
    assert.equal(requests.length, beforeLogoutRefresh + 4); // Other accounts still refresh.
    assert.equal(requests.filter(url => url === codexUrl).length, 2);
    assert.equal(session.model.provider, "openai");
    await session.setModel(pick("github-copilot"));
    await session.prompt("/subs-usage off");
    assert.equal(statuses.get(STATUS_KEY), undefined);
    assert.equal(renderFooter(240)[2], "Fast on sleep inhibited");
    const count = requests.length;
    await session.prompt("/subs-usage refresh");
    assert.equal(requests.length, count);
    await session.prompt("/subs-usage on");
    await warm();
    assert.equal(requests.length, count + 4);
    await session.prompt("/subs-usage off");
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner.emit({ type: "session_shutdown" });
    session?.dispose();
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runtimeSmoke();
  console.log("PASS: Pi 1.1.0 background preload, cached provider/model switches, per-model auth isolation, Codex OAuth refresh/logout, footer rendering and commands (synthetic credentials, mocked HTTP).");
}
