import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { UsageMonitor } from "../src/monitor.js";

export default function subsUsage(pi: ExtensionAPI): void {
  reportInstallTelemetry();
  const monitor = new UsageMonitor();
  pi.on("session_start", (_event, ctx) => monitor.start(ctx));
  pi.on("model_select", (event, ctx) => monitor.select(ctx, event.model));
  pi.on("session_shutdown", () => monitor.stop());
  pi.registerCommand("subs-usage", {
    description: "Refresh all configured subscription usage, or turn monitoring on/off for this session",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim().toLowerCase();
      if (action === "off") await monitor.toggle(ctx, false);
      else if (action === "on") await monitor.toggle(ctx, true);
      else if (action === "" || action === "refresh") await monitor.refresh();
      else ctx.ui.notify("Usage: /subs-usage [refresh|on|off]", "info");
    },
  });
}
