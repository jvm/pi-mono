import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { rewriteReasoning, STATE_TYPE, supportsReasoningUpdates } from "../src/reasoning.js";

export default function piOpenaiReasoning(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  function rewrite(payload: unknown, ctx: ExtensionContext, compacting = false): unknown {
    if (!ctx.model || !supportsReasoningUpdates(ctx.model) || !ctx.modelRegistry.isUsingOAuth(ctx.model)) return;
    const result = rewriteReasoning(payload, ctx.model, ctx.sessionManager.getBranch(), compacting);
    if (!result) return;
    if (result.state) pi.appendEntry(STATE_TYPE, result.state);
    return result.payload;
  }

  pi.on("before_provider_request", (event, ctx) => rewrite(event.payload, ctx));
  pi.events.on("pi-codex-compaction:request:v1", (value) => {
    const data = value as { payload: unknown; ctx?: ExtensionContext } | undefined;
    if (!data?.ctx) return;
    const result = rewrite(data.payload, data.ctx, true);
    if (result !== undefined) data.payload = result;
  });
}
