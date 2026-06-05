import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleInitCommand } from "../src/init.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";

export default function piAgentsMd(pi: ExtensionAPI) {
  reportInstallTelemetry();

  pi.registerCommand("init", {
    description: "create an AGENTS.md file with instructions for Pi",
    handler: async (args, ctx) => {
      await handleInitCommand(pi, args, ctx);
    },
  });
}
