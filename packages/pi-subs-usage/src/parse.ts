import { UsageError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types.js";

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
  const n = number(value);
  return n !== undefined && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

function requiredPercent(value: unknown): number {
  const n = nonnegative(value);
  if (n === undefined || n > 100_000) throw new UsageError("invalid quota data");
  return n;
}

/** Epoch milliseconds, limited to representable and useful calendar years. */
function timestamp(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value < 4_102_444_800_000 ? value : undefined;
}

function iso(value: unknown): number | undefined {
  return typeof value === "string" && /^\d{4}-\d\d-\d\d(?:T|$)/.test(value)
    ? timestamp(Date.parse(value)) : undefined;
}

function epoch(value: unknown, scale: number): number | undefined {
  const n = nonnegative(value);
  return n === undefined ? undefined : timestamp(n * scale);
}

function relative(value: unknown, now: number): number | undefined {
  const n = nonnegative(value);
  return n === undefined ? undefined : timestamp(now + n * 1000);
}

export function durationLabel(seconds: unknown): string {
  const n = nonnegative(seconds);
  if (!n || n > 366 * 86400) return "quota";
  if (n % 86400 === 0) return `${n / 86400}d`;
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${Math.round(n)}s`;
}

function list(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) throw new UsageError("invalid quota data");
  return value;
}

function finish(windows: UsageWindow[], notes: string[] = []): UsageSnapshot {
  if (!windows.length && !notes.length) throw new UsageError("quota unavailable");
  if (windows.length > 12) throw new UsageError("invalid quota data");
  return { windows, notes };
}

function codex(root: ObjectValue, model: string, now: number): UsageSnapshot {
  const windows: UsageWindow[] = [];
  function add(limit: unknown, prefix = "") {
    const rate = object(limit);
    for (const key of ["primary_window", "secondary_window"]) {
      if (rate[key] == null) continue;
      const raw = object(rate[key]);
      windows.push({
        label: prefix + durationLabel(raw.limit_window_seconds),
        usedPercent: requiredPercent(raw.used_percent),
        resetsAt: epoch(raw.reset_at, 1000) ?? relative(raw.reset_after_seconds, now),
      });
    }
  }
  add(root.rate_limit);
  // Include only the selected model's additional bucket, not unrelated product quotas.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const entry of list(root.additional_rate_limits)) {
    const extra = object(entry);
    const identifiers = [extra.metered_feature, extra.limit_name];
    if (identifiers.some(id => typeof id === "string" && normalize(id) === normalize(model))) {
      add(extra.rate_limit, "model ");
    }
  }
  return finish(windows);
}

function claude(root: ObjectValue, model: string): UsageSnapshot {
  const windows: UsageWindow[] = [];
  function add(key: string, label: string) {
    if (root[key] == null) return;
    const raw = object(root[key]);
    windows.push({ label, usedPercent: requiredPercent(raw.utilization), resetsAt: iso(raw.resets_at) });
  }
  add("five_hour", "5h");
  add("seven_day", "7d");
  add("seven_day_oauth_apps", "apps 7d");
  const scoped = list(root.limits).map(object).filter(raw => {
    const scope = object(object(raw.scope).model);
    return raw.kind === "weekly_scoped" && raw.group === "weekly" && raw.is_active !== false
      && (scope.id === model || (typeof scope.display_name === "string"
        && /^[a-z0-9 -]{1,40}$/i.test(scope.display_name)
        && model.toLowerCase().includes(scope.display_name.toLowerCase().replaceAll(" ", "-"))));
  });
  if (scoped.length) {
    for (const raw of scoped) {
      windows.push({ label: "model 7d", usedPercent: requiredPercent(raw.percent), resetsAt: iso(raw.resets_at) });
    }
  } else {
    for (const family of ["sonnet", "opus"]) {
      if (model.toLowerCase().includes(family)) add(`seven_day_${family}`, `${family} 7d`);
    }
  }
  const extra = object(root.extra_usage);
  if (extra.is_enabled === true && nonnegative(extra.monthly_limit) !== undefined && Number(extra.monthly_limit) > 0) {
    const used = nonnegative(extra.used_credits);
    windows.push({
      label: "extra month",
      usedPercent: requiredPercent(used === undefined ? extra.utilization : used / Number(extra.monthly_limit) * 100),
    });
  }
  return finish(windows);
}

function copilot(root: ObjectValue): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const snapshots = object(root.quota_snapshots);
  const reset = iso(root.quota_reset_date);
  const credits = root.token_based_billing === true;
  for (const [key, label] of [
    ["premium_interactions", credits ? "credits" : "premium"],
    ["chat", "chat"],
    ["completions", "completions"],
  ]) {
    const raw = object(snapshots[key!]);
    if (!Object.keys(raw).length) continue;
    if (raw.unlimited === true) {
      if (!credits) notes.push(`${label} unlimited`);
      continue;
    }
    // These zero/zero snapshots are placeholders, even if percent_remaining is 100.
    if (raw.entitlement === 0 && raw.remaining === 0) continue;
    const total = nonnegative(raw.entitlement);
    const remaining = number(raw.remaining); // Negative included allowance can mean overage.
    const percent = number(raw.percent_remaining);
    if (credits && percent === undefined && !total && nonnegative(raw.credits_used) !== undefined) continue;
    if (percent !== undefined && percent <= 100) {
      windows.push({ label: label!, usedPercent: requiredPercent(100 - percent), resetsAt: reset });
    } else if (total && remaining !== undefined && remaining <= total) {
      windows.push({ label: label!, usedPercent: requiredPercent((total - remaining) / total * 100), resetsAt: reset });
    } else {
      throw new UsageError("invalid quota data");
    }
  }
  // A single shared credit counter can be repeated in several snapshots. Do not add them.
  const used = nonnegative(object(snapshots.premium_interactions).credits_used)
    ?? nonnegative(object(snapshots.chat).credits_used);
  if (credits && used !== undefined) notes.push(`${formatNumber(used)} credits used`);
  return finish(windows, notes);
}

function zai(root: ObjectValue, now: number): UsageSnapshot {
  if (root.success !== true || root.code !== 200) throw new UsageError("quota unavailable");
  const windows: UsageWindow[] = [];
  const units: Record<number, number> = { 1: 86400, 3: 3600, 5: 60, 6: 604800 };
  for (const entry of list(object(root.data).limits)) {
    const raw = object(entry);
    // MCP (TIME_LIMIT) is separate from model usage and intentionally hidden.
    if (raw.type !== "TOKENS_LIMIT" && raw.type !== "CREDIT_LIMIT") continue;
    const unit = nonnegative(raw.unit);
    const count = nonnegative(raw.number);
    const seconds = unit !== undefined && count ? units[unit]! * count : undefined;
    const label = durationLabel(seconds);
    const total = nonnegative(raw.usage);
    const current = nonnegative(raw.currentValue);
    const remaining = nonnegative(raw.remaining);
    let percent: unknown = raw.percentage;
    if (total && (current !== undefined || remaining !== undefined)) {
      percent = Math.max(current ?? 0, remaining === undefined ? 0 : Math.max(0, total - remaining)) / total * 100;
    }
    let resetsAt = epoch(raw.nextResetTime, 1);
    // Known upstream timezone bug: omit implausible reset, never invent a correction.
    if (seconds === 18000 && resetsAt && resetsAt > now + 18_060_000) resetsAt = undefined;
    windows.push({ label, usedPercent: requiredPercent(percent), resetsAt });
  }
  return finish(windows);
}

function go(root: ObjectValue, now: number): UsageSnapshot {
  const usage = object(root.usage);
  if (usage.rolling == null) throw new UsageError("invalid quota data");
  const windows: UsageWindow[] = [];
  for (const [key, label] of [["rolling", "5h"], ["weekly", "7d"], ["monthly", "month"]]) {
    if (usage[key!] == null) continue;
    const raw = object(usage[key!]);
    const absolute = raw.resetAt ?? raw.resetsAt ?? raw.reset_at;
    windows.push({
      label: label!,
      // API percentages are already 0–100. 0.5 means 0.5%, not 50%.
      usedPercent: requiredPercent(raw.percent ?? raw.usagePercent ?? raw.usedPercent),
      resetsAt: iso(absolute)
        ?? epoch(absolute, typeof absolute === "number" && absolute > 1e12 ? 1 : 1000)
        ?? relative(raw.resetInSec ?? raw.resetInSeconds, now),
    });
  }
  return finish(windows);
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function parseUsage(provider: UsageProvider, payload: unknown, model: string, now: number): UsageSnapshot {
  const root = object(payload);
  switch (provider) {
    case "openai-codex": return codex(root, model, now);
    case "anthropic": return claude(root, model);
    case "github-copilot": return copilot(root);
    case "zai":
    case "zai-coding-cn": return zai(root, now);
    case "opencode-go": return go(root, now);
    case "openai": throw new UsageError("native quota unavailable");
  }
}
