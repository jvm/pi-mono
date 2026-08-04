import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageNames = [
  "pi-agentsmd",
  "pi-codex-compaction",
  "pi-codex-image-gen",
  "pi-codex-tools",
  "pi-compound-engineering",
  "pi-dcg",
  "pi-fast",
  "pi-goal",
  "pi-insomnia",
  "pi-scout",
  "pi-skillful",
  "pi-web-kit",
];

test("settings telemetry opt-out overrides PI_TELEMETRY for every package", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mono-telemetry-"));
  const env = { PI_TELEMETRY: "1" };
  try {
    for (const packageName of packageNames) {
      const { isInstallTelemetryEnabled } = await import(`../packages/${packageName}/src/install-telemetry.ts`);
      const settingsPath = join(cwd, `${packageName}.json`);
      await writeFile(settingsPath, JSON.stringify({ enableInstallTelemetry: false }));
      assert.equal(isInstallTelemetryEnabled(env, settingsPath), false, packageName);

      await writeFile(settingsPath, "{}");
      assert.equal(isInstallTelemetryEnabled(env, settingsPath), true, packageName);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
