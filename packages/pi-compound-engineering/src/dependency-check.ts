import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SourceInfo } from "@earendil-works/pi-coding-agent";

/**
 * Result of a single dependency check.
 */
export interface ToolDetection {
	available: boolean;
	sourceInfo: SourceInfo | undefined;
}

/**
 * Result of a full dependency check pass.
 */
export interface DependencyCheckResult {
	subagent: ToolDetection;
	askUser: ToolDetection;
}

/**
 * Run the full dependency check (subagent + ask_user) and return the result
 * for `/ce-status` and the agents block.
 */
export function runDependencyCheck(pi: ExtensionAPI): DependencyCheckResult {
	const tools = pi.getAllTools();
	const subagentTool = tools.find((t) => t.name === "subagent");
	const askUserTool = tools.find((t) => t.name === "ask_user");

	const subagent: ToolDetection = subagentTool
		? { available: true, sourceInfo: subagentTool.sourceInfo }
		: { available: false, sourceInfo: undefined };
	const askUser: ToolDetection = askUserTool
		? { available: true, sourceInfo: askUserTool.sourceInfo }
		: { available: false, sourceInfo: undefined };

	return { subagent, askUser };
}

/**
 * Render a short, human-readable source label for a `SourceInfo` object.
 *
 * The convention is `<source>` if it looks like a package name, otherwise
 * `<scope>:<source>` (e.g. `user:local` for a user-local extension).
 * The baseDir is appended in parens when present and the source is generic
 * (`local`, `cli`, `auto`, `builtin`).
 */
export function formatSourceLabel(sourceInfo: SourceInfo | undefined): string {
	if (!sourceInfo) return "(unknown)";
	const source = sourceInfo.source ?? "unknown";
	const generic = ["local", "cli", "auto", "builtin", "sdk"];
	if (generic.includes(source) && sourceInfo.baseDir) {
		return `${sourceInfo.scope ?? "?"}:${source} (${sourceInfo.baseDir})`;
	}
	if (generic.includes(source)) {
		return `${sourceInfo.scope ?? "?"}:${source}`;
	}
	return source;
}

const SUBAGENT_WARNING =
	"pi-compound-engineering: pi-subagents is not installed. Skills that dispatch subagents (ce-compound, ce-code-review, ce-plan, ce-compound-refresh) will fall back to inline execution. Install with: pi install npm:pi-subagents";

const ASK_USER_WARNING =
	"pi-compound-engineering: pi-ask-user is not installed. Interactive skills (ce-plan, ce-brainstorm, ce-debug, ce-compound, ce-worktree, ce-promote, ce-sessions, ce-ideate) will fall back to numbered options in chat. Install with: pi install npm:pi-ask-user";

const POSTINSTALL_SKIPPED_WARNING =
	"pi-compound-engineering: postinstall was skipped or failed. CE skills are not installed. Re-run `pi install npm:pi-compound-engineering` (without --ignore-scripts) and restart Pi.";

/**
 * Per-session dedupe sets for the three one-shot warnings. Module-scope
 * state so the warning fires at most once per session. The `sessionId`
 * discriminator re-arms the warning on a new session.
 */
const warnedSubagentSessions = new Set<string>();
const warnedAskUserSessions = new Set<string>();
const warnedPostinstallSessions = new Set<string>();

/**
 * The package's install dir, computed from the current module URL. Used by
 * the skipped-postinstall check and by `/ce-status` to find the synced
 * `skills/` and `agents/` directories regardless of which directory the
 * user invoked the command from.
 */
const PACKAGE_INSTALL_DIR = (() => {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return process.cwd();
	}
})();

export function getPackageInstallDir(): string {
	return PACKAGE_INSTALL_DIR;
}

/**
 * Check whether the install dir has a populated `skills/` and `agents/`.
 * Both must exist and contain at least one entry for the install to be
 * considered complete.
 */
export function isInstallComplete(installDir: string = getPackageInstallDir()): boolean {
	const skillsDir = join(installDir, "skills");
	const agentsDir = join(installDir, "agents");
	if (!existsSync(skillsDir) || !existsSync(agentsDir)) return false;
	try {
		const skills = readdirSync(skillsDir);
		const agents = readdirSync(agentsDir);
		return skills.length > 0 && agents.length > 0;
	} catch {
		return false;
	}
}

/**
 * Run the per-session warning logic. Emits one-shot `ctx.ui.notify` messages
 * for missing peer packages and for a skipped/failed postinstall. Safe to
 * call multiple times — dedupes by session file path (or cwd if no
 * session file is associated).
 */
export function maybeWarnAboutDependencies(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
	const result = runDependencyCheck(pi);

	if (!result.subagent.available && !warnedSubagentSessions.has(sessionId)) {
		warnedSubagentSessions.add(sessionId);
		ctx.ui.notify(SUBAGENT_WARNING, "warning");
	}

	if (!result.askUser.available && !warnedAskUserSessions.has(sessionId)) {
		warnedAskUserSessions.add(sessionId);
		ctx.ui.notify(ASK_USER_WARNING, "warning");
	}

	if (!isInstallComplete() && !warnedPostinstallSessions.has(sessionId)) {
		warnedPostinstallSessions.add(sessionId);
		ctx.ui.notify(POSTINSTALL_SKIPPED_WARNING, "warning");
	}
}

/**
 * Clear the per-session dedupe sets. Intended for tests.
 */
export function _resetWarningState(): void {
	warnedSubagentSessions.clear();
	warnedAskUserSessions.clear();
	warnedPostinstallSessions.clear();
}
