import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_BLOCK_START = "<!-- BEGIN COMPOUND PI TOOL MAP -->";
export const AGENTS_BLOCK_END = "<!-- END COMPOUND PI TOOL MAP -->";

export const AGENTS_BLOCK_BODY = `## Compound Engineering (Pi compatibility)

This block is added by the pi-compound-engineering package.

Pi extensions used by skills shipped by this package:
- Required for full functionality: \`pi-subagents\` (by nicobailon) provides the \`subagent\` tool used by ce-compound, ce-code-review, ce-plan, ce-compound-refresh, and other parallel-agent skills.
- Recommended: \`pi-ask-user\` (by edlsh) provides the \`ask_user\` tool; skills fall back to numbered options in chat when it is missing.

Install with:
  pi install npm:pi-subagents
  pi install npm:pi-ask-user
`;

function buildBlock(): string {
	return [AGENTS_BLOCK_START, AGENTS_BLOCK_BODY.trim(), AGENTS_BLOCK_END].join("\n");
}

/**
 * Upsert the dependency block into the project `AGENTS.md` at `<cwd>/AGENTS.md`.
 * The block is idempotent: if the start/end markers are already present, the
 * existing block is left in place (or replaced with the current text). If the
 * file does not exist, it is created.
 *
 * Returns `true` if a write happened.
 */
export function upsertAgentsBlock(cwd: string): boolean {
	const target = join(cwd, "AGENTS.md");
	const block = buildBlock();

	if (!existsSync(target)) {
		writeFileSync(target, `${block}\n`, "utf8");
		return true;
	}

	const existing = readFileSync(target, "utf8");
	const startIndex = existing.indexOf(AGENTS_BLOCK_START);
	const endIndex = existing.indexOf(AGENTS_BLOCK_END);

	if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
		const before = existing.slice(0, startIndex).trimEnd();
		const after = existing.slice(endIndex + AGENTS_BLOCK_END.length).trimStart();
		const updated = [before, block, after].filter(Boolean).join("\n\n") + "\n";
		if (updated !== existing) {
			writeFileSync(target, updated, "utf8");
			return true;
		}
		return false;
	}

	if (existing.trim().length === 0) {
		writeFileSync(target, `${block}\n`, "utf8");
		return true;
	}

	const updated = `${existing.trimEnd()}\n\n${block}\n`;
	if (updated !== existing) {
		writeFileSync(target, updated, "utf8");
		return true;
	}
	return false;
}
