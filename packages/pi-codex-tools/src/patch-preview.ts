// Streaming preview rendering for the apply_patch tool.
//
// The strict parser in apply-patch.ts rejects incomplete input, but the patch arrives as a
// growing prefix while the model generates it. This module scans that partial text tolerantly
// (it never throws) to drive a live, write-style glimpse of the content plus a running
// added/removed tally. It reuses Pi's shared `renderDiff` primitive for +/- coloring, so the
// preview stays consistent with the built-in `edit` tool's diff preview.
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";

const FILE_ADD = "*** Add File: ";
const FILE_DELETE = "*** Delete File: ";
const FILE_UPDATE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";

/**
 * Preview bounds. The patch itself is capped at apply time (1 MiB / 1000 hunks), but the TUI
 * re-renders on every streaming token, so the preview scanner bails earlier to keep the UI
 * responsive and its retained output bounded (see AGENTS.md: "bound tool output").
 */
const PREVIEW_LINES_COLLAPSED = 10;
const PREVIEW_LINES_EXPANDED = 500;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_FILES = 500;
/** Cap a single rendered glimpse line so minified/generated content cannot flood the TUI. */
const PREVIEW_LINE_CHARS = 200;

export type PatchLineType = "add" | "del" | "ctx";

export interface PatchPreviewLine {
  type: PatchLineType;
  text: string;
}

export interface PatchPreviewFile {
  kind: "add" | "update" | "delete";
  path: string;
  /** Destination for an update that carries `*** Move to:`; execution writes this path and deletes `path`. */
  moveTo?: string;
  /** Diff lines for the file. Empty for deletes (the patch carries no content for them). */
  lines: PatchPreviewLine[];
}

export interface PatchPreview {
  files: PatchPreviewFile[];
  totalAdded: number;
  totalRemoved: number;
  /** True when the preview stopped early because the patch exceeded a preview bound. */
  truncated: boolean;
}

/**
 * Tolerantly scan a (possibly incomplete) apply_patch body into a preview.
 *
 * The grammar is line-oriented, so a partial buffer is always a prefix of valid lines. We walk
 * every line and accumulate per-file diff lines and running counts; malformed/unknown lines are
 * ignored rather than thrown on. Each call re-scans the current buffer from scratch, so there is
 * no accumulation drift across streaming deltas.
 */
export function scanPatchPreview(input: string): PatchPreview {
  // Bound per-render work: cap the bytes we split and walk so a large patch (up to 1 MiB at apply
  // time) cannot make streaming re-renders quadratic. Anything past the cap is reported truncated.
  const capped = input.length > MAX_PREVIEW_BYTES + 1 ? input.slice(0, MAX_PREVIEW_BYTES + 1) : input;
  const lines = capped.split("\n");

  const filesByPath = new Map<string, PatchPreviewFile>();
  const files: PatchPreviewFile[] = []; // first-seen order
  let totalAdded = 0;
  let totalRemoved = 0;
  let current: PatchPreviewFile | undefined;
  let truncated = input.length > capped.length;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // The terminator ends the patch; trailing text must not change totals or the active file.
    if (line === END_PATCH) break;
    if (line === "" || line === BEGIN_PATCH || line === END_OF_FILE) continue;

    if (line.startsWith(MOVE_TO)) {
      // A move renames the current update's file; preserve the destination so the preview can
      // show the source -> destination transition (execution deletes source, writes destination).
      if (current) current.moveTo = line.slice(MOVE_TO.length).trim();
      continue;
    }

    if (line.startsWith(FILE_ADD) || line.startsWith(FILE_DELETE) || line.startsWith(FILE_UPDATE)) {
      const kind: PatchPreviewFile["kind"] = line.startsWith(FILE_ADD)
        ? "add"
        : line.startsWith(FILE_DELETE)
          ? "delete"
          : "update";
      const prefix = kind === "add" ? FILE_ADD : kind === "delete" ? FILE_DELETE : FILE_UPDATE;
      const path = line.slice(prefix.length);
      const existing = filesByPath.get(path);
      if (existing) {
        // Execution coalesces multiple hunks for the same path; the preview must too, otherwise
        // the roster shows duplicate rows and an inflated file count.
        current = existing;
        continue;
      }
      if (files.length >= MAX_PREVIEW_FILES) {
        truncated = true;
        break;
      }
      current = { kind, path, lines: [] };
      filesByPath.set(path, current);
      files.push(current);
      continue;
    }

    // Lines before the first file header (or inside a delete) carry no preview content.
    if (!current || current.kind === "delete") continue;

    if (line === "@@" || line.startsWith("@@ ")) continue; // chunk context marker

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1) });
      totalAdded++;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", text: line.slice(1) });
      totalRemoved++;
    } else {
      // Context line (" text") or a bare "" inside a chunk.
      current.lines.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }

  return { files, totalAdded, totalRemoved, truncated };
}

function fileStatusMark(file: PatchPreviewFile): string {
  switch (file.kind) {
    case "add":
      return "A";
    case "delete":
      return "D";
    default:
      return "M";
  }
}

function fileCountsLabel(file: PatchPreviewFile, theme: Theme): string {
  if (file.kind === "delete") return "";
  const added = theme.fg("toolDiffAdded", `+${countLines(file, "add")}`);
  const removed = file.kind === "update" ? ` ${theme.fg("toolDiffRemoved", `-${countLines(file, "del")}`)}` : "";
  return `${added}${removed}`;
}

