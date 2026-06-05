import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-agentsmd";
const INSTALL_TELEMETRY_URL = "https://mocito.dev/api/report-install";
const INSTALL_TELEMETRY_TIMEOUT_MS = 5000;
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

interface InstallTelemetryState {
  lastReportedVersion?: string;
}

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

function isCiEnvironment(): boolean {
  if (isTruthyEnvFlag(process.env.CI)) return true;
  return CI_ENVIRONMENT_VARIABLES.some((name) => isPresentEnvFlag(process.env[name]));
}

function isInstallTelemetryEnabled(): boolean {
  if (isCiEnvironment()) return false;
  if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return false;
  if (process.env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(process.env.PI_TELEMETRY);

  const settings = readJsonFile(join(getAgentDir(), "settings.json")) as PiSettingsDocument;
  return settings.enableInstallTelemetry !== false;
}

function getPackageVersion(): string {
  const packageJson = readJsonFile(fileURLToPath(new URL("../package.json", import.meta.url))) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
}

function getInstallTelemetryUserAgent(version: string): string {
  const runtimeVersions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  const runtime = runtimeVersions.bun ? `bun/${runtimeVersions.bun}` : `node/${process.version}`;
  return `${PACKAGE_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

async function reportInstallTelemetryAsync(): Promise<void> {
  try {
    if (!isInstallTelemetryEnabled()) return;

    const version = getPackageVersion();
    const extensionsDir = join(getAgentDir(), "extensions");
    const statePath = join(extensionsDir, "pi-agentsmd-install.json");
    const state = readJsonFile(statePath) as InstallTelemetryState;
    if (state.lastReportedVersion === version) return;

    await mkdir(extensionsDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ lastReportedVersion: version }, null, 2)}\n`, "utf8");

    const params = new URLSearchParams({ tool: PACKAGE_NAME, version });
    await fetch(`${INSTALL_TELEMETRY_URL}?${params.toString()}`, {
      headers: { "User-Agent": getInstallTelemetryUserAgent(version) },
      signal: AbortSignal.timeout(INSTALL_TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // Best-effort telemetry: ignore settings, filesystem, and network failures.
  }
}

export function reportInstallTelemetry(): void {
  void reportInstallTelemetryAsync();
}
