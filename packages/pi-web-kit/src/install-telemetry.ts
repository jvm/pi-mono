import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-web-kit";
const INSTALL_TELEMETRY_URL = "https://mocito.dev/api/report-install";
const INSTALL_TELEMETRY_TIMEOUT_MS = 5000;

type InstallTelemetryState = { lastReportedVersion?: string };

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isInstallTelemetryEnabled(): boolean {
  if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return false;
  if (isTruthyEnvFlag(process.env.CI) || isTruthyEnvFlag(process.env.GITHUB_ACTIONS)) return false;
  if (process.env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(process.env.PI_TELEMETRY);
  const settings = readJsonFile(join(getAgentDir(), "settings.json")) as { enableInstallTelemetry?: unknown };
  return settings.enableInstallTelemetry !== false;
}

function getPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getInstallTelemetryUserAgent(version: string): string {
  const runtimeVersions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  const runtime = runtimeVersions.bun ? `bun/${runtimeVersions.bun}` : `node/${process.version}`;
  return `${PACKAGE_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

export async function reportInstallTelemetry(): Promise<void> {
  try {
    if (!isInstallTelemetryEnabled()) return;

    const version = getPackageVersion();
    const telemetryDir = join(getAgentDir(), "extensions");
    const statePath = join(telemetryDir, "pi-web-kit-install.json");
    const state = readJsonFile(statePath) as InstallTelemetryState;
    if (state.lastReportedVersion === version) return;

    await mkdir(telemetryDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ lastReportedVersion: version }, null, 2)}\n`);

    const params = new URLSearchParams({ tool: PACKAGE_NAME, version });
    await fetch(`${INSTALL_TELEMETRY_URL}?${params.toString()}`, {
      headers: { "User-Agent": getInstallTelemetryUserAgent(version) },
      signal: AbortSignal.timeout(INSTALL_TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // Best-effort install telemetry: ignore settings, filesystem, and network failures.
  }
}
