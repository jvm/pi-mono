import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { isInstallTelemetryEnabled } = await import("../src/install-telemetry.ts");

test("settings opt-out overrides an enabled PI_TELEMETRY environment flag", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  const settingsPath = join(cwd, "settings.json");
  try {
    const env = { PI_TELEMETRY: "1" };
    await writeFile(settingsPath, JSON.stringify({ enableInstallTelemetry: false }));
    assert.equal(isInstallTelemetryEnabled(env, settingsPath), false);

    await writeFile(settingsPath, "{}");
    assert.equal(isInstallTelemetryEnabled(env, settingsPath), true);
    env.PI_TELEMETRY = "false";
    assert.equal(isInstallTelemetryEnabled(env, settingsPath), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
