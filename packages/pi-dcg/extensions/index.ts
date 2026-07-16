import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadDcgBridgeConfig, type DcgBridgeConfig } from "../src/config.js";
import {
  DcgClient,
  DcgProcessError,
  isRecommendedDcgVersion,
  MINIMUM_RECOMMENDED_DCG_VERSION,
  type DcgClientLike,
} from "../src/dcg-client.js";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { formatDcgDecision } from "../src/protocol.js";

const STATUS_KEY = "pi-dcg";
const MAX_COMMAND_PREVIEW_CHARS = 4_000;

type GuardOutcome = { block: false } | { block: true; reason: string };
type Health = "active" | "degraded" | "unknown";

export interface PiDcgDependencies {
  client?: DcgClientLike;
  config?: DcgBridgeConfig;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof DcgProcessError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "dcg failed for an unknown reason";
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
    // UI failures must never alter a dcg decision.
  }
}

function setStatus(
  ctx: ExtensionContext,
  health: Health,
  config: DcgBridgeConfig,
  version?: string,
): void {
  if (!ctx.hasUI) return;
  try {
    if (health === "active") {
      const label = version ? `dcg ${version}` : "dcg active";
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", `shield ${label}`));
      return;
    }
    if (health === "degraded") {
      const behavior = config.onError === "block" ? "blocking" : "fail-open";
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `shield dcg unavailable (${behavior})`));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "shield dcg checking"));
  } catch {
    // Status rendering is advisory and must never alter a dcg decision.
  }
}

function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch {
    // The session is already shutting down.
  }
}

export default function piDcg(
  pi: ExtensionAPI,
  dependencies: PiDcgDependencies = {},
): void {
  reportInstallTelemetry();

  const config = dependencies.config ?? loadDcgBridgeConfig();
  const client = dependencies.client ?? new DcgClient(config);
  let version: string | undefined;
  let lastNotifiedError: string | undefined;
  let warnedAboutVersion = false;

  const markHealthy = (ctx: ExtensionContext, detectedVersion = version): void => {
    version = detectedVersion;
    lastNotifiedError = undefined;
    setStatus(ctx, "active", config, version);
  };

  const markDegraded = (ctx: ExtensionContext, error: unknown): void => {
    const message = errorMessage(error);
    setStatus(ctx, "degraded", config, version);
    if (ctx.hasUI && message !== lastNotifiedError) {
      lastNotifiedError = message;
      const behavior = config.onError === "block" ? "Commands will be blocked." : "Commands will be allowed (fail-open).";
      notify(ctx, `pi-dcg: ${message} ${behavior}`, "warning");
    }
  };

  const guard = async (
    command: string,
    cwd: string,
    ctx: ExtensionContext,
  ): Promise<GuardOutcome> => {
    if (!command.trim()) return { block: false };

    let result;
    try {
      result = await client.check(command, cwd, ctx.signal);
      markHealthy(ctx);
    } catch (error) {
      if (error instanceof DcgProcessError && error.code === "aborted") {
        return { block: true, reason: "dcg check was cancelled; the command was not run." };
      }
      markDegraded(ctx, error);
      if (config.onError === "block") {
        return {
          block: true,
          reason: `dcg could not evaluate this command: ${errorMessage(error)} Blocking because PI_DCG_ON_ERROR=block.`,
        };
      }
      return { block: false };
    }

    if (result.decision === "allow") return { block: false };
    const reason = formatDcgDecision(result);
    if (result.decision === "deny") return { block: true, reason };

    if (!ctx.hasUI) {
      return { block: true, reason: `${reason}\n\nNo interactive UI is available to confirm this warning.` };
    }

    let approved = false;
    try {
      approved = await ctx.ui.confirm(
        "dcg requires confirmation",
        `Command:\n${truncate(command, MAX_COMMAND_PREVIEW_CHARS)}\n\n${reason}`,
      );
    } catch {
      return { block: true, reason: `${reason}\n\nThe confirmation dialog failed, so the command was blocked.` };
    }
    return approved ? { block: false } : { block: true, reason: `${reason}\n\nThe command was not approved.` };
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    setStatus(ctx, "unknown", config);
    try {
      const probe = await client.probe(ctx.cwd);
      markHealthy(ctx, probe.version);
      if (!isRecommendedDcgVersion(probe.version) && !warnedAboutVersion) {
        warnedAboutVersion = true;
        notify(
          ctx,
          `pi-dcg: found dcg ${probe.version}; dcg ${MINIMUM_RECOMMENDED_DCG_VERSION} or newer is recommended.`,
          "warning",
        );
      }
    } catch (error) {
      markDegraded(ctx, error);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const outcome = await guard(event.input.command, ctx.cwd, ctx);
    return outcome.block ? { block: true, reason: outcome.reason } : undefined;
  });

  if (config.guardUserBash) {
    pi.on("user_bash", async (event, ctx) => {
      const outcome = await guard(event.command, event.cwd, ctx);
      if (!outcome.block) return undefined;
      return {
        result: {
          output: outcome.reason,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    });
  }

  pi.registerCommand("dcg", {
    description: "Show pi-dcg status and configuration",
    handler: async (args, ctx) => {
      if (args.trim()) {
        notify(ctx, "Usage: /dcg", "warning");
        return;
      }
      try {
        const probe = await client.probe(ctx.cwd);
        markHealthy(ctx, probe.version);
        const coverage = config.guardUserBash
          ? "agent bash and user !/!! commands (RPC bash excluded)"
          : "agent bash commands";
        notify(
          ctx,
          `pi-dcg is active\nBinary: ${config.binary}\nVersion: ${probe.version}\nCoverage: ${coverage}\nBridge errors: ${config.onError}`,
          "info",
        );
      } catch (error) {
        markDegraded(ctx, error);
      }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatus(ctx);
  });
}
