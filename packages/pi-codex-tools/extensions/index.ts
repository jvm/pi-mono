import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { applyPatch, APPLY_PATCH_GRAMMAR, MAX_PATCH_BYTES, secureFilesystemSupported } from "../src/apply-patch.js";
import { createFreeformInputSchema, createOpenAILarkSampling, type OpenAIGrammarSampling } from "../src/grammar.js";
import { supportsOpenAIGrammarTools } from "../src/model-support.js";
import { formatApplyPatchCallText, formatApplyPatchResultText } from "../src/patch-preview.js";

class ApplyPatchCallComponent extends Text {
  cache?: { key: string; text: string };
  constructor() {
    super("", 0, 0);
  }
}

function readPatchArg(args: unknown): string {
  return typeof (args as { patch?: unknown })?.patch === "string" ? (args as { patch: string }).patch : "";
}

const APPLY_PATCH = "apply_patch";
const EDIT = "edit";
const WRITE = "write";
const REPLACED_TOOLS = [EDIT, WRITE] as const;
type ReplacedTool = (typeof REPLACED_TOOLS)[number];

const APPLY_PATCH_PARAMETERS = createFreeformInputSchema(
  "patch",
  "Raw Codex apply_patch text. Do not wrap it in JSON.",
);

export default function piCodexTools(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  const registerGrammarTool = pi.registerTool as (tool: Parameters<ExtensionAPI["registerTool"]>[0] & {
    constrainedSampling?: OpenAIGrammarSampling;
  }) => void;

  registerGrammarTool({
    name: APPLY_PATCH,
    label: APPLY_PATCH,
    description: "Apply a Codex patch to files. This is a FREEFORM tool: send the patch text directly, never as JSON.",
    promptSnippet: "Apply Codex-format file patches without JSON wrapping",
    promptGuidelines: [
      "Use apply_patch for file changes when it is available.",
      "Send the patch body directly; do not wrap it in JSON or add a shell heredoc.",
      `Patch paths must stay inside the current working directory and patches are limited to ${MAX_PATCH_BYTES} bytes.`,
    ],
    parameters: APPLY_PATCH_PARAMETERS,
    constrainedSampling: createOpenAILarkSampling(APPLY_PATCH_GRAMMAR),
    executionMode: "sequential",
    renderCall(args, theme, context) {
      const component =
        context.lastComponent instanceof ApplyPatchCallComponent ? context.lastComponent : new ApplyPatchCallComponent();
      const rawPatch = readPatchArg(args);
      const key = `${context.expanded ? "1" : "0"}:${rawPatch}`;
      if (!component.cache || component.cache.key !== key) {
        component.cache = {
          key,
          text: formatApplyPatchCallText(rawPatch, theme, { expanded: context.expanded }),
        };
      }
      component.setText(component.cache.text);
      return component as Component;
    },
    renderResult(result, _options, theme, context) {
      const text = formatApplyPatchResultText(result, theme, context.isError);
      if (!text) {
        const component = (context.lastComponent ?? new Container()) as Container;
        component.clear();
        return component as Component;
      }
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(text);
      return component as Component;
    },
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (!supportsOpenAIGrammarTools(ctx.model)) {
        throw new Error("apply_patch is only available for OpenAI models that advertise grammar-tool support.");
      }
      const patch = (rawParams as { patch?: unknown }).patch;
      if (typeof patch !== "string") throw new Error("apply_patch requires raw patch text.");
      const result = await applyPatch(patch, { cwd: ctx.cwd, signal });
      const summary = result.changes
        .map((change) => `${change.kind[0].toUpperCase()}${change.kind.slice(1)} ${change.path}${change.moveTo ? ` -> ${change.moveTo}` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text: `Applied patch:\n${summary}` }], details: result };
    },
  });

  let replacedToolsWasActive: Record<ReplacedTool, boolean> | undefined;

  function synchronizeTools(ctx: ExtensionContext): void {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;

    const active = new Set(pi.getActiveTools());
    if (supportsOpenAIGrammarTools(ctx.model) && secureFilesystemSupported()) {
      if (replacedToolsWasActive === undefined) {
        replacedToolsWasActive = {
          edit: active.has(EDIT),
          write: active.has(WRITE),
        };
      }
      for (const tool of REPLACED_TOOLS) active.delete(tool);
      active.add(APPLY_PATCH);
    } else {
      active.delete(APPLY_PATCH);
      if (replacedToolsWasActive) {
        for (const tool of REPLACED_TOOLS) {
          if (replacedToolsWasActive[tool]) active.add(tool);
        }
      }
      replacedToolsWasActive = undefined;
    }
    pi.setActiveTools([...active]);
  }

  pi.on("session_start", (_event, ctx) => {
    synchronizeTools(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    synchronizeTools(ctx);
  });
}
