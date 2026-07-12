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

/**
 * Build the skipped-install warning with the correct npm `--prefix` for the
 * actual install location. The package install dir is
 * `<npm-root>/node_modules/pi-compound-engineering`, so two `dirname` levels
 * up yields the npm root (`~/.pi/agent/npm` for global, `.pi/npm` for
 * project-local). Deriving the prefix here keeps the recovery command correct
 * for both global and `pi install -l` installs.
 */
function buildPostinstallWarning(installDir: string): string {
	const npmPrefix = dirname(dirname(installDir));
	return `pi-compound-engineering: install scripts did not run, so CE skills are not installed. npm 12+ blocks unapproved dependency scripts: run \`npm install-scripts approve pi-compound-engineering --prefix ${npmPrefix}\`, then \`npm rebuild pi-compound-engineering --prefix ${npmPrefix}\`; otherwise, ensure scripts are enabled and rebuild the package. Restart Pi afterward.`;
}

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
 * `skills/` directory regardless of which directory the user invoked the
 * command from.
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
 * Check whether the install dir has a populated `skills/` directory. Upstream
 * v3.14.0+ is intentionally skills-only, so agents are not an install
 * completeness requirement.
 */
export function isInstallComplete(installDir: string = getPackageInstallDir()): boolean {
	const skillsDir = join(installDir, "skills");
	if (!existsSync(skillsDir)) return false;
	try {
		const skills = readdirSync(skillsDir);
		return skills.length > 0;
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
export function maybeWarnAboutDependencies(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	installDir: string = getPackageInstallDir(),
): void {
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

	if (!isInstallComplete(installDir) && !warnedPostinstallSessions.has(sessionId)) {
		warnedPostinstallSessions.add(sessionId);
		ctx.ui.notify(buildPostinstallWarning(installDir), "warning");
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
