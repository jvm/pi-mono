export const NOW = Date.UTC(2026, 9, 9, 12);
export const RESET = NOW + 161 * 60_000;
export const WEEK_RESET = Date.UTC(2026, 9, 13, 7);
export const legacyToken = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64url")}.fixture`;

export const cases = [
  {
    provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api/codex",
    token: legacyToken, expected: "5h █░░░░░ 19%",
    payload: { rate_limit: {
      primary_window: { used_percent: 19, limit_window_seconds: 18000, reset_at: RESET / 1000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: WEEK_RESET / 1000 },
    } },
  },
  {
    provider: "anthropic", id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com",
    token: "sk-ant-oat-unused-fixture", expected: "5h █░░░░░ 19%",
    payload: {
      five_hour: { utilization: 19, resets_at: new Date(RESET).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(WEEK_RESET).toISOString() },
    },
  },
  {
    provider: "github-copilot", id: "claude-sonnet-4.6", baseUrl: "https://api.individual.githubcopilot.com",
    token: "unused-inference-fixture", expected: "premium █░░░░░ 20%",
    payload: { quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80 } }, quota_reset_date: "2026-11-01" },
  },
  {
    provider: "zai", id: "glm-5", baseUrl: "https://api.z.ai/api/coding/paas/v4",
    token: "unused-glm-fixture", expected: "5h █░░░░░ 20%",
    payload: { success: true, code: 200, data: { limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: RESET },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 30 },
    ] } },
  },
  {
    provider: "opencode-go", id: "glm-5", baseUrl: "https://opencode.ai/zen/go/v1",
    token: "unused-go-fixture", expected: "5h ░░░░░░ 3%",
    payload: { usage: {
      rolling: { percent: 3, resetInSec: 600 }, weekly: { percent: 1, resetInSec: 3600 },
      monthly: { percent: 0.5, resetInSec: 86400 },
    } },
  },
];

export function model(fixture) {
  return {
    provider: fixture.provider, id: fixture.id, name: fixture.id, api: "openai-completions",
    baseUrl: fixture.baseUrl, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// Mirror only the private metadata contract; real-host coverage lives in the
// background-auth integration tests and runtime smoke test.
export function backgroundAuthMetadata() {
  return {
    runtime: {
      config: { getProvider: () => undefined },
      credentials: { overrides: new Map(), store: { read: async () => undefined } },
    },
    getRegisteredProviderConfig: () => undefined,
  };
}
