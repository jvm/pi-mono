import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CE_VERSION, getCeRepoUrl } from "./ce-version.js";
import {
	formatSourceLabel,
	getPackageInstallDir,
	isInstallComplete,
	runDependencyCheck,
	type ToolDetection,
} from "./dependency-check.js";

function countEntries(dir: string): number {
	if (!existsSync(dir)) return 0;
	try {
		return readdirSync(dir).length;
	} catch {
		return 0;
	}
}

function findAgentsMd(cwd: string): string | undefined {
	for (const name of ["AGENTS.md", "AGENTS.MD"]) {
		const path = join(cwd, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function formatPeerLine(label: string, detection: ToolDetection): string {
	const value = detection.available ? `available (${formatSourceLabel(detection.sourceInfo)})` : "missing";
	return `  ${label}: ${value}`;
}

/**
 * Render the `/ce-status` output as a plain text report. The report
 * includes the synced CE version, the local skill/agent counts, the
 * detection status of `pi-subagents` and `pi-ask-user`, and the upstream
 * repo URL.
 */
export function buildCeStatusReport(pi: ExtensionAPI, cwd: string): string {
	const installDir = getPackageInstallDir();
	const check = runDependencyCheck(pi);
	const skillCount = countEntries(join(installDir, "skills"));
	const agentCount = countEntries(join(installDir, "agents"));
	const installStatus = isInstallComplete(installDir)
		? "complete"
		: "incomplete (postinstall was skipped or failed)";

	const lines = [
		`pi-compound-engineering@${CE_VERSION}`,
		"",
		`Mirrors compound-engineering-plugin@${CE_VERSION}`,
		`Upstream: ${getCeRepoUrl()}`,
		"",
		"Install",
		`  Status: ${installStatus}`,
		`  Skills: ${skillCount}`,
		`  Agents: ${agentCount}`,
		"",
		"Peer packages",
		formatPeerLine("pi-subagents (subagent tool)", check.subagent),
		formatPeerLine("pi-ask-user   (ask_user tool)", check.askUser),
		"",
		`Project AGENTS.md: ${findAgentsMd(cwd) ?? "(not found)"}`,
	];

	return lines.join("\n");
}

export function registerCeStatusCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ce-status", {
		description: "Show the synced CE version, skill/agent counts, and peer-package detection",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = buildCeStatusReport(pi, ctx.cwd);
			await ctx.ui.editor("pi-compound-engineering status", report);
		},
	});
}
