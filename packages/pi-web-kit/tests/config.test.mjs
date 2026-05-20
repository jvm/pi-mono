import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, requireKey, validateFetchProvider, validateSearchProvider } from "../src/config.ts";

test("defaults use exa_mcp", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  const cfg = resolveConfig({}, cwd, {});
  assert.equal(cfg.provider_search, "exa_mcp");
  assert.equal(cfg.provider_fetch, "exa_mcp");
});

test("config precedence defaults < env < file < flags", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ provider_search: "brave", apiKeys: { brave: "file" } }));
  const cfg = resolveConfig({ providerSearch: "firecrawl" }, cwd, {
    PI_WEB_KIT_PROVIDER_SEARCH: "tinyfish",
    TINYFISH_API_KEY: "env",
    BRAVE_SEARCH_API_KEY: "env-brave",
  });
  assert.equal(cfg.provider_search, "firecrawl");
  assert.equal(cfg.apiKeys.tinyfish, "env");
  assert.equal(cfg.apiKeys.brave, "file");
});

test("project config overrides global config", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-kit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-kit-"));
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  writeFileSync(join(home, ".pi/agent/pi-web-kit.json"), JSON.stringify({ provider_fetch: "firecrawl", apiKeys: { firecrawl: "global" } }));
  writeFileSync(join(cwd, ".pi-web-kit.json"), JSON.stringify({ provider_fetch: "markdown_new" }));
  const cfg = resolveConfig({}, cwd, { HOME: home });
  assert.equal(cfg.provider_fetch, "markdown_new");
  assert.equal(cfg.apiKeys.firecrawl, "global");
});

test("unknown providers and missing keys fail clearly", () => {
  assert.throws(() => validateSearchProvider("bad"), /Unknown search provider/);
  assert.throws(() => validateFetchProvider("bad"), /Unknown fetch provider/);
  assert.throws(() => requireKey(resolveConfig({}, mkdtempSync(join(tmpdir(), "pi-web-kit-")), {}), "exa"), /EXA_API_KEY/);
});
