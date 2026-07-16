import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DCG_TIMEOUT_MS = 5_000;
export const MIN_DCG_TIMEOUT_MS = 100;
export const MAX_DCG_TIMEOUT_MS = 60_000;
export const MAX_DCG_OUTPUT_BYTES = 512 * 1024;

export type DcgErrorMode = "allow" | "block";

export interface DcgBridgeConfig {
  binary: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onError: DcgErrorMode;
  guardUserBash: boolean;
}

function isFalseEnvValue(value: string): boolean {
  return ["0", "false", "no", "off", "n"].includes(value.trim().toLowerCase());
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DCG_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_DCG_TIMEOUT_MS || parsed > MAX_DCG_TIMEOUT_MS) {
    return DEFAULT_DCG_TIMEOUT_MS;
  }
  return parsed;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}

export function loadDcgBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): DcgBridgeConfig {
  const configuredBinary = env.PI_DCG_BIN?.trim() || env.DCG_BIN?.trim() || "dcg";
  const onError = env.PI_DCG_ON_ERROR?.trim().toLowerCase() === "block" ? "block" : "allow";
  const guardUserBash = env.PI_DCG_GUARD_USER_BASH === undefined
    ? true
    : !isFalseEnvValue(env.PI_DCG_GUARD_USER_BASH);

  return {
    binary: expandHome(configuredBinary, home),
    timeoutMs: parseTimeout(env.PI_DCG_TIMEOUT_MS),
    maxOutputBytes: MAX_DCG_OUTPUT_BYTES,
    onError,
    guardUserBash,
  };
}
