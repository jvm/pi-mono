import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { MacSleepInhibitor } from "../src/sleep-inhibitor.js";

const STATUS_KEY = "pi-insomnia";

function setStatus(ctx: ExtensionContext, active: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, active ? "☕ sleep inhibited" : undefined);
}

export default function piInsomnia(pi: ExtensionAPI) {
  reportInstallTelemetry();

  const inhibitor = new MacSleepInhibitor();

  pi.on("agent_start", async (_event, ctx) => {
    if (inhibitor.acquire()) setStatus(ctx, true);
  });

  pi.on("agent_end", async (_event, ctx) => {
    inhibitor.release();
    if (!inhibitor.isInhibiting) setStatus(ctx, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inhibitor.forceStop();
    setStatus(ctx, false);
  });
}
