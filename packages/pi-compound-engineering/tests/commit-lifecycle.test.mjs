import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const PACKAGE_DIR = new URL("..", import.meta.url);

function writeFile(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

test("commit lifecycle removes legacy generated agents after a skills-only upgrade", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-compound-engineering-commit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const packageRoot = join(root, "package");
	const scriptRoot = join(packageRoot, "scripts");
	const home = join(root, "home");
	const stagingBase = join(home, ".pi-compound-engineering-staging");
	const stagingDir = join(stagingBase, "run-test");
	const outputDir = join(stagingDir, "output");

	mkdirSync(scriptRoot, { recursive: true });
	cpSync(new URL("scripts/commit.mjs", PACKAGE_DIR), join(scriptRoot, "commit.mjs"));
	writeFile(join(packageRoot, "agents", "legacy-reviewer.md"), "legacy agent\n");
	writeFile(join(outputDir, "skills", "ce-plan", "SKILL.md"), "new skill\n");
	writeFile(join(outputDir, "THIRD-PARTY-NOTICES"), "new notices\n");
	writeFile(join(stagingBase, "staging-path.txt"), `${stagingDir}\n`);

	const result = spawnSync(process.execPath, [join(scriptRoot, "commit.mjs")], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(packageRoot, "agents")), false);
	assert.equal(readFileSync(join(packageRoot, "skills", "ce-plan", "SKILL.md"), "utf8"), "new skill\n");
	assert.equal(readFileSync(join(packageRoot, "THIRD-PARTY-NOTICES"), "utf8"), "new notices\n");
	assert.equal(existsSync(stagingDir), false);
	assert.equal(existsSync(join(stagingBase, "staging-path.txt")), false);
});
