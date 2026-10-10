export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  /** Provider-native counts, never converted to a quota without a denominator. */
  notes: string[];
}

export const PROVIDER_NAMES = {
  "openai-codex": "Codex",
  openai: "ChatGPT",
  anthropic: "Claude",
  "github-copilot": "Copilot",
  zai: "GLM",
  "zai-coding-cn": "GLM CN",
  "opencode-go": "Go",
} as const;

export type UsageProvider = keyof typeof PROVIDER_NAMES;

export function isUsageProvider(value: string): value is UsageProvider {
  return Object.hasOwn(PROVIDER_NAMES, value);
}

/** Only fixed local messages may cross the network/auth error boundary. */
export class UsageError extends Error {
  constructor(
    public readonly reason:
      | "auth required"
      | "subscription auth required"
      | "Pi Copilot login required"
      | "custom endpoint unsupported"
      | "enterprise quota unsupported"
      | "native quota unavailable"
      | "command auth unsupported"
      | "background auth unavailable"
      | "invalid quota data"
      | "quota unavailable"
      | "access denied"
      | "rate limited"
      | "request failed",
  ) {
    super(reason);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof UsageError ? error.reason : "request failed";
}