function fileMarkLabel(file: PatchPreviewFile, theme: Theme): string {
  const mark = file.kind === "add" ? "toolDiffAdded" : file.kind === "delete" ? "toolDiffRemoved" : "warning";
  return theme.fg(mark, fileStatusMark(file));
}

function filePathLabel(file: PatchPreviewFile, theme: Theme): string {
  const path = theme.fg("accent", truncatePath(file.path));
  return file.moveTo ? `${path} ${theme.fg("muted", "->")} ${theme.fg("accent", truncatePath(file.moveTo))}` : path;
}

function formatFileRosterLine(file: PatchPreviewFile, theme: Theme): string {
  const counts = fileCountsLabel(file, theme);
  return `${fileMarkLabel(file, theme)} ${filePathLabel(file, theme)}${counts ? ` ${counts}` : ""}`;
}

function countLines(file: PatchPreviewFile, type: PatchLineType): number {
  let n = 0;
  for (const line of file.lines) if (line.type === type) n++;
  return n;
}

/**
 * Render one glimpse line directly. apply_patch has no real line numbers (only `@@` anchors), so
 * we color +/- lines without fabricating numbers, and cap each line's width.
 */
function renderGlimpseLine(line: PatchPreviewLine, theme: Theme): string {
  const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  const body = line.text.length > PREVIEW_LINE_CHARS ? `${line.text.slice(0, PREVIEW_LINE_CHARS)}…` : line.text;
  const styled = `${sign}${body}`;
  if (line.type === "add") return theme.fg("toolDiffAdded", styled);
  if (line.type === "del") return theme.fg("toolDiffRemoved", styled);
  return theme.fg("toolDiffContext", styled);
}

function focusFile(files: PatchPreviewFile[]): PatchPreviewFile | undefined {
  // Prefer the most recent file that has visible content to glimpse; fall back to the last file.
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index];
    if (file.kind !== "delete" && file.lines.length > 0) return file;
  }
  return files.at(-1);
}

/** Cap a rendered path: keep the tail (filename/extension) since that is the meaningful part. */
function truncatePath(path: string): string {
  return path.length > PREVIEW_LINE_CHARS ? `…${path.slice(path.length - PREVIEW_LINE_CHARS + 1)}` : path;
}

/** Format the live apply_patch tool-call text (streaming glimpse + tally). */
export function formatApplyPatchCallText(rawPatch: string, theme: Theme, options: { expanded: boolean }): string {
  const preview = scanPatchPreview(rawPatch);
  const title = theme.fg("toolTitle", theme.bold("apply_patch"));
  if (preview.files.length === 0) return title;

  let text: string;
  if (preview.files.length === 1) {
    // Single file: lead with the status mark + path (like the built-in `write` tool, with the
    // file's A/M/D status so a delete is distinguishable from an empty in-progress update).
    const file = preview.files[0];
    const counts = fileCountsLabel(file, theme);
    text = `${title} ${fileMarkLabel(file, theme)} ${filePathLabel(file, theme)}${counts ? ` ${counts}` : ""}`;
  } else {
    const tally = `${theme.fg("toolDiffAdded", `+${preview.totalAdded}`)} ${theme.fg("toolDiffRemoved", `-${preview.totalRemoved}`)} ${theme.fg("muted", `· ${preview.files.length} files`)}`;
    // Cap the collapsed roster so a multi-hundred-file patch cannot re-render hundreds of lines
    // every token; expansion reveals the rest (up to the preview file cap).
    const maxRoster = options.expanded ? preview.files.length : PREVIEW_LINES_COLLAPSED;
    const visible = preview.files.slice(0, maxRoster);
    let roster = visible.map((file) => formatFileRosterLine(file, theme)).join("\n");
    const hidden = preview.files.length - visible.length;
    if (hidden > 0) roster += `\n${theme.fg("muted", `… ${hidden} more files`)}`;
    text = `${title}  ${tally}\n${roster}`;
  }

  const focus = focusFile(preview.files);
  if (focus && focus.kind !== "delete" && focus.lines.length > 0) {
    // Even expanded, cap rendered output so a huge file cannot stall the terminal.
    const maxLines = options.expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
    const visible = focus.lines.slice(0, maxLines);
    const remaining = focus.lines.length - maxLines;
    let body = visible.map((line) => renderGlimpseLine(line, theme)).join("\n");
    if (remaining > 0) {
      body += theme.fg(
        "muted",
        `\n... (${remaining} more lines, ${focus.lines.length} total, ${keyHint("app.tools.expand", "to expand")})`,
      );
    }
    // In multi-file previews the focused file may be hidden behind the capped roster, so label the
    // glimpse with its own row (the single-file header already carries the path).
    const label = preview.files.length > 1 ? `${formatFileRosterLine(focus, theme)}\n` : "";
    text += `\n\n${label}${body}`;
  }

  if (preview.truncated) {
    text += `\n${theme.fg("muted", "(large patch; preview truncated)")}`;
  }
  return text;
}

/**
 * Format the apply_patch tool-result text. On success the streaming glimpse already conveys the
 * change, so nothing is added (mirrors the built-in `write` tool). On error the message is shown.
 */
export function formatApplyPatchResultText(
  result: { content: Array<{ type: string; text?: string }> },
  theme: Theme,
  isError: boolean,
): string | undefined {
  if (!isError) return undefined;
  const output = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return output ? theme.fg("error", output) : undefined;
}
