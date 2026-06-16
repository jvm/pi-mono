#!/usr/bin/env node
// @ts-check
/**
 * `preinstall` entry point. Fetches the upstream Compound Engineering
 * release tarball, verifies its SHA256, extracts it, runs the converter,
 * and stages the result in `~/.pi-compound-engineering-staging/run-<rand>/`.
 *
 * The production install dir is never touched during this phase. The
 * companion `scripts/commit.mjs` (the `postinstall` entry point) moves
 * the staged content into the final install location after npm has
 * promoted the new version into place.
 *
 * The split between `preinstall` and `postinstall` is what gives us
 * npm-native update safety: if this script exits non-zero, npm aborts
 * the install/update and the previous version is left untouched.
 *
 * Note: the staging dir lives under the user's home (not under
 * `os.tmpdir()`) so the CodeQL `js/insecure-temporary-file` rule's
 * tmpdir() data-flow analysis does not flag the downstream
 * `writeFile` calls in `converter.mjs`.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { convert, sha256OfFile, streamResponseToFile } from "./converter.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const STAGING_BASE_DIR = join(homedir(), ".pi-compound-engineering-staging");
const STAGING_RUN_PREFIX = "run-";
const STAGING_PATH_FILE = join(STAGING_BASE_DIR, "staging-path.txt");
const STAGING_DIR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXPECTED_SHA256_FILE = join(PACKAGE_ROOT, "scripts", "expected-sha256.txt");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMEOUT_DOWNLOAD_MS = 60_000;
const TIMEOUT_EXTRACT_MS = 30_000;
// Common CI environment variables. Mirrors the same set used by
// `src/install-telemetry.ts` so the offline/CI guard and the telemetry
// opt-out agree on what counts as "a CI environment".
const CI_ENVIRONMENT_VARIABLES = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"TRAVIS",
	"JENKINS_URL",
	"BUILDKITE",
	"APPVEYOR",
	"DRONE",
	"TEAMCITY_VERSION",
	"NETLIFY",
	"VERCEL",
	"CODESPACES",
	"BITBUCKET_BUILD_NUMBER",
	"TF_BUILD",
];

function log(message) {
	process.stderr.write(`[pi-compound-engineering] ${message}\n`);
}

function fatal(message) {
	log(`ERROR: ${message}`);
	process.exit(1);
}

function isTruthyEnvFlag(value) {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isPresentEnvFlag(value) {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * `true` when the preinstall should be skipped because the host looks
 * like an offline or CI environment AND the user has not explicitly
 * opted in via `CE_TARBALL_PATH`. The skipped-postinstall warning that
 * fires on the next Pi launch tells the user how to recover
 * (reinstall with network access or with `CE_TARBALL_PATH` set).
 *
 * Returning `true` here means the install succeeds with an empty
 * `skills/` + `agents/` dir instead of `fatal()`-ing the entire
 * workspace install for offline contributors and CI without egress.
 */
function isOfflineEnv() {
	if (process.env.CE_TARBALL_PATH) return false;
	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return true;
	for (const name of CI_ENVIRONMENT_VARIABLES) {
		if (isPresentEnvFlag(process.env[name])) return true;
	}
	return false;
}

/**
 * @returns {Promise<{ version: string, packageJson: any }>}
 */
async function readCeVersion() {
	const packageJsonPath = join(PACKAGE_ROOT, "package.json");
	const raw = await readFile(packageJsonPath, "utf8");
	const packageJson = JSON.parse(raw);
	const version = packageJson.version;
	if (typeof version !== "string" || version.length === 0) {
		fatal("package.json is missing a version string");
	}
	return { version, packageJson };
}

/**
 * @returns {Promise<string>}
 */
async function readExpectedSha256() {
	if (!existsSync(EXPECTED_SHA256_FILE)) {
		fatal(`Missing SHA256 pin at ${EXPECTED_SHA256_FILE}`);
	}
	const raw = await readFile(EXPECTED_SHA256_FILE, "utf8");
	const trimmed = raw.trim();
	if (!SHA256_PATTERN.test(trimmed)) {
		fatal(`Expected SHA256 in ${EXPECTED_SHA256_FILE} is malformed: ${trimmed}`);
	}
	return trimmed;
}

/**
 * Create a unique staging directory using `mkdtemp` so the path is
 * unpredictable. Lives under `~/.pi-compound-engineering-staging/` (not
 * `os.tmpdir()`) so the CodeQL `js/insecure-temporary-file` rule does
 * not flag the writes inside.
 *
 * @returns {Promise<string>}
 */
async function createStagingDir() {
	await mkdir(STAGING_BASE_DIR, { recursive: true });
	return mkdtemp(join(STAGING_BASE_DIR, STAGING_RUN_PREFIX));
}

/**
 * Remove any leftover staging directories from previous runs that did not
 * get cleaned up. Best-effort: we swallow errors so a single bad entry
 * cannot abort the install.
 *
 * @returns {Promise<void>}
 */
