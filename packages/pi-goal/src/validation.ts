import { MAX_OBJECTIVE_CHARS } from "./types.js";

export function validateObjective(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "Objective must be a string." };
  const value = input.trim();
  if (!value) return { ok: false, error: "Objective must not be empty." };
  if (value.length > MAX_OBJECTIVE_CHARS) return { ok: false, error: `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.` };
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
