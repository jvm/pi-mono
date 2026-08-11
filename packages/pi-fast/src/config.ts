import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "pi-fast";

export async function isFastModeEnabledByDefault(
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) return false;

    const settings = parsed[SETTINGS_KEY];
    return isRecord(settings) && settings.enabledByDefault === true;
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
