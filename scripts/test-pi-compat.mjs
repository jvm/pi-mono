import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareHostWorkspace } from "./workspace-packages.mjs";

const version = "1.5.2";
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== version)) {
  throw new Error(`Expected Pi ${version}; older hosts and floating versions are not test targets.`);
}
const source = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pi-compat-"));
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    cwd: dir, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
};
try {
  await prepareHostWorkspace(source, dir, version);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const laneEnv = { PI_TEST_HOST_VERSION: version, PI_TEST_HOST_ROOT: resolve(dir) };
  run(process.execPath, ["--import", "tsx", "--test",
    "tests/pi-baseline.test.mjs",
    "tests/structured-tools.test.mjs", "tests/structured-prompts.test.mjs", "tests/virtual-models.test.mjs",
    "packages/pi-processes/tests/session.test.mjs",
    "packages/pi-dcg/tests/session-contract.test.mjs",
    "packages/pi-dcg/tests/ui-contract.test.mjs",
    "packages/pi-codex-compaction/tests/automatic.test.mjs",
    "packages/pi-goal/tests/session-contract.test.mjs",
    "packages/pi-codex-tools/tests/extension.test.mjs",
    "packages/pi-codex-tools/tests/astra-integration.test.mjs",
    "packages/pi-openai-reasoning/tests/extension.test.mjs",
  ], laneEnv);
  run("npm", ["test", "-w", "packages/pi-codex-image-gen"], laneEnv);
  run(process.execPath, ["--import", "tsx", "--test",
    "packages/pi-codex-compaction/tests/host-inline-tools.test.mjs",
    "packages/pi-codex-compaction/tests/host-strategies.test.mjs",
  ], { ...laneEnv, PI_COMPACTION_HOST_ENTRY: join(dir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") });
  run(process.execPath, ["--import", "tsx", "packages/pi-processes/tests/host-smoke.mjs",
    join(dir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")], laneEnv);
} finally {
  await rm(dir, { recursive: true, force: true });
}
