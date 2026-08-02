import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import {
  applyRemoteCompactionMarker,
  createRemoteCompaction,
  findActiveRemoteCompaction,
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
      });
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
    event.headers["x-codex-beta-features"] = existing && existing !== "remote_compaction_v2"
      ? `${existing},remote_compaction_v2`
      : "remote_compaction_v2";
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!supportsRemoteCompaction(ctx.model)) return;
    const details = findActiveRemoteCompaction(ctx.sessionManager.buildContextEntries());
    if (!details) return;
    return applyRemoteCompactionMarker(event.payload, details);
  });
}
