import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { createSleepInhibitor, type SleepInhibitor } from "../src/sleep-inhibitor.js";

const STATUS_KEY = "pi-insomnia";

const AWAKE_ICON = "\u{f0176}"; // Nerd Fonts 3 nf-md-coffee

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

export default function piInsomnia(
  pi: ExtensionAPI,
  inhibitor: SleepInhibitor = createSleepInhibitor(),
) {
  reportInstallTelemetry();

  let lastContext: ExtensionContext | undefined;
  let notified = false;
  inhibitor.onUnavailable = (message) => {
    const ctx = lastContext;
    if (!ctx) return;
    setStatus(ctx, undefined);
    if (notified || ctx.mode !== "tui") return;
    notified = true;
    ctx.ui.notify(message, "warning");
  };

  pi.on("agent_start", async (_event, ctx) => {
    lastContext = ctx;
    if (inhibitor.acquire()) setStatus(ctx, AWAKE_ICON);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    inhibitor.release();
    if (!inhibitor.isInhibiting) setStatus(ctx, undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inhibitor.forceStop();
    setStatus(ctx, undefined);
    lastContext = undefined;
  });
}
