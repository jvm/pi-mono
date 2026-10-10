import assert from "node:assert/strict";
import test from "node:test";
import { formatReset, formatUsage } from "../src/format.ts";
import { parseUsage, durationLabel } from "../src/parse.ts";
import { cases, NOW, RESET, WEEK_RESET } from "./fixtures.mjs";

process.env.TZ = "UTC";
for (const fixture of cases) {
  test(`${fixture.provider}: render native quota units without a subscription-name prefix`, () => {
    const result = parseUsage(fixture.provider, fixture.payload, fixture.id, NOW);
    assert.ok(formatUsage(result, NOW).startsWith(fixture.expected));
  });
}

test("Claude example uses consumed percentages and local reset times", () => {
  const fixture = cases[1];
  assert.equal(formatUsage(parseUsage("anthropic", fixture.payload, fixture.id, NOW), NOW),
    "5h █░░░░░ 19% ↻2h41m | 7d █░░░░░ 20% ↻Tue 07:00");
  assert.equal(formatReset(NOW, NOW), "↻due"); // A reset passing never invents 0% usage.
  assert.equal(formatReset(NOW + 35 * 60_000, NOW), "↻35m");
  assert.equal(formatReset(NOW + 30 * 86400000, NOW), "↻11/8 12:00");
});

test("Codex duration labels come from the response, with selected-model extras only", () => {
  const payload = structuredClone(cases[0].payload);
  payload.rate_limit.primary_window.limit_window_seconds = 86400;
  payload.additional_rate_limits = [
    { metered_feature: "gpt_5_3_codex_spark", rate_limit: {
      primary_window: { used_percent: 89, limit_window_seconds: 18000, reset_after_seconds: 300 },
    } },
  ];
  const ordinary = parseUsage("openai-codex", payload, "gpt-6.1-sol", NOW);
  assert.deepEqual(ordinary.windows.map(w => w.label), ["1d", "7d"]);
  const spark = parseUsage("openai-codex", payload, "gpt-5.3-codex-spark", NOW);
  // The server's metered_feature uses underscores even for the version separator.
  assert.equal(spark.windows.length, 3);
  payload.additional_rate_limits[0].limit_name = "GPT-5.3-Codex-Spark";
  assert.equal(parseUsage("openai-codex", payload, "gpt-5.3-codex-spark", NOW).windows[2].resetsAt, NOW + 300000);
  assert.equal(durationLabel(3600), "1h");
  assert.equal(durationLabel(90), "90s");
  assert.equal(durationLabel(null), "quota");
});

test("Claude follows model-specific windows without mixing unrelated model quotas", () => {
  const payload = { ...cases[1].payload,
    seven_day_sonnet: { utilization: 35 },
    seven_day_opus: { utilization: 70 },
    seven_day_oauth_apps: { utilization: 10 },
    extra_usage: { is_enabled: true, used_credits: 30, monthly_limit: 100 },
  };
  assert.deepEqual(parseUsage("anthropic", payload, "claude-sonnet-4-6", NOW).windows.map(w => w.label),
    ["5h", "7d", "apps 7d", "sonnet 7d", "extra month"]);
  assert.equal(parseUsage("anthropic", payload, "claude-opus-4-6", NOW).windows[3].usedPercent, 70);
  payload.limits = [{ kind: "weekly_scoped", group: "weekly", percent: 12,
    scope: { model: { id: "claude-sonnet-4-6", display_name: "Sonnet" } } }];
  assert.equal(parseUsage("anthropic", payload, "claude-sonnet-4-6", NOW).windows[3].label, "model 7d");
});

