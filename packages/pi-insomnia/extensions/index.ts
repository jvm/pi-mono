import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { MacSleepInhibitor } from "../src/sleep-inhibitor.js";

const STATUS_KEY = "pi-insomnia";

const AWAKE_ICON = "\u{f0176}"; // Nerd Fonts 3 nf-md-coffee

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

export default function piInsomnia(
  pi: ExtensionAPI,
  inhibitor = new MacSleepInhibitor(),
) {
  reportInstallTelemetry();

  pi.on("agent_start", async (_event, ctx) => {
    if (inhibitor.acquire()) setStatus(ctx, AWAKE_ICON);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    inhibitor.release();
    if (!inhibitor.isInhibiting) setStatus(ctx, undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inhibitor.forceStop();
    setStatus(ctx, undefined);
  });
}
