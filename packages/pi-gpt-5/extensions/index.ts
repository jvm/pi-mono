import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { featuresFor } from "../src/features.js";

const STATUS_KEY = "pi-gpt-5";

/** Sorted feature names shown by `/gpt5`; keep in sync with `features_gate.md`. */
const FEATURE_KEYS = [
  "efforts",
  "proMode",
  "legacyProSlug",
  "persistedReasoning",
  "verbosity",
  "explicitPromptCacheMode",
  "programmaticToolCalling",
  "multiAgent",
  "originalImageDetail",
  "messagePhase",
  "grammarTools",
  "additionalTools",
  "strictSchemas",
] as const;

export default function piGpt5(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  pi.registerCommand("gpt5", {
    description: "Show which GPT-5.x features the current model supports",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      const features = featuresFor(model?.id ?? "");
      const lines: string[] = [];

      if (!model) {
        lines.push("No model selected.");
      } else if (!features) {
        lines.push(`${model.id}: not a gated OpenAI model; pi-gpt-5 stays passive.`);
      } else {
        lines.push(`${model.id}:`);
        for (const key of FEATURE_KEYS) {
          const value = features[key];
          const rendered = Array.isArray(value) ? value.join(" ") : value ? "yes" : "no";
          lines.push(`  ${key}: ${rendered}`);
        }
      }

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        console.log(lines.join("\n"));
      }
    },
  });

  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const features = featuresFor(ctx.model?.id ?? "");
    const text = features ? "GPT-5 gate: on" : "GPT-5 gate: n/a";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(features ? "success" : "muted", text));
  });
}
