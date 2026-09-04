import type { Model } from "@earendil-works/pi-ai";

export type AuthKind = "oauth" | "api-key" | "unknown";

export interface ProModeEntitlement {
  allowed: boolean;
  authKind: AuthKind;
  /** Shown to the user when `allowed` is true but the claim is unverified. */
  warning?: string;
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
