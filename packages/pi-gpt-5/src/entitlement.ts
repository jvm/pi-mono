import type { Model } from "@earendil-works/pi-ai";

export type AuthKind = "oauth" | "api-key" | "unknown";

export interface ProModeEntitlement {
  allowed: boolean;
  authKind: AuthKind;
  /** Shown to the user when `allowed` is true but the claim is unverified. */
  warning?: string;
}

export type PtcAvailability =
  | { available: false; reason: string }
  | { available: false; reason: string; blockedOnParser: true }
  | { available: true };

/**
 * Programmatic Tool Calling availability for the active session.
 *
 * Live-probed 2026-09-04: the Codex backend rejects the hosted tool
 * (`400: Unsupported tool type: programmatic_tool_calling`), so PTC needs an
 * API-key session on api.openai.com. Even then it stays disabled until the
 * upstream pi Responses parser preserves `program`/`program_output` items and
 * the `caller` field (see features_gate.md) — flagged via `blockedOnParser`.
 */
export function resolvePtcAvailability(
  modelRegistry: unknown,
  model: (Model<any> & { baseUrl?: string }) | undefined,
): PtcAvailability {
  if (!model) return { available: false, reason: "No model selected." };
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : "";
  if (!baseUrl.includes("api.openai.com")) {
    return {
      available: false,
      reason: "PTC is only supported on the official OpenAI API (api.openai.com); the Codex backend rejects it.",
    };
  }
  const isUsingOAuth = isRecord(modelRegistry) ? modelRegistry.isUsingOAuth : undefined;
  let oauth = false;
  if (typeof isUsingOAuth === "function") {
    try {
      oauth = isUsingOAuth.call(modelRegistry, model);
    } catch {
      oauth = false;
    }
  }
  if (oauth) {
    return {
      available: false,
      reason: "PTC requires an OpenAI API key; ChatGPT/Codex subscription auth is rejected by the backend.",
    };
  }
  return {
    available: false,
    reason: "PTC needs an upstream pi parser patch (program/caller preservation) before it can run safely.",
    blockedOnParser: true,
  };
}

/**
 * Decide whether pro mode may be requested for the active session.
 *
 * API-key sessions are always entitled: `reasoning.mode` is a standard
 * Responses API feature with no subscription concept. Codex (OAuth) sessions
 * cannot currently be verified: the backend model catalog carries no pro-mode
 * marker, so the toggle is allowed with an explicit warning and the user sees
 * a provider error if their plan rejects it.
 *
 * Auth detection mirrors pi-codex-compaction: `modelRegistry.isUsingOAuth` is
 * a documented-adjacent Pi API already used in this monorepo.
 */
export function resolveProModeEntitlement(
  modelRegistry: unknown,
  model: Model<any> | undefined,
): ProModeEntitlement {
  if (!model) return { allowed: false, authKind: "unknown" };
  const isUsingOAuth = isRecord(modelRegistry) ? modelRegistry.isUsingOAuth : undefined;
  if (typeof isUsingOAuth !== "function") {
    return { allowed: true, authKind: "unknown", warning: "Auth kind unknown; pro mode may be rejected by the provider." };
  }
  try {
    if (isUsingOAuth.call(modelRegistry, model)) {
      return {
        allowed: true,
        authKind: "oauth",
        warning: "Codex-plan entitlement for pro mode cannot be verified; the request may be rejected.",
      };
    }
    return { allowed: true, authKind: "api-key" };
  } catch {
    return { allowed: true, authKind: "unknown", warning: "Auth kind unknown; pro mode may be rejected by the provider." };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
