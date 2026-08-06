import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { BETA_FEATURE, getCodexAccountFingerprint } from "../src/codex-wire.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import {
  applyRemoteCompactionMarker,
  createRemoteCompaction,
  findActiveRemoteCompaction,
  getCodexAuthKind,
  isRemoteCompactionCompatible,
  supportsRemoteCompaction,
} from "../src/remote-compaction.js";

export default function piCodexCompaction(pi: ExtensionAPI): void {
  reportInstallTelemetry();

  const onBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent, { compaction?: NonNullable<Awaited<ReturnType<typeof createRemoteCompaction>>> }> = async (event, ctx) => {
    if (!supportsRemoteCompaction(ctx.model)) return undefined;

    try {
      const compaction = await createRemoteCompaction(event, ctx, () => {
        const active = new Set(pi.getActiveTools());
        return pi.getAllTools()
          .filter((tool) => active.has(tool.name))
          .map(({ name, description, parameters }) => ({ name, description, parameters }));
      }, pi.getThinkingLevel?.());
      return compaction ? { compaction } : undefined;
    } catch {
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify("Codex remote compaction failed; using standard Pi compaction.", "warning");
      }
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
