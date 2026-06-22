#!/usr/bin/env node
// @ts-check
/**
 * CI structure check. Runs the same fetch + convert + commit flow that
 * `preinstall` runs, but in a temp dir, and asserts that the resulting
 * `skills/`, `agents/`, and `THIRD-PARTY-NOTICES` look correct.
 *
 * The verify script does NOT touch the production install dir. It
 * downloads the tarball, verifies the SHA, extracts it, runs the
 * converter, and asserts structure on the staging output.
 *
 * The script reads `CE_VERSION` from `package.json` and the expected
 * counts from `src/ce-version.ts` (parses them as a sanity check).
 *
 * Exit code 0 = all checks passed. Exit code 1 = at least one check failed.
 *
 * Usage:
 *   node scripts/verify.mjs
 */

import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { convert, sha256OfFile } from "./converter.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const STAGING_BASE_DIR = join(homedir(), ".pi-compound-engineering-staging");
const STAGING_PREFIX = "verify-";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

let passed = 0;
let failed = 0;
const failures = [];

function pass(label) {
	passed++;
	process.stdout.write(`  PASS  ${label}\n`);
}

function fail(label, detail) {
	failed++;
	failures.push({ label, detail });
	process.stdout.write(`  FAIL  ${label}\n`);
	if (detail) process.stdout.write(`        ${detail}\n`);
}

function section(title) {
	process.stdout.write(`\n${title}\n`);
}

async function readPackageJson() {
	const packageJsonPath = join(PACKAGE_ROOT, "package.json");
	const raw = await readFile(packageJsonPath, "utf8");
	return JSON.parse(raw);
}

async function readCeVersionTs() {
	const ceVersionPath = join(PACKAGE_ROOT, "src", "ce-version.ts");
	const raw = await readFile(ceVersionPath, "utf8");
	const versionMatch = raw.match(/export const CE_VERSION\s*=\s*"([^"]+)"/);
	const skillMatch = raw.match(/export const EXPECTED_SKILL_COUNT\s*=\s*(\d+)/);
	const agentMatch = raw.match(/export const EXPECTED_AGENT_COUNT\s*=\s*(\d+)/);
	return {
		version: versionMatch?.[1] ?? null,
		skillCount: skillMatch ? Number(skillMatch[1]) : null,
		agentCount: agentMatch ? Number(agentMatch[1]) : null,
	};
}

async function readExpectedSha() {
	const path = join(PACKAGE_ROOT, "scripts", "expected-sha256.txt");
	if (!existsSync(path)) return null;
	const raw = await readFile(path, "utf8");
	const trimmed = raw.trim();
	return SHA256_PATTERN.test(trimmed) ? trimmed : null;
}

async function downloadTarball(url, destFile) {
	const TIMEOUT_MS = 60_000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		if (!response.body) {
			throw new Error("Response body is empty");
		}
		await pipeline(/** @type {NodeJS.ReadableStream} */ (response.body), createWriteStream(destFile));
	} finally {
		clearTimeout(timeout);
	}
}

