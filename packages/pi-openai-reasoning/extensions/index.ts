import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { registerLegacyReasoning } from "../src/reasoning.js";

export default function piOpenaiReasoning(pi: ExtensionAPI): void {
  reportInstallTelemetry();
  registerLegacyReasoning(pi, VERSION);
}
