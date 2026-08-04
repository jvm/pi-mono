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

const policyEnvironmentVariables = [
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

test("settings telemetry opt-out prevents requests through every package reporting path", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-mono-telemetry-"));
  const previousEnv = Object.fromEntries(policyEnvironmentVariables.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let calls = 0;

  try {
    for (const name of policyEnvironmentVariables) delete process.env[name];
    process.env.PI_TELEMETRY = "1";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 204 };
    };

    for (const packageName of packageNames) {
      const { reportInstallTelemetry } = await import(`../packages/${packageName}/src/install-telemetry.ts`);
      reportInstallTelemetry();
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
});
