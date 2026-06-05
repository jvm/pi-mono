import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleInitCommand } from "../src/init.js";

export default function piAgentsMd(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "create an AGENTS.md file with instructions for Pi",
    handler: async (args, ctx) => {
      await handleInitCommand(pi, args, ctx);
    },
  });
}
