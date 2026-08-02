import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { applyFastMode, supportsFastMode } from "../src/fast-mode.js";

const STATUS_KEY = "pi-fast";

type Toggle = "on" | "off" | "toggle";

export default function piFast(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  let enabled = false;

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    const supported = supportsFastMode(ctx.model);
    const text = !supported ? "Fast n/a" : enabled ? "Fast on" : "Fast off";
    const color = enabled && supported ? "warning" : "muted";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    if (next && !supportsFastMode(ctx.model)) {
      notify(ctx, "Fast mode is unavailable for the current provider/model.", "warning");
      updateStatus(ctx);
      return;
    }

    enabled = next;
    updateStatus(ctx);
    notify(
      ctx,
      next
        ? "Fast mode enabled; supported requests use priority processing and increased usage."
        : "Fast mode disabled.",
      next ? "warning" : "info",
    );
  }

  function toggle(ctx: ExtensionContext): void {
    setEnabled(!enabled, ctx);
  }

  pi.registerCommand("fast", {
    description: "Toggle Fast mode for supported provider/models",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase() as Toggle | "";
      if (mode === "on") return setEnabled(true, ctx);
      if (mode === "off") return setEnabled(false, ctx);
      if (mode === "" || mode === "toggle") return toggle(ctx);
      notify(ctx, "Usage: /fast [on|off|toggle]", "warning");
    },
  });

  pi.registerShortcut(Key.ctrlShift("f"), {
    description: "Toggle Fast mode",
    handler: toggle,
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !supportsFastMode(ctx.model)) return;
    return applyFastMode(event.payload, ctx.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = false;
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
