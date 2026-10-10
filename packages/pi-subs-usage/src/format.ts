import { formatNumber } from "./parse.js";
import type { UsageSnapshot } from "./types.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatReset(resetsAt: number, now: number): string {
  const remaining = resetsAt - now;
  if (remaining <= 0) return "↻due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `↻${minutes}m`;
  if (minutes < 24 * 60) return `↻${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
  const date = new Date(resetsAt);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  // A weekday alone is ambiguous for monthly resets.
  const day = minutes < 7 * 1440 ? DAYS[date.getDay()] : `${date.getMonth() + 1}/${date.getDate()}`;
  return `↻${day} ${time}`;
}

export function formatUsage(snapshot: UsageSnapshot, now: number): string {
  const segments = snapshot.windows.map(window => {
    const filled = Math.round(Math.min(100, window.usedPercent) / 100 * 6);
    const bar = "█".repeat(filled) + "░".repeat(6 - filled);
    return `${window.label} ${bar} ${formatNumber(window.usedPercent)}%${window.resetsAt === undefined ? "" : ` ${formatReset(window.resetsAt, now)}`}`;
  });
  return [...segments, ...snapshot.notes].join(" | ");
}
