import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { reportInstallTelemetry } = await import("../src/install-telemetry.ts");

const CI_ENVIRONMENT_VARIABLES = [
  "CI",
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
  "PI_OFFLINE",
  "PI_TELEMETRY",
  "PI_CODING_AGENT_DIR",
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for telemetry work.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("retries telemetry after failed and non-OK reports", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-fast-telemetry-"));
  const statePath = join(agentDir, "extensions", "pi-fast-install.json");
  const previousEnv = Object.fromEntries(
    CI_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]),
  );
  const previousFetch = globalThis.fetch;
  let calls = 0;

  for (const name of CI_ENVIRONMENT_VARIABLES) delete process.env[name];
  process.env.PI_TELEMETRY = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary network failure");
    return { ok: calls !== 2, status: calls === 2 ? 503 : 204 };
  };

  try {
    reportInstallTelemetry();
    await waitFor(() => calls === 1);
    assert.equal(await exists(statePath), false);

    reportInstallTelemetry();
    await waitFor(() => calls === 2);
    assert.equal(await exists(statePath), false);

    reportInstallTelemetry();
    await waitFor(() => calls === 3 && exists(statePath));
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { lastReportedVersion: "0.1.0" });

    reportInstallTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
});
