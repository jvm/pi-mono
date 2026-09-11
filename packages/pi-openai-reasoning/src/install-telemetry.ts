import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportInstallTelemetry as report } from "@mocito/install-telemetry";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CI_NAMES = [
  "APPVEYOR", "BITBUCKET_BUILD_NUMBER", "BUILDKITE", "CIRCLECI", "CODESPACES",
  "DRONE", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "NETLIFY",
  "TEAMCITY_VERSION", "TF_BUILD", "TRAVIS", "VERCEL",
];
function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function enabledFlag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes"].includes(value.toLowerCase());
}
export function isInstallTelemetryEnabled(env = process.env, settingsPath = join(getAgentDir(), "settings.json")): boolean {
  if (enabledFlag(env.CI) || enabledFlag(env.PI_OFFLINE) || CI_NAMES.some((name) =>
    env[name] && !["0", "false", "no"].includes(env[name]!.toLowerCase()))) return false;
  if (readJson(settingsPath).enableInstallTelemetry === false) return false;
  return env.PI_TELEMETRY === undefined || enabledFlag(env.PI_TELEMETRY);
}
export function reportInstallTelemetry(): void {
  try {
    const manifest = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
    void report({
      endpoint: "https://mocito.dev/api/report-install",
      tool: "pi-openai-reasoning",
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      statePath: join(getAgentDir(), "extensions", "pi-openai-reasoning-install.json"),
      enabled: isInstallTelemetryEnabled(),
    }).catch(() => undefined);
  } catch {
    // Best effort. The shared reporter enforces a five-second timeout.
  }
}
