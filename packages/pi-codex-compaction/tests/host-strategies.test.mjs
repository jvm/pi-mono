import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
  test("installed-host automatic tool adaptation integrates with real Pi lifecycle and mocked transport", {
    skip: !process.env.PI_COMPACTION_HOST_ENTRY && "Set PI_COMPACTION_HOST_ENTRY to an installed Pi 1.4 SDK entry",
  }, async () => {
    const driver = fileURLToPath(new URL("./live-experiments/pi.mjs", import.meta.url));
    const { stdout } = await exec(process.execPath, ["--import", "tsx", driver, "--offline", "--extended"], {
      timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PI_LIVE_COMPACTION: "0", PI_OFFLINE: "1" },
    });
    const summary = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(summary.done, true);
    assert.equal(summary.recommendedCandidate, "automatic");
    assert.ok(summary.results.every(r => r.passed));
    assert.ok(summary.results.some(r => r.phase.endsWith("two-step-continuation")));
    assert.ok(summary.results.some(r => r.phase.endsWith("long-session:recall") && r.recall));
    const first = summary.metrics[0];
    assert.equal(first.automatic, true);
    assert.deepEqual(first.toolNames, ["fixture", "raw_fixture"]);
    assert.equal(first.inlineBatches, 0, "Initial loadout is promoted once, not duplicated");
    const hidden = summary.metrics.find(m => m.phase.endsWith("hidden-loadout"));
    assert.deepEqual(hidden.toolNames, ["controller"]);
    const off = summary.metrics.find(m => m.phase.endsWith("off-and-reload"));
    assert.equal(off.automatic, false);
    const disabled = summary.metrics.find(m => m.phase.endsWith("fresh-disabled"));
    assert.equal(disabled.automatic, false);
    assert.equal(disabled.toolNames, undefined);
  });