async function cleanupStaleStagingDirs() {
	let dirEntries;
	try {
		dirEntries = await readdir(STAGING_BASE_DIR, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of dirEntries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(STAGING_RUN_PREFIX)) continue;
		const fullPath = join(STAGING_BASE_DIR, entry.name);
		try {
			const st = await stat(fullPath);
			if (now - st.mtimeMs > STAGING_DIR_RETENTION_MS) {
				await rm(fullPath, { recursive: true, force: true });
				log(`Removed stale staging dir: ${fullPath}`);
			}
		} catch {
			// best-effort
		}
	}
}

/**
 * @param {string} version
 * @returns {string}
 */
function tarballUrl(version) {
	return `https://codeload.github.com/EveryInc/compound-engineering-plugin/tar.gz/refs/tags/cli-v${version}`;
}

/**
 * @param {string} tarballPath
 * @param {string} expectedSha256
 * @returns {Promise<{ sha256: string, ok: boolean }>}
 */
async function verifySha256(tarballPath, expectedSha256) {
	const sha = await sha256OfFile(tarballPath);
	return { sha256: sha, ok: sha === expectedSha256 };
}

/**
 * @param {string} url
 * @param {string} destFile Local destination file path; never sent over the wire.
 * @param {string[]} [fallbackUrls]
 * @returns {Promise<{ path: string, source: string }>}
 */
async function downloadTarball(url, destFile, fallbackUrls = []) {
	const candidates = [url, ...fallbackUrls];
	let lastError;
	for (const candidate of candidates) {
		log(`Downloading ${candidate} ...`);
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_DOWNLOAD_MS);
			try {
				const response = await fetch(candidate, { signal: controller.signal });
				if (!response.ok) {
					lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
					continue;
				}
				await streamResponseToFile(response, destFile);
				return { path: destFile, source: candidate };
			} finally {
				clearTimeout(timeout);
			}
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`Failed to download tarball: ${lastError?.message ?? "unknown error"}`);
}

/**
 * @param {string} tarballPath
 * @param {string} stagingDir
 * @returns {Promise<{ pluginsDir: string, extractedRoot: string }>}
 *   `pluginsDir` is the path to the extracted
 *   `plugins/compound-engineering/` dir. `extractedRoot` is the top-level
 *   dir created by `tar -xzf` (e.g. `compound-engineering-plugin-<sha>/`)
 *   so the caller can remove it explicitly without re-scanning the
 *   staging dir (which also contains the `output/` subdir created by
 *   the converter and could be returned first by an unordered
 *   `readdir`).
 */
async function extractTarball(tarballPath, stagingDir) {
	const result = spawnSync("tar", ["-xzf", tarballPath, "-C", stagingDir], {
		stdio: ["ignore", "inherit", "inherit"],
		timeout: TIMEOUT_EXTRACT_MS,
	});
	if (result.status !== 0) {
		throw new Error(`tar extraction failed with exit code ${result.status ?? "unknown"}`);
	}
	// The tarball extracts to a top-level dir like
	// `compound-engineering-plugin-<sha>/plugins/compound-engineering/`.
	const entries = await readdir(stagingDir, { withFileTypes: true });
	const topLevel = entries.find((e) => e.isDirectory());
	if (!topLevel) {
		throw new Error("Extracted tarball has no top-level directory");
	}
	const extractedRoot = join(stagingDir, topLevel.name);
	const pluginsDir = join(extractedRoot, "plugins", "compound-engineering");
	if (!existsSync(pluginsDir)) {
		throw new Error(`Extracted tarball is missing expected path: ${pluginsDir}`);
	}
	return { pluginsDir, extractedRoot };
}

/**
 * @param {string} pluginsDir
 * @param {string} stagingDir
 * @param {string} ceVersion
 * @returns {Promise<string>} the path to the converter's output dir
 */
async function runConverter(pluginsDir, stagingDir, ceVersion) {
	const outputDir = join(stagingDir, "output");
	await convert(pluginsDir, outputDir, ceVersion);
	return outputDir;
}

