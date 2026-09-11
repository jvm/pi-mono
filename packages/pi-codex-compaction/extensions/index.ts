import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { BETA_FEATURE, getCodexAccountFingerprint } from "../src/codex-wire.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import {
  applyRemoteCompactionMarker,
  COMPACTION_FALLBACK_ENTRY,
  type CompactionFallback,
  createRemoteCompaction,
  findActiveRemoteCompaction,
  getCodexAuthKind,
  isRemoteCompactionCompatible,
  supportsRemoteCompaction,
} from "../src/remote-compaction.js";

const FALLBACK_MESSAGES: Record<CompactionFallback["reason"], string> = {
  "custom-instructions": "custom compaction instructions require the standard compactor",
  "auth-unavailable": "Codex authentication is unavailable",
  "request-unavailable": "the Codex request could not be prepared",
  "context-window-unavailable": "the active model's context limit is unavailable",
  "context-limit": "the estimated input exceeds the active model's token budget",
  "request-size-limit": "the request exceeds the 16 MiB byte limit",
  "remote-failed": "the remote request failed",
};

export default function piCodexCompaction(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  const onBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent, { compaction?: NonNullable<Awaited<ReturnType<typeof createRemoteCompaction>>> }> = async (event, ctx) => {
    if (!supportsRemoteCompaction(ctx.model)) return undefined;

    let reported = false;
    const reportFallback = (diagnostic: CompactionFallback) => {
      if (reported || event.signal.aborted) return;
      reported = true;
      // No text, model/account identifiers, headers, or provider errors belong
      // in diagnostics. Custom entries do not enter the model's context.
      const data: Record<string, unknown> = { version: 1, reason: diagnostic.reason };
      for (const key of ["estimatedTokens", "tokenBudget", "requestBytes", "byteLimit", "trimmedToolOutputs"] as const) {
        const value = diagnostic[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) data[key] = value;
      }
      try {
        pi.appendEntry(COMPACTION_FALLBACK_ENTRY, data);
      } catch {
        // Diagnostics must not prevent the standard compactor from running.
      }
      if (ctx.mode === "tui" && ctx.hasUI) {
        try {
          ctx.ui.notify(`Codex remote compaction skipped: ${FALLBACK_MESSAGES[diagnostic.reason]}. Using standard Pi compaction.`, "warning");
        } catch {
          // Notification failure must not change compaction behavior either.
        }
      }
    };
    try {
      const compaction = await createRemoteCompaction(event, ctx, () => {
        const active = new Set(pi.getActiveTools());
        const data = {
          model: ctx.model,
          tools: pi.getAllTools().filter((tool) => active.has(tool.name)),
        };
        // Pi's public ToolInfo omits constrainedSampling. Tool owners can supply
        // it here without exposing executors or inspecting private registries.
        pi.events?.emit("pi-codex-compaction:tools:v1", data);
        return data.tools;
      }, pi.getThinkingLevel?.(), (payload, messages) => {
        const data = { payload, messages, ctx };
        // Synchronous bus contract: apply pure request transforms before bounds
        // and before network I/O. Never include auth in this event.
        pi.events?.emit("pi-codex-compaction:request:v1", data);
        return data.payload;
      }, reportFallback);
      return compaction ? { compaction } : undefined;
    } catch {
      // Transport failures already have a reason; other exceptions mean the
      // compaction request could not be prepared or processed.
      reportFallback({ reason: "request-unavailable" });
      return undefined;
    }
  };
  pi.on("session_before_compact", onBeforeCompact);

  pi.on("before_provider_headers", (event, ctx) => {
    if (!supportsRemoteCompaction(ctx.model)) return;
    const existing = event.headers["x-codex-beta-features"];
    const features = existing?.split(",").map((feature) => feature.trim()).filter(Boolean) ?? [];
    if (!features.includes(BETA_FEATURE)) features.push(BETA_FEATURE);
    event.headers["x-codex-beta-features"] = features.join(",");
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!supportsRemoteCompaction(ctx.model)) return;
    const details = findActiveRemoteCompaction(ctx.sessionManager.buildContextEntries());
    if (!details) return;

    return (async () => {
      const model = ctx.model;
      if (!model) return undefined;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return undefined;

      let accountFingerprint: string;
      try {
        accountFingerprint = getCodexAccountFingerprint(auth.apiKey);
      } catch {
        return undefined;
      }
      if (!isRemoteCompactionCompatible(details, model, accountFingerprint, getCodexAuthKind(ctx.modelRegistry, model))) {
        return undefined;
      }
      return applyRemoteCompactionMarker(event.payload, details);
    })();
  });
}
