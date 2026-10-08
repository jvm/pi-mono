import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { registerAutomaticCompaction } from "../src/automatic-compaction.js";

export default function piCodexCompaction(pi: ExtensionAPI): void {
  reportInstallTelemetry();
  registerAutomaticCompaction(pi);
}
