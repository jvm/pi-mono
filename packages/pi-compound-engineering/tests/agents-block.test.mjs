import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	AGENTS_BLOCK_BODY,
	AGENTS_BLOCK_END,
	AGENTS_BLOCK_START,
	upsertAgentsBlock,
} from "../src/agents-block.ts";

/**
 * Create a fresh throwaway cwd for a test. Returns the cwd path and a
 * cleanup function the test should call in a `t.after` (or equivalent).
 *
 * @returns {{ cwd: string, cleanup: () => void }}
 */
function makeCwd() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-compound-engineering-agents-block-"));
	return {
		cwd,
		cleanup: () => {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

function readAgents(cwd) {
	return readFileSync(join(cwd, "AGENTS.md"), "utf8");
}

function writeAgents(cwd, body) {
	writeFileSync(join(cwd, "AGENTS.md"), body, "utf8");
}

test("upsertAgentsBlock: creates AGENTS.md with the block when it does not exist", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, new RegExp(AGENTS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
		assert.match(body, /pi-subagents/);
		assert.match(body, /pi-ask-user/);
		assert.match(body, new RegExp(AGENTS_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: returns false and is a no-op when the block is already up to date", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		upsertAgentsBlock(cwd);
		const before = readAgents(cwd);
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, false);
		const after = readAgents(cwd);
		assert.equal(after, before);
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: updates the block in place when the body changes (e.g. version bump)", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		upsertAgentsBlock(cwd);
		const staleBody = readAgents(cwd)
			// Simulate a stale block by replacing the body with an older
			// version of the documentation text.
			.replace(AGENTS_BLOCK_BODY, "## Compound Engineering (Pi compatibility)\n\nOLD TEXT\n");
		writeAgents(cwd, staleBody);

		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
		assert.doesNotMatch(body, /OLD TEXT/);
		assert.match(body, /pi-subagents/);
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: appends the block (preserving user content) when AGENTS.md exists without markers", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		const pre = "# My project\n\nSome custom agent notes here.\n";
		writeAgents(cwd, pre);
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, /^# My project/);
		assert.match(body, /Some custom agent notes here\./);
		// Block must be appended after a blank line, with the start/end
		// markers and the current body content.
		assert.ok(body.indexOf(AGENTS_BLOCK_START) > body.indexOf("custom agent notes"));
		assert.match(body, /pi-subagents/);
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: handles an empty AGENTS.md by writing the block only", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		writeAgents(cwd, "");
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, new RegExp(AGENTS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
		// No leading user content; body should start with the block.
		assert.ok(body.startsWith(AGENTS_BLOCK_START));
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: handles a whitespace-only AGENTS.md the same as empty", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		writeAgents(cwd, "   \n\n  \n");
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: preserves trailing content after the end marker when replacing an old block", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		const pre = [
			"# Heading",
			"",
			AGENTS_BLOCK_START,
			"OLD BLOCK",
			AGENTS_BLOCK_END,
			"",
			"## After the block (must be preserved)",
		].join("\n");
		writeAgents(cwd, pre);

		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
		assert.doesNotMatch(body, /OLD BLOCK/);
		// Trailing user content must remain in place and follow the
		// refreshed block.
		assert.ok(body.indexOf("## After the block (must be preserved)") > body.indexOf(AGENTS_BLOCK_END));
	} finally {
		cleanup();
	}
});

test("upsertAgentsBlock: re-running after a manual delete of just the block re-inserts it", () => {
	const { cwd, cleanup } = makeCwd();
	try {
		upsertAgentsBlock(cwd);
		// User removed the block but kept the file.
		const stripped = "# My project\n\nManual notes.\n";
		writeAgents(cwd, stripped);
		const changed = upsertAgentsBlock(cwd);
		assert.equal(changed, true);
		const body = readAgents(cwd);
		assert.match(body, /## Compound Engineering \(Pi compatibility\)/);
	} finally {
		cleanup();
	}
});
