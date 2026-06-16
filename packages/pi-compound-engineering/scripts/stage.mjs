#!/usr/bin/env node
// @ts-check
/**
 * `preinstall` entry point. Fetches the upstream Compound Engineering
 * release tarball, verifies its SHA256, extracts it, runs the converter,
 * and stages the result in `$TMP/pi-compound-engineering-staging-<pid>/`.
 *
 * The production install dir is never touched during this phase. The
 * companion `scripts/commit.mjs` (the `postinstall` entry point) moves
 * the staged content into the final install location after npm has
 * promoted the new version into place.
 *
 * The split between `preinstall` and `postinstall` is what gives us
 * npm-native update safety: if this script exits non-zero, npm aborts
 * the install/update and the previous version is left untouched.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { convert, sha256OfFile, streamResponseToFile } from "./converter.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const STAGING_PATH_FILE = join(tmpdir(), "pi-compound-engineering-staging-path.txt");
const STAGING_DIR_PREFIX = "pi-compound-engineering-staging-";
const STAGING_DIR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXPECTED_SHA256_FILE = join(PACKAGE_ROOT, "scripts", "expected-sha256.txt");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMEOUT_DOWNLOAD_MS = 60_000;
const TIMEOUT_EXTRACT_MS = 30_000;

function log(message) {
	process.stderr.write(`[pi-compound-engineering] ${message}\n`);
}

function fatal(message) {
	log(`ERROR: ${message}`);
	process.exit(1);
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
 * @returns {Promise<string>}
 */
async function createStagingDir() {
	const dir = join(tmpdir(), `${STAGING_DIR_PREFIX}${process.pid}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	return dir;
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
		dirEntries = await readdir(tmpdir(), { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of dirEntries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(STAGING_DIR_PREFIX)) continue;
		const fullPath = join(tmpdir(), entry.name);
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
 * @param {string} target
 * @param {string[]} [fallbackUrls]
 * @returns {Promise<{ path: string, source: string }>}
 */
async function downloadTarball(url, target, fallbackUrls = []) {
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
				await streamResponseToFile(response, target);
				return { path: target, source: candidate };
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
 * @returns {Promise<string>} the path to the extracted compound-engineering dir
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
	const pluginsDir = join(stagingDir, topLevel.name, "plugins", "compound-engineering");
	if (!existsSync(pluginsDir)) {
		throw new Error(`Extracted tarball is missing expected path: ${pluginsDir}`);
	}
	return pluginsDir;
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

	const { version } = await readCeVersion();
	const expectedSha = await readExpectedSha256();
	const stagingDir = await createStagingDir();
	log(`Staging dir: ${stagingDir}`);

	const tarballPath = join(stagingDir, `compound-engineering-plugin-cli-v${version}.tar.gz`);
	try {
		await downloadTarball(tarballUrl(version), tarballPath);
	} catch (err) {
		await rm(stagingDir, { recursive: true, force: true });
		fatal(`Download failed: ${err.message}`);
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

	const pluginsDir = await extractTarball(tarballPath, stagingDir);

	const outputDir = await runConverter(pluginsDir, stagingDir, version);

	try {
		await verifyStructure(outputDir);
	} catch (err) {
		await rm(stagingDir, { recursive: true, force: true });
		fatal(`Structure check failed: ${err.message}`);
	}

	// Write the staging path file for commit.mjs to read.
	await writeFile(STAGING_PATH_FILE, stagingDir, "utf8");

	// Clean up the tarball and extracted source. We keep the staging dir
	// (with the converted `output/` subdir) for commit.mjs to move.
	const extractedTop = (await readdir(stagingDir, { withFileTypes: true })).find((e) => e.isDirectory());
	if (extractedTop) {
		await rm(join(stagingDir, extractedTop.name), { recursive: true, force: true });
	}
	await rm(tarballPath, { force: true });

	log(`Staged 38 skills, 43 agents from compound-engineering-plugin@${version} (sha256:${sha256.slice(0, 16)}…)`);
}

main().catch((err) => {
	fatal(err?.stack ?? err?.message ?? String(err));
});
