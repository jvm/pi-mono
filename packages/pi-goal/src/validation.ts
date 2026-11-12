import { MAX_OBJECTIVE_CHARS } from "./types.js";

export function validateObjective(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Objective must be a string." };
  const value = input.trim();
  if (!value) return { ok: false, error: "Objective must not be empty." };
  if (value.length > MAX_OBJECTIVE_CHARS) return { ok: false, error: `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.` };
  return { ok: true, value };
}

export const TOKEN_BUDGET_FORMAT_ERROR = "Token budget must be a positive whole number of tokens, such as 50000, 50k, or 1.5m.";

/** Parse a command-line token budget: digits with optional `_`/`,` separators and a `k` or `m` suffix. */
export function parseTokenBudget(input: string): { ok: true; value: number } | { ok: false; error: string } {
  const match = input.trim().match(/^(\d[\d_,]*(?:\.\d+)?)([km])?$/i);
  if (!match) return { ok: false, error: TOKEN_BUDGET_FORMAT_ERROR };
  const multiplier = match[2] ? (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  // Scale in integer space where possible; 1.5k must be exactly 1500.
  const [whole, fraction = ""] = match[1].replace(/[_,]/g, "").split(".");
  const scale = 10 ** fraction.length;
  const numerator = Number(whole + fraction) * multiplier;
  const value = numerator / scale;
  if (!Number.isSafeInteger(value) || value <= 0 || numerator % scale !== 0) return { ok: false, error: TOKEN_BUDGET_FORMAT_ERROR };
  return { ok: true, value };
}

export function validateTokenBudget(input: unknown, options: { allowEmpty?: boolean } = {}): { ok: true; value?: number } | { ok: false; error: string } {
  if (input == null || input === "") {
    if (options.allowEmpty) return { ok: true, value: undefined };
    return { ok: false, error: "Token budget is required." };
  }
  const value = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: "Token budget must be a positive integer." };
  }
  return { ok: true, value };
}