test("Copilot distinguishes unlimited, placeholders, credits-only, and overage", () => {
  const parse = payload => parseUsage("github-copilot", payload, "", NOW);
  const result = parse({ quota_snapshots: { chat: { unlimited: true } } });
  assert.deepEqual(result, { windows: [], notes: ["chat unlimited"] });
  assert.throws(() => parse({ quota_snapshots: { premium_interactions: {
    entitlement: 0, remaining: 0, percent_remaining: 100,
  } } }), /quota unavailable/);
  assert.deepEqual(parse({ token_based_billing: true, quota_snapshots: {
    premium_interactions: { credits_used: 42 }, chat: { credits_used: 42 },
  } }), { windows: [], notes: ["42 credits used"] });
  const overage = parse({ quota_snapshots: { premium_interactions: { entitlement: 100, remaining: -20 } } });
  assert.equal(overage.windows[0].usedPercent, 120);
  assert.match(formatUsage(overage, NOW), /██████ 120%/);
  assert.throws(() => parse({ quota_snapshots: { chat: { remaining: 5 } } }), /invalid quota data/);
});

test("GLM derives model quota counts and ignores MCP limits and implausible resets", () => {
  const payload = { success: true, code: 200, data: { limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0, usage: 100, remaining: 60, currentValue: 35, nextResetTime: NOW + 36000000 },
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 5, nextResetTime: WEEK_RESET },
    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 7 },
    { type: "TIME_LIMIT", percentage: null },
  ] } };
  const result = parseUsage("zai-coding-cn", payload, "glm", NOW);
  assert.deepEqual(result.windows.map(w => w.label), ["5h", "7d"]);
  assert.equal(result.windows[0].usedPercent, 40);
  assert.equal(result.windows[0].resetsAt, undefined);
  assert.equal(result.windows[1].resetsAt, WEEK_RESET);
  assert.throws(() => parseUsage("zai", { success: false, code: 401 }, "", NOW), /quota unavailable/);
  payload.data.limits = [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 7 }];
  assert.throws(() => parseUsage("zai", payload, "", NOW), /quota unavailable/);
  payload.data.limits = [{ type: "UNKNOWN" }];
  assert.throws(() => parseUsage("zai", payload, "", NOW), /quota unavailable/);
});

test("OpenCode API percentages are not fractions; missing weekly/monthly stays missing", () => {
  for (const percent of [0, 0.5, 1, 100]) {
    const result = parseUsage("opencode-go", { usage: { rolling: { percent, resetAt: new Date(RESET).toISOString() } } }, "", NOW);
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].usedPercent, percent);
    assert.equal(result.windows[0].resetsAt, RESET);
  }
  assert.throws(() => parseUsage("opencode-go", { usage: { monthly: { percent: 1 } } }, "", NOW), /invalid quota data/);
});

test("missing, null, malformed, or non-finite quotas are never synthetic zero usage", () => {
  for (const fixture of cases) assert.throws(() => parseUsage(fixture.provider, {}, fixture.id, NOW));
  for (const utilization of [null, "20", -1, Infinity, NaN, {}]) {
    assert.throws(() => parseUsage("anthropic", { five_hour: { utilization } }, "", NOW), /invalid quota data/);
  }
  assert.throws(() => parseUsage("anthropic", { five_hour: null, seven_day: null }, "", NOW), /quota unavailable/);
  const credits = count => ({ token_based_billing: true, quota_snapshots: { premium_interactions: { credits_used: count } } });
  const zero = parseUsage("github-copilot", credits(0), "", NOW);
  assert.equal(formatUsage(zero, NOW), "0 credits used");
  assert.throws(() => parseUsage("github-copilot", credits(-1), "", NOW), /invalid quota data/);
});

test("untrusted labels and error text never reach terminal output", () => {
  const payload = structuredClone(cases[0].payload);
  payload.plan_type = "\x1b]52;c;attack\x07";
  payload.additional_rate_limits = [{ limit_name: "\x1b[31m", metered_feature: "other", rate_limit: {} }];
  const rendered = formatUsage(parseUsage("openai-codex", payload, "gpt-6.1-sol", NOW), NOW);
  assert.doesNotMatch(rendered, /attack|\x1b/);
  assert.throws(() => parseUsage("anthropic", { limits: Array(129).fill({}) }, "", NOW), /invalid quota data/);
});
