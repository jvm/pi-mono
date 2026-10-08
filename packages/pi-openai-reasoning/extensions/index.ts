import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { rewriteReasoning, STATE_TYPE, supportsReasoningUpdates } from "../src/reasoning.js";

export default function piOpenaiReasoning(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  function rewrite(payload: unknown, ctx: ExtensionContext): unknown {
    if (!ctx.model || !supportsReasoningUpdates(ctx.model) || !ctx.modelRegistry.isUsingOAuth(ctx.model)) return;
    const result = rewriteReasoning(payload, ctx.model, ctx.sessionManager.getBranch());
    if (!result) return;
    if (result.state) pi.appendEntry(STATE_TYPE, result.state);
    return result.payload;
  }

  pi.on("before_provider_request", (event, ctx) => rewrite(event.payload, ctx));
}
