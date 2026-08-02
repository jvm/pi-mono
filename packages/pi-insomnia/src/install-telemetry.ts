import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportInstallTelemetry as report } from "@mocito/install-telemetry";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-insomnia";
const INSTALL_TELEMETRY_ENDPOINT = "https://mocito.dev/api/report-install";
const CI_ENVIRONMENT_VARIABLES = [
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "BUILDKITE",
  "CIRCLECI",
  "CODESPACES",
  "DRONE",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "JENKINS_URL",
  "NETLIFY",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "TRAVIS",
  "VERCEL",
];

interface PiSettingsDocument {
  enableInstallTelemetry?: unknown;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isPresentEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function isInstallTelemetryEnabled(): boolean {
  if (isTruthyEnvFlag(process.env.CI)) return false;
  if (CI_ENVIRONMENT_VARIABLES.some((name) => isPresentEnvFlag(process.env[name]))) return false;
  if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return false;
  if (process.env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(process.env.PI_TELEMETRY);

  const settings = readJsonFile(join(getAgentDir(), "settings.json")) as PiSettingsDocument;
  return settings.enableInstallTelemetry !== false;
}

function getPackageVersion(): string {
  const packageJson = readJsonFile(fileURLToPath(new URL("../package.json", import.meta.url))) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
}

export function reportInstallTelemetry(): void {
  try {
    void report({
      endpoint: INSTALL_TELEMETRY_ENDPOINT,
      tool: PACKAGE_NAME,
      version: getPackageVersion(),
      statePath: join(getAgentDir(), "extensions", "pi-insomnia-install.json"),
      enabled: isInstallTelemetryEnabled(),
    });
  } catch {
    // Best-effort telemetry: ignore local policy and filesystem failures.
  }
}
