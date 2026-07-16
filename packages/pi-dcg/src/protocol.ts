const MAX_REASON_CHARS = 12_000;
const MAX_FIELD_CHARS = 8_000;

interface DcgRemediation {
  safeAlternative?: string;
  explanation?: string;
  allowOnceCommand?: string;
}

interface DcgHookOutput {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  allowOnceCode?: string;
  allowOnceFullHash?: string;
  ruleId?: string;
  packId?: string;
  severity?: string;
  confidence?: number;
  remediation?: DcgRemediation;
}

export type DcgDecision =
  | { decision: "allow" }
  | { decision: "deny" | "ask"; hook: DcgHookOutput };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRemediation(value: unknown): DcgRemediation | undefined {
  if (!isRecord(value)) return undefined;
  const remediation = {
    safeAlternative: optionalString(value.safeAlternative),
    explanation: optionalString(value.explanation),
    allowOnceCommand: optionalString(value.allowOnceCommand),
  };
  return Object.values(remediation).some((field) => field !== undefined) ? remediation : undefined;
}

export function parseDcgHookResponse(stdout: string): DcgDecision {
  const trimmed = stdout.trim().replace(/^\uFEFF/, "");
  if (trimmed === "") return { decision: "allow" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("dcg returned malformed JSON");
  }

  if (!isRecord(parsed) || !isRecord(parsed.hookSpecificOutput)) {
    throw new Error("dcg returned an unsupported hook response");
  }

  const raw = parsed.hookSpecificOutput;
  const permissionDecision = raw.permissionDecision;
  if (permissionDecision !== "allow" && permissionDecision !== "deny" && permissionDecision !== "ask") {
    throw new Error("dcg hook response has an unknown permission decision");
  }
  if (permissionDecision === "allow") return { decision: "allow" };

  return {
    decision: permissionDecision,
    hook: {
      permissionDecision,
      permissionDecisionReason: optionalString(raw.permissionDecisionReason),
      allowOnceCode: optionalString(raw.allowOnceCode),
      allowOnceFullHash: optionalString(raw.allowOnceFullHash),
      ruleId: optionalString(raw.ruleId),
      packId: optionalString(raw.packId),
      severity: optionalString(raw.severity),
      confidence: optionalNumber(raw.confidence),
      remediation: parseRemediation(raw.remediation),
    },
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function extractReason(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const match = message.match(/(?:^|\n)Reason:\s*([^\n]*(?:\n(?!\s*(?:Explanation|Rule|Pack|Command):)[^\n]*)*)/i);
  const reason = match?.[1]?.trim();
  return reason || truncate(message.trim(), MAX_FIELD_CHARS);
}

function metadata(hook: DcgHookOutput): string | undefined {
  const fields = [hook.severity, hook.ruleId ?? hook.packId].filter(Boolean);
  if (hook.confidence !== undefined) fields.push(`confidence ${hook.confidence.toFixed(2)}`);
  return fields.length > 0 ? fields.join(" · ") : undefined;
}

export function formatDcgDecision(result: Exclude<DcgDecision, { decision: "allow" }>): string {
  const { hook } = result;
  const lines = [result.decision === "deny" ? "Blocked by dcg." : "dcg requires confirmation."];
  const meta = metadata(hook);
  if (meta) lines.push(meta);

  const reason = extractReason(hook.permissionDecisionReason);
  if (reason) lines.push(`Reason: ${truncate(reason, MAX_FIELD_CHARS)}`);

  const explanation = hook.remediation?.explanation?.trim();
  if (explanation && explanation !== reason) {
    lines.push(`Details: ${truncate(explanation, MAX_FIELD_CHARS)}`);
  }

  const alternative = hook.remediation?.safeAlternative?.trim();
  if (alternative) lines.push(`Safer alternative: ${truncate(alternative, MAX_FIELD_CHARS)}`);

  const allowOnce = hook.remediation?.allowOnceCommand
    ?? (hook.allowOnceCode ? `dcg allow-once ${hook.allowOnceCode}` : undefined);
  if (allowOnce) lines.push(`To authorize this exact command: ${allowOnce}`);

  return truncate(lines.join("\n\n"), MAX_REASON_CHARS);
}
