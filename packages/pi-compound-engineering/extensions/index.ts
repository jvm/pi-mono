import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { upsertAgentsBlock } from "../src/agents-block.js";
import { isInstallComplete, maybeWarnAboutDependencies } from "../src/dependency-check.js";
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
		// Only write the AGENTS.md block when the install is complete. If the
		// install is incomplete, the skipped-postinstall warning is more
		// useful than appending a block pointing at packages that the user
		// has not yet installed.
		if (isInstallComplete()) {
			upsertAgentsBlock(ctx.cwd);
		}
		maybeWarnAboutDependencies(pi, ctx);
	});
}