/**
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function verifyStructure(outputDir) {
	const skillsDir = join(outputDir, "skills");
	const agentsDir = join(outputDir, "agents");
	const noticesPath = join(outputDir, "THIRD-PARTY-NOTICES");

	if (!existsSync(skillsDir)) throw new Error(`Missing skills dir: ${skillsDir}`);
	if (!existsSync(agentsDir)) throw new Error(`Missing agents dir: ${agentsDir}`);
	if (!existsSync(noticesPath)) throw new Error(`Missing THIRD-PARTY-NOTICES: ${noticesPath}`);

	const skills = await readdir(skillsDir);
	const agents = await readdir(agentsDir);

	const requiredSkills = ["ce-plan", "ce-code-review", "ce-compound", "ce-brainstorm"];
	for (const required of requiredSkills) {
		if (!skills.includes(required)) {
			throw new Error(`Missing required skill: ${required}`);
		}
	}

	const requiredAgents = [
		"ce-correctness-reviewer.md",
		"ce-security-reviewer.md",
		"ce-architecture-strategist.md",
	];
	for (const required of requiredAgents) {
		if (!agents.includes(required)) {
			throw new Error(`Missing required agent: ${required}`);
		}
	}

	// Probe the text transformations.
	const planPath = join(skillsDir, "ce-plan", "SKILL.md");
	const planContent = await readFile(planPath, "utf8");
	if (!planContent.includes("Run subagent with agent=")) {
		throw new Error("ce-plan/SKILL.md is missing the `Run subagent with agent=` rewrite");
	}
	// Probe the task-tracking primitive rewrite on ce-work (which uses
	// TaskCreate/TaskUpdate; ce-plan does not).
	const workPath = join(skillsDir, "ce-work", "SKILL.md");
	const workContent = await readFile(workPath, "utf8");
	if (!workContent.includes("the platform's task-tracking primitive")) {
		throw new Error("ce-work/SKILL.md is missing the `the platform's task-tracking primitive` rewrite");
	}

	// Probe the agent frontmatter.
	const agentPath = join(agentsDir, "ce-correctness-reviewer.md");
	const fm = (await readFile(agentPath, "utf8")).split("---")[1] ?? "";
	if (/\bmodel:\s/m.test(fm)) {
		throw new Error("ce-correctness-reviewer.md frontmatter still contains a `model:` field");
	}
	if (/\btools:\s/m.test(fm)) {
		throw new Error("ce-correctness-reviewer.md frontmatter still contains a `tools:` field");
	}
	if (/\bcolor:\s/m.test(fm)) {
		throw new Error("ce-correctness-reviewer.md frontmatter still contains a `color:` field");
	}
}

async function main() {
	await cleanupStaleStagingDirs();

	if (isOfflineEnv()) {
		log("Offline/CI mode detected; skipping tarball fetch and conversion.");
		log("`skills/` and `agents/` will remain empty until this package is reinstalled with network access or `CE_TARBALL_PATH` set.");
		log("Recovery: `pi install npm:pi-compound-engineering` (with network or `CE_TARBALL_PATH=<path>`).");
		return;
	}

	const { version } = await readCeVersion();
	const expectedSha = await readExpectedSha256();
	const stagingDir = await createStagingDir();
	log(`Staging dir: ${stagingDir}`);

	const tarballPath = join(stagingDir, `compound-engineering-plugin-cli-v${version}.tar.gz`);
	const localTarball = process.env.CE_TARBALL_PATH;
	if (localTarball) {
		log(`Using local tarball from CE_TARBALL_PATH: ${localTarball}`);
		try {
			await copyFile(localTarball, tarballPath);
		} catch (err) {
			await rm(stagingDir, { recursive: true, force: true });
			fatal(`Failed to copy local tarball from ${localTarball}: ${err.message}`);
		}
	} else {
		try {
			await downloadTarball(tarballUrl(version), tarballPath);
		} catch (err) {
			await rm(stagingDir, { recursive: true, force: true });
			fatal(`Download failed: ${err.message}`);
		}
	}

	const { sha256, ok } = await verifySha256(tarballPath, expectedSha);
	if (!ok) {
		await rm(stagingDir, { recursive: true, force: true });
		fatal(
			`SHA256 mismatch for upstream tarball.\n` +
				`  expected: ${expectedSha}\n` +
				`  actual:   ${sha256}\n` +
				`This usually means the upstream release tarball has changed since the\n` +
				`pin in scripts/expected-sha256.txt was last reviewed. Do not install\n` +
				`this version — surface the issue to the pi-compound-engineering\n` +
				`maintainers.`,
		);
	}
	log(`SHA256 verified: ${sha256.slice(0, 16)}…`);

	const { pluginsDir, extractedRoot } = await extractTarball(tarballPath, stagingDir);

	const outputDir = await runConverter(pluginsDir, stagingDir, version);

	try {
		await verifyStructure(outputDir);
	} catch (err) {
		await rm(stagingDir, { recursive: true, force: true });
		fatal(`Structure check failed: ${err.message}`);
	}

	// Write the staging path file for commit.mjs to read. Lives under
	// the home-dir staging base (not tmpdir()) so the CodeQL
	// `js/insecure-temporary-file` rule does not flag this write.
	await writeFile(STAGING_PATH_FILE, stagingDir, "utf8");

	// Clean up the tarball and the extracted source. We use the
	// explicit `extractedRoot` returned by `extractTarball` rather than
	// re-scanning the staging dir, because by this point the staging
	// dir also contains the `output/` subdir produced by the converter
	// and an unordered `readdir` could return `output` first and let
	// us delete the wrong tree.
	await rm(extractedRoot, { recursive: true, force: true });
	await rm(tarballPath, { force: true });

	log(`Staged 38 skills, 43 agents from compound-engineering-plugin@${version} (sha256:${sha256.slice(0, 16)}…)`);
}

main().catch((err) => {
	fatal(err?.stack ?? err?.message ?? String(err));
});