function extractTarball(tarballPath, stagingDir) {
	const result = spawnSync("tar", ["-xzf", tarballPath, "-C", stagingDir], {
		stdio: ["ignore", "inherit", "inherit"],
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(`tar extraction failed with exit code ${result.status ?? "unknown"}`);
	}
}

async function findExtractedRoot(stagingDir) {
	const entries = await readdir(stagingDir, { withFileTypes: true });
	const top = entries.find((e) => e.isDirectory());
	if (!top) throw new Error("Extracted tarball has no top-level directory");
	return join(stagingDir, top.name, "plugins", "compound-engineering");
}

async function main() {
	process.stdout.write("pi-compound-engineering structure check\n");
	process.stdout.write("==========================================\n");

	const packageJson = await readPackageJson();
	const ceVersion = await readCeVersionTs();
	const expectedSha = await readExpectedSha();

	section("Version checks");
	if (packageJson.version === ceVersion.version) {
		pass(`package.json version (${packageJson.version}) matches CE_VERSION (${ceVersion.version})`);
	} else {
		fail(
			"package.json version does not match CE_VERSION",
			`package.json=${packageJson.version} CE_VERSION=${ceVersion.version}`,
		);
	}
	if (ceVersion.skillCount !== null && ceVersion.skillCount > 0) {
		pass(`EXPECTED_SKILL_COUNT = ${ceVersion.skillCount}`);
	} else {
		fail("EXPECTED_SKILL_COUNT missing or invalid in src/ce-version.ts");
	}
	if (ceVersion.agentCount !== null && ceVersion.agentCount > 0) {
		pass(`EXPECTED_AGENT_COUNT = ${ceVersion.agentCount}`);
	} else {
		fail("EXPECTED_AGENT_COUNT missing or invalid in src/ce-version.ts");
	}

	if (!expectedSha) {
		fail("scripts/expected-sha256.txt is missing or malformed");
		process.exit(1);
	}
	pass(`expected SHA256 = ${expectedSha.slice(0, 16)}…`);

	section("Fetch + extract");
	await mkdir(STAGING_BASE_DIR, { recursive: true });
	const stagingDir = await mkdtemp(join(STAGING_BASE_DIR, STAGING_PREFIX));

	const tarballPath = join(stagingDir, "ce.tar.gz");
	const url = `https://codeload.github.com/EveryInc/compound-engineering-plugin/tar.gz/refs/tags/cli-v${ceVersion.version}`;
	try {
		await downloadTarball(url, tarballPath);
		pass(`downloaded ${url}`);
	} catch (err) {
		fail("download failed", err?.message ?? String(err));
		process.exit(1);
	}

	const sha = await sha256OfFile(tarballPath);
	if (sha === expectedSha) {
		pass(`SHA256 verified: ${sha.slice(0, 16)}…`);
	} else {
		fail("SHA256 mismatch", `expected=${expectedSha} actual=${sha}`);
	}

	try {
		extractTarball(tarballPath, stagingDir);
		pass("tar extraction");
	} catch (err) {
		fail("tar extraction failed", err?.message ?? String(err));
		process.exit(1);
	}

	let pluginsDir;
	try {
		pluginsDir = await findExtractedRoot(stagingDir);
		pass(`found plugins dir: ${pluginsDir}`);
	} catch (err) {
		fail("could not locate plugins/compound-engineering", err?.message ?? String(err));
		process.exit(1);
	}

	section("Convert + structure");
	const outputDir = join(stagingDir, "output");
	try {
		await convert(pluginsDir, outputDir, ceVersion.version);
		pass("converter returned");

		const skills = await readdir(join(outputDir, "skills"));
		const agents = await readdir(join(outputDir, "agents"));
		const notices = await readFile(join(outputDir, "THIRD-PARTY-NOTICES"), "utf8");

		if (skills.length === ceVersion.skillCount) {
			pass(`skill count = ${skills.length} (expected ${ceVersion.skillCount})`);
		} else {
			fail("skill count mismatch", `expected ${ceVersion.skillCount}, got ${skills.length}`);
		}
		if (agents.length === ceVersion.agentCount) {
			pass(`agent count = ${agents.length} (expected ${ceVersion.agentCount})`);
		} else {
			fail("agent count mismatch", `expected ${ceVersion.agentCount}, got ${agents.length}`);
		}

		const requiredSkills = ["ce-plan", "ce-code-review", "ce-compound", "ce-brainstorm"];
		for (const required of requiredSkills) {
			if (skills.includes(required)) {
				pass(`skill present: ${required}`);
			} else {
				fail(`missing required skill: ${required}`);
			}
		}

		const setupHealthScript = join(outputDir, "skills", "ce-setup", "scripts", "check-health");
		try {
			const setupHealthStat = await stat(setupHealthScript);
			if (setupHealthStat.isFile()) {
				pass("ce-setup bundled check-health script is present");
			} else {
				fail("ce-setup bundled check-health path is not a file", setupHealthScript);
			}
			if ((setupHealthStat.mode & 0o111) !== 0) {
				pass("ce-setup bundled check-health script is executable");
			} else {
				fail("ce-setup bundled check-health script is not executable", setupHealthScript);
			}
		} catch (err) {
			fail("ce-setup bundled check-health script is missing", err?.message ?? String(err));
		}

		const requiredAgents = [
			"ce-correctness-reviewer.md",
			"ce-security-reviewer.md",
			"ce-architecture-strategist.md",
		];
		for (const required of requiredAgents) {
			if (agents.includes(required)) {
				pass(`agent present: ${required}`);
			} else {
				fail(`missing required agent: ${required}`);
			}
		}

		// Resource-resolution guard: every backtick-wrapped skill resource
		// ref in a converted SKILL.md must resolve on disk. The converter rewrites
		// upstream `references/foo.md` to `skills/<skill>/references/foo.md` so it
		// resolves against the package-root base Pi injects. A broken ref here
		// means the converter rewrite (or an upstream change) would ENOENT at
		// runtime. See R5/R6 in the plan.
		const resourceRefPattern = /`skills\/(ce-[a-z0-9-]+)\/((?:references|scripts|assets)\/[A-Za-z0-9_./-]+)`/g;
		let resourceRefCount = 0;
		const brokenRefs = [];
		for (const skillName of skills) {
			const skillFile = join(outputDir, "skills", skillName, "SKILL.md");
			let content;
			try {
				content = await readFile(skillFile, "utf8");
			} catch {
				continue;
			}
			const refs = [...content.matchAll(resourceRefPattern)];
			for (const match of refs) {
				const refSkill = match[1];
				const refPath = match[2];
				const resolved = join(outputDir, "skills", refSkill, refPath);
				try {
					await access(resolved);
					resourceRefCount++;
				} catch {
					brokenRefs.push(`${skillName}: \`skills/${refSkill}/${refPath}\` -> ${resolved}`);
				}
			}
		}
		if (brokenRefs.length === 0) {
			pass(`all ${resourceRefCount} skill resource refs resolve on disk`);
		} else {
			fail(
				`${brokenRefs.length} skill resource ref(s) do not resolve`,
				brokenRefs.slice(0, 5).join("\n  "),
			);
		}

		const planContent = await readFile(join(outputDir, "skills", "ce-plan", "SKILL.md"), "utf8");
		if (planContent.includes("Run subagent with agent=")) {
			pass("ce-plan/SKILL.md has the `Run subagent with agent=` rewrite");
		} else {
			fail("ce-plan/SKILL.md is missing the `Run subagent with agent=` rewrite");
		}
		// Probe the task-tracking primitive rewrite on ce-work (which uses
		// TaskCreate/TaskUpdate; ce-plan does not).
		const workContent = await readFile(join(outputDir, "skills", "ce-work", "SKILL.md"), "utf8");
		if (workContent.includes("the platform's task-tracking primitive")) {
			pass("ce-work/SKILL.md has the `the platform's task-tracking primitive` rewrite");
		} else {
			fail("ce-work/SKILL.md is missing the `the platform's task-tracking primitive` rewrite");
		}

		const agentContent = await readFile(join(outputDir, "agents", "ce-correctness-reviewer.md"), "utf8");
		const fm = agentContent.split("---")[1] ?? "";
		if (!/\bmodel:\s/m.test(fm)) pass("ce-correctness-reviewer.md has no `model:` frontmatter field");
		else fail("ce-correctness-reviewer.md still has a `model:` frontmatter field");
		if (!/\btools:\s/m.test(fm)) pass("ce-correctness-reviewer.md has no `tools:` frontmatter field");
		else fail("ce-correctness-reviewer.md still has a `tools:` frontmatter field");
		if (!/\bcolor:\s/m.test(fm)) pass("ce-correctness-reviewer.md has no `color:` frontmatter field");
		else fail("ce-correctness-reviewer.md still has a `color:` frontmatter field");

		if (notices.length > 0) {
			pass(`THIRD-PARTY-NOTICES generated (${notices.length} bytes)`);
		} else {
			fail("THIRD-PARTY-NOTICES is empty");
		}
	} catch (err) {
		fail("converter threw", err?.stack ?? err?.message ?? String(err));
	}

	section("Summary");
	process.stdout.write(`  Passed: ${passed}\n`);
	process.stdout.write(`  Failed: ${failed}\n`);
	if (failed > 0) {
		process.stdout.write("\nFailures:\n");
		for (const f of failures) {
			process.stdout.write(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}\n`);
		}
	}

	// Cleanup
	try {
		await rm(stagingDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	process.stderr.write(`[pi-compound-engineering] verify failed: ${err?.stack ?? err?.message ?? String(err)}\n`);
	process.exit(1);
});
