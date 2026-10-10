import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportInstallTelemetry as report } from "@mocito/install-telemetry";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-subs-usage";
const INSTALL_TELEMETRY_ENDPOINT = "https://mocito.dev/api/report-install";
const CI_ENVIRONMENT_VARIABLES = [
  "APPVEYOR", "BITBUCKET_BUILD_NUMBER", "BUILDKITE", "CIRCLECI", "CODESPACES",
  "DRONE", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "NETLIFY",
  "TEAMCITY_VERSION", "TF_BUILD", "TRAVIS", "VERCEL",
];

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? "");
}

export function isInstallTelemetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath = join(getAgentDir(), "settings.json"),
): boolean {
  if (isTruthyEnvFlag(env.CI) || isTruthyEnvFlag(env.PI_OFFLINE)) return false;
  if (CI_ENVIRONMENT_VARIABLES.some(name => env[name] && !/^(0|false|no)$/i.test(env[name]!))) return false;
  if (readJsonFile(settingsPath)?.enableInstallTelemetry === false) return false;
  return env.PI_TELEMETRY === undefined || isTruthyEnvFlag(env.PI_TELEMETRY);
}

export function reportInstallTelemetry(): void {
  try {
    const manifest = readJsonFile(fileURLToPath(new URL("../package.json", import.meta.url)));
    void report({
      endpoint: INSTALL_TELEMETRY_ENDPOINT,
      tool: PACKAGE_NAME,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      statePath: join(getAgentDir(), "extensions", "pi-subs-usage-install.json"),
      enabled: isInstallTelemetryEnabled(),
    }).catch(() => undefined);
  } catch {
    // Best effort; never block Pi on telemetry or local state errors.
  }
}
