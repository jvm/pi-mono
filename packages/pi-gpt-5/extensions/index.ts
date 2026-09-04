import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { featuresFor } from "../src/features.js";
import {
  DEFAULT_SETTINGS,
  applyCorePack,
  type CorePackSettings,
  type ImageDetailPin,
  type ReasoningContextPin,
  type VerbosityPin,
} from "../src/core-pack.js";
import { resolveProModeEntitlement } from "../src/entitlement.js";

const STATUS_KEY = "pi-gpt-5";

const CONTEXT_VALUES: readonly ReasoningContextPin[] = ["auto", "all_turns", "current_turn"];
const VERBOSITY_VALUES: readonly VerbosityPin[] = ["auto", "low", "medium", "high"];
const DETAIL_VALUES: readonly ImageDetailPin[] = ["auto", "low", "high", "original"];

export default function piGpt5(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  let settings: CorePackSettings = { ...DEFAULT_SETTINGS };

  function gateFor(ctx: ExtensionContext) {
    return featuresFor(ctx.model?.id ?? "");
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const gated = gateFor(ctx) !== undefined;
    const active: string[] = [];
    if (settings.proMode) active.push("pro");
    if (settings.reasoningContext !== "auto") active.push(`ctx:${settings.reasoningContext}`);
    if (settings.verbosity !== "auto") active.push(`v:${settings.verbosity}`);
    if (settings.imageDetail !== "auto") active.push(`img:${settings.imageDetail}`);
    const text = !gated ? "GPT-5 n/a" : active.length > 0 ? `GPT-5 ${active.join(" ")}` : "GPT-5 off";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(active.length > 0 ? "success" : "muted", text));
  }

  function setProMode(ctx: ExtensionContext): void {
    const gate = gateFor(ctx);
    if (!gate?.proMode) {
      notify(ctx, `Pro mode is not available for ${ctx.model?.id ?? "this model"}; it requires GPT-5.6.`, "warning");
      return;
    }
    if (settings.proMode) {
      settings = { ...settings, proMode: false };
      notify(ctx, "Pro mode disabled.", "info");
    } else {
      const entitlement = resolveProModeEntitlement(ctx.modelRegistry, ctx.model);
      if (!entitlement.allowed) {
        notify(ctx, "Pro mode is not entitled for this session.", "warning");
        return;
      }
      settings = { ...settings, proMode: true };
      notify(ctx, entitlement.warning ? `Pro mode enabled. ${entitlement.warning}` : "Pro mode enabled; requests use more model work at standard token rates.", entitlement.warning ? "warning" : "info");
    }
    updateStatus(ctx);
  }

  function setPinned<K extends "reasoningContext" | "verbosity" | "imageDetail">(
    key: K,
    value: CorePackSettings[K],
    allowedLabel: string,
    ctx: ExtensionContext,
  ): void {
    settings = { ...settings, [key]: value };
    notify(ctx, value === "auto" ? `${key} set to auto (provider default).` : `${key} pinned to ${value} (${allowedLabel}).`, "info");
    updateStatus(ctx);
  }

  function report(ctx: ExtensionContext): void {
    const model = ctx.model;
    const features = featuresFor(model?.id ?? "");
    const lines: string[] = [];
    if (!model) {
      lines.push("No model selected.");
    } else if (!features) {
      lines.push(`${model.id}: not a gated OpenAI model; pi-gpt-5 stays passive.`);
    } else {
      lines.push(`${model.id}:`);
      lines.push(`  proMode: ${features.proMode ? "yes" : "no"} (toggle: ${settings.proMode ? "on" : "off"})`);
      lines.push(`  persistedReasoning: ${features.persistedReasoning ? "yes" : "no"} (pin: ${settings.reasoningContext})`);
      lines.push(`  verbosity: ${features.verbosity ? "yes" : "no"} (pin: ${settings.verbosity})`);
      lines.push(`  originalImageDetail: ${features.originalImageDetail ? "yes" : "no"} (pin: ${settings.imageDetail})`);
      lines.push(`  efforts: ${features.efforts.join(" ")}`);
      lines.push(`  PTC / multi-agent: ${features.programmaticToolCalling ? "gated, planned" : "no"} / ${features.multiAgent ? "gated, planned" : "no"}`);
    }
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    else console.log(lines.join("\n"));
  }

  pi.registerCommand("gpt5", {
    description: "Show or set GPT-5.x feature gates (/gpt5 [pro|context|verbosity|detail])",
    handler: async (args, ctx) => {
      const [sub, value] = args.trim().split(/\s+/);
      if (!sub || sub === "status") return report(ctx);

      if (sub === "pro") return setProMode(ctx);

      if (sub === "context") {
        if (!value || !CONTEXT_VALUES.includes(value as ReasoningContextPin)) {
          return notify(ctx, `Usage: /gpt5 context [${CONTEXT_VALUES.join("|")}]`, "warning");
        }
        return setPinned("reasoningContext", value as ReasoningContextPin, "GPT-5.6 only", ctx);
      }

      if (sub === "verbosity") {
        if (!value || !VERBOSITY_VALUES.includes(value as VerbosityPin)) {
          return notify(ctx, `Usage: /gpt5 verbosity [${VERBOSITY_VALUES.join("|")}]`, "warning");
        }
        return setPinned("verbosity", value as VerbosityPin, "catalog-advertised models", ctx);
      }

      if (sub === "detail") {
        if (!value || !DETAIL_VALUES.includes(value as ImageDetailPin)) {
          return notify(ctx, `Usage: /gpt5 detail [${DETAIL_VALUES.join("|")}]`, "warning");
        }
        return setPinned("imageDetail", value as ImageDetailPin, "original clamps to high off GPT-5.6", ctx);
      }

      notify(ctx, "Usage: /gpt5 [status|pro|context|verbosity|detail]", "warning");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    return applyCorePack(event.payload, settings, gateFor(ctx));
  });

  pi.on("session_start", async (_event, ctx) => {
    settings = { ...DEFAULT_SETTINGS };
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
