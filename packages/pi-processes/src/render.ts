import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { commandPreview } from "./display-text.js";
import type { ProcessResult } from "./runtime.js";

export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/** Output cannot execute terminal escapes or use bidi controls to disguise text. */
export function displayText(text: string): string {
  return clean(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(/[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function statusText(data: ProcessResult): string {
  return data.status === "running" ? "running"
    : data.timed_out ? "timed out"
    : data.stopped ? "stopped"
    : data.signal ? `failed · ${data.signal}`
    : data.exit_code === 0 ? "done" : `exit ${data.exit_code ?? "unknown"}`;
}

/** Fixed line budget, including wrapped/very long lines, rather than a giant Text box. */
export class ProcessOutput implements Component {
  constructor(private readonly text: string, private readonly expanded: boolean) {}
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const lines = displayText(this.text).split(/\r?\n/);
    while (lines.length && !lines.at(-1)) lines.pop();
    const limit = this.expanded ? 40 : 4;
    const visible = lines.slice(0, limit).map(line => truncateToWidth(line, width));
    if (lines.length > limit) visible.push(truncateToWidth(
      `… ${lines.length - limit} more lines · ${this.expanded ? "use process_output or /processes" : "expand to view"}`, width));
    return visible;
  }
}

export function renderCall(input: object, theme: Theme): Component {
  const args = input as Record<string, unknown>;
  const title = typeof args.title === "string" ? args.title
    : typeof args.command === "string" ? args.command
    : args.chars ? "Send approved input" : args.session_ids ? "Wait for processes" : "Read process output";
  const id = typeof args.session_id === "string" ? ` · ${args.session_id.slice(0, 8)}` : "";
  return {
    invalidate() {},
    render: width => width <= 0 ? [] : [
      truncateToWidth(theme.fg("toolTitle", commandPreview(title)) + theme.fg("muted", id), width),
    ],
  };
}

export function renderResult(
  result: AgentToolResult<unknown>, options: { expanded: boolean; isPartial: boolean }, theme: Theme,
): Component {
  const details = result.details as ProcessResult | { processes?: ProcessResult[]; wait_status?: string } | undefined;
  if (details && "status" in details && typeof details.session_id === "string") {
    const color = details.status === "running" ? "muted" : details.exit_code === 0 ? "success" : "warning";
    const heading = theme.fg(color, displayText(statusText(details)).replace(/\n/g, " ").slice(0, 80))
      + theme.fg("muted", ` · ${commandPreview(details.session_id.slice(0, 8))}`
        + (details.dropped_bytes ? ` · ${details.dropped_bytes} bytes omitted` : "")
        + (details.unread_bytes ? ` · ${details.unread_bytes} bytes remaining` : ""));
    const output = new ProcessOutput(details.output ?? "", options.expanded);
    return { invalidate() {}, render: width => [truncateToWidth(heading, width), ...output.render(width)] };
  }
  if (details && "processes" in details && details.processes) {
    const lines = details.processes.map(p => `${p.title ?? p.session_id.slice(0, 8)} · ${statusText(p)}`);
    const output = details.processes.map(p => p.output ?? "").filter(Boolean).join("\n");
    return new ProcessOutput([...lines, output].join("\n"), options.expanded);
  }
  return new ProcessOutput(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), options.expanded);
}
