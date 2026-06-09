import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { MacSleepInhibitor } from "../src/sleep-inhibitor.js";

const STATUS_KEY = "pi-insomnia";

// Braille spinner — same 10-frame cycle used by npm, vite, webpack, etc.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let spinnerFrame = 0;

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

function startSpinner(ctx: ExtensionContext): void {
  if (!ctx.hasUI || spinnerTimer) return;
  spinnerFrame = 0;
  setStatus(ctx, `${SPINNER_FRAMES[0]} sleep inhibited`);
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    setStatus(ctx, `${SPINNER_FRAMES[spinnerFrame]} sleep inhibited`);
  }, SPINNER_INTERVAL_MS);
}

function stopSpinner(ctx: ExtensionContext): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }
  setStatus(ctx, undefined);
}

export default function piInsomnia(pi: ExtensionAPI) {
  reportInstallTelemetry();

  const inhibitor = new MacSleepInhibitor();

  pi.on("agent_start", async (_event, ctx) => {
    if (inhibitor.acquire()) startSpinner(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    inhibitor.release();
    if (!inhibitor.isInhibiting) stopSpinner(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inhibitor.forceStop();
    stopSpinner(ctx);
  });
}
