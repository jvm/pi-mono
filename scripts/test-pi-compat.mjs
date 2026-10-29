import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const version = process.argv[2];
if (!["1.1.0", "1.4.0"].includes(version)) throw new Error("Expected Pi 1.1.0 or 1.4.0");
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
  await cp(source, dir, {
    recursive: true,
    filter: path => !["node_modules", ".git", ".pi", ".test-dist", "pi-compound-engineering"].includes(basename(path)),
  });
  const rootManifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  rootManifest.devDependencies = {
    "@earendil-works/pi-ai": version,
    "@earendil-works/pi-coding-agent": version,
    "@earendil-works/pi-tui": version,
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(rootManifest, null, 2) + "\n");
  for (const entry of await readdir(join(dir, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, "packages", entry.name, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const name of Object.keys(manifest.devDependencies ?? {})) {
      if (name.startsWith("@earendil-works/pi-")) manifest.devDependencies[name] = version;
    }
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  }
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const laneEnv = { PI_TEST_HOST_VERSION: version, PI_TEST_HOST_ROOT: resolve(dir) };
  run(process.execPath, ["--import", "tsx", "--test",
    "tests/structured-tools.test.mjs", "tests/structured-prompts.test.mjs",
    "packages/pi-processes/tests/session.test.mjs",
    "packages/pi-dcg/tests/session-contract.test.mjs",
    "packages/pi-dcg/tests/ui-contract.test.mjs",
    "packages/pi-codex-compaction/tests/automatic.test.mjs",
    "packages/pi-goal/tests/session-contract.test.mjs",
    "packages/pi-codex-tools/tests/extension.test.mjs",
  ], laneEnv);
  run("npm", ["test", "-w", "packages/pi-codex-image-gen"], laneEnv);
  if (version === "1.4.0") {
    run(process.execPath, ["--import", "tsx", "--test",
      "packages/pi-codex-compaction/tests/host-inline-tools.test.mjs",
      "packages/pi-codex-compaction/tests/host-strategies.test.mjs",
    ], { ...laneEnv, PI_COMPACTION_HOST_ENTRY: join(dir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") });
  }
  run(process.execPath, ["--import", "tsx", "packages/pi-processes/tests/host-smoke.mjs",
    join(dir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")], laneEnv);
} finally {
  await rm(dir, { recursive: true, force: true });
}
