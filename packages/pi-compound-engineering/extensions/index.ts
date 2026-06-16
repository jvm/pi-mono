import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { upsertAgentsBlock } from "../src/agents-block.js";
import { isInstallComplete, maybeWarnAboutDependencies, runDependencyCheck } from "../src/dependency-check.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { registerCeStatusCommand } from "../src/status-command.js";

export default function piCompoundEngineering(pi: ExtensionAPI) {
	reportInstallTelemetry();

	// Register /ce-status first so it is always available, even when the
	// install is incomplete (e.g. `--ignore-scripts` was used).
	registerCeStatusCommand(pi);

	// The dependency check and the AGENTS.md block are deferred to
	// `session_start` so we have a live `ExtensionContext` (and a cwd).
	pi.on("session_start", async (_event, ctx) => {
		// The AGENTS.md block is informational about the two peer
		// packages this extension recommends (pi-subagents, pi-ask-user).
		// Only write the block when the install is complete AND at least
		// one of the peer packages is missing — otherwise the block is
		// noise the user didn't ask for. The skipped-postinstall
		// warning below still covers the "install didn't run" case.
		if (isInstallComplete()) {
			const result = runDependencyCheck(pi);
			if (!result.subagent.available || !result.askUser.available) {
				upsertAgentsBlock(ctx.cwd);
			}
		}
		maybeWarnAboutDependencies(pi, ctx);
	});
}
