// Adapted from OpenAI Codex apply-patch grammar/parser behavior; see NOTICE.
import { constants } from "node:fs";
import { lstat, readlink, realpath, open, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, parse, join, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const MAX_PATCH_BYTES = 1_048_576;
export const MAX_PATCH_HUNKS = 1_000;
export const MAX_TARGET_FILE_BYTES = 64 * 1024 * 1024;

const FILE_READ_CHUNK_BYTES = 64 * 1024;

export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

export interface UpdateChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type ApplyPatchHunk =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export interface ApplyPatchResult {
  changes: Array<{ kind: "added" | "updated" | "deleted"; path: string; moveTo?: string }>;
}

export interface ApplyPatchOptions {
  cwd: string;
  signal?: AbortSignal;
}

export function parseApplyPatch(input: string): ApplyPatchHunk[] {
  if (typeof input !== "string") throw new Error("apply_patch input must be a string.");
  if (Buffer.byteLength(input, "utf8") > MAX_PATCH_BYTES) {
    throw new Error(`apply_patch input exceeds the ${MAX_PATCH_BYTES}-byte limit.`);
  }

  const lines = input.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error("The first line of the patch must be '*** Begin Patch'.");
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    throw new Error("The last line of the patch must be '*** End Patch'.");
  }

  const hunks: ApplyPatchHunk[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "*** End Patch") break;
    if (trimmed === "") {
      throw new Error(`Unexpected blank line at patch line ${index + 1}.`);
    }

    if (trimmed.startsWith("*** Add File: ")) {
      const path = headerPath(trimmed, "*** Add File: ", index + 1);
      index++;
      const content: string[] = [];
      while (index < lines.length - 1 && !isHunkHeader(lines[index])) {
        if (!lines[index].startsWith("+")) {
          throw new Error(`Invalid add hunk at patch line ${index + 1}: every line must start with '+'.`);
        }
        content.push(lines[index].slice(1));
        index++;
      }
      if (content.length === 0) {
        throw new Error(`Add hunk for '${path}' must contain at least one line.`);
      }
      hunks.push({ kind: "add", path, content: `${content.join("\n")}\n` });
      continue;
    }

    if (trimmed.startsWith("*** Delete File: ")) {
      const path = headerPath(trimmed, "*** Delete File: ", index + 1);
      hunks.push({ kind: "delete", path });
      index++;
      continue;
    }

    if (trimmed.startsWith("*** Update File: ")) {
      const path = headerPath(trimmed, "*** Update File: ", index + 1);
      index++;
      let moveTo: string | undefined;
      if (index < lines.length - 1 && lines[index].startsWith("*** Move to: ")) {
        moveTo = headerPath(lines[index], "*** Move to: ", index + 1);
        index++;
      }

      const chunks: UpdateChunk[] = [];
      let current: UpdateChunk | undefined;
      while (index < lines.length - 1 && !isUpdateBoundary(lines[index])) {
        const raw = lines[index];
        const currentLine = raw.trimEnd();

        if (currentLine === "*** End of File") {
          if (!current || (current.oldLines.length === 0 && current.newLines.length === 0)) {
            throw new Error(`Update hunk for '${path}' has no change lines at patch line ${index + 1}.`);
          }
          current.endOfFile = true;
          index++;
          continue;
        }

        if (currentLine === "@@" || currentLine.startsWith("@@ ")) {
          if (current && current.oldLines.length === 0 && current.newLines.length === 0) {
            throw new Error(`Update hunk for '${path}' has an empty chunk at patch line ${index + 1}.`);
          }
          const context = currentLine === "@@" ? undefined : currentLine.slice(3);
          current = {
            ...(context === undefined ? {} : { context }),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };
          chunks.push(current);
          index++;
          continue;
        }

        if (current?.endOfFile && currentLine === "") {
          index++;
          continue;
        }

        current ??= { oldLines: [], newLines: [], endOfFile: false };
        if (raw === "") {
          current.oldLines.push("");
          current.newLines.push("");
        } else if (raw.startsWith(" ")) {
          const text = raw.slice(1);
          current.oldLines.push(text);
          current.newLines.push(text);
        } else if (raw.startsWith("+")) {
          current.newLines.push(raw.slice(1));
        } else if (raw.startsWith("-")) {
          current.oldLines.push(raw.slice(1));
        } else {
          throw new Error(
            `Unexpected line at patch line ${index + 1}. Every update line must start with ' ', '+' or '-'.`,
          );
        }
        index++;
      }

      if (chunks.length === 0 || chunks.every((chunk) => chunk.oldLines.length === 0 && chunk.newLines.length === 0)) {
        throw new Error(`Update hunk for '${path}' must contain change lines.`);
      }
      hunks.push({ kind: "update", path, moveTo, chunks });
      continue;
    }

    throw new Error(`Invalid hunk header at patch line ${index + 1}: '${line}'.`);
  }

  if (hunks.length === 0) {
    throw new Error("Patch must contain at least one file hunk.");
  }
  if (hunks.length > MAX_PATCH_HUNKS) {
    throw new Error(`Patch contains more than the ${MAX_PATCH_HUNKS}-hunk limit.`);
  }
  return hunks;
}

function isHunkHeader(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ") ||
    trimmed === "*** End Patch"
  );
}

function isUpdateBoundary(line: string): boolean {
  // Keep leading whitespace: one leading space is the update context marker.
  const currentLine = line.trimEnd();
  return (
    currentLine.startsWith("*** Add File: ") ||
    currentLine.startsWith("*** Delete File: ") ||
    currentLine.startsWith("*** Update File: ") ||
    currentLine === "*** End Patch"
  );
}

function headerPath(line: string, marker: string, lineNumber: number): string {
  const path = line.slice(marker.length).trim();
  if (!path) throw new Error(`Missing path at patch line ${lineNumber}.`);
  if (path.includes("\0")) throw new Error(`NUL byte in path at patch line ${lineNumber}.`);
  return path;
}

type PlannedOperation =
  | { kind: "add"; path: string; displayPath: string; content: string }
  | { kind: "delete"; path: string; displayPath: string }
  | { kind: "update"; path: string; displayPath: string; moveTo?: string; moveDisplayPath?: string; chunkGroups: UpdateChunk[][]; content: string };

type VirtualFile = { exists: boolean; isDirectory: boolean; isFile: boolean; isSymbolicLink?: boolean; content?: string };

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  const hunks = parseApplyPatch(input);
  throwIfAborted(options.signal);
  const cwd = await realpath(resolve(options.cwd));
  const lockPaths = hunks.flatMap((hunk) => {
    const paths = [resolvePatchPath(hunk.path, cwd)];
    if (hunk.kind === "update" && hunk.moveTo) paths.push(resolvePatchPath(hunk.moveTo, cwd));
    return paths;
  });

  return withMutationLocks(lockPaths, async () => {
    const operations = await planOperations(hunks, cwd, options.signal);
    throwIfAborted(options.signal);
    // Preflight catches parse/match errors before writes; I/O failures can still leave a partial patch.
    for (const operation of operations) {
      throwIfAborted(options.signal);
      if (operation.kind === "add") {
        await writeTargetFile(operation.path, operation.content, options.signal);
      } else if (operation.kind === "delete") {
        await unlink(operation.path);
      } else if (operation.moveTo) {
        await writeTargetFile(operation.moveTo, operation.content, options.signal);
        throwIfAborted(options.signal);
        await unlink(operation.path);
      } else {
        await writeTargetFile(operation.path, operation.content, options.signal);
      }
    }

    return {
      changes: operations.map((operation) => ({
        kind: operation.kind === "add" ? "added" : operation.kind === "delete" ? "deleted" : "updated",
        path: operation.displayPath,
        ...(operation.kind === "update" && operation.moveDisplayPath ? { moveTo: operation.moveDisplayPath } : {}),
      })),
    };
  });
}

async function planOperations(
  hunks: ApplyPatchHunk[],
  cwd: string,
  signal?: AbortSignal,
): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  const virtualFiles = new Map<string, VirtualFile>();

  const getVirtualFile = async (rawPath: string, followFinal = true): Promise<{ absolute: string; file: VirtualFile }> => {
    const absolute = await canonicalPath(resolvePatchPath(rawPath, cwd), followFinal, virtualFiles, signal);
    const existing = virtualFiles.get(absolute);
    if (existing && !existing.isSymbolicLink) return { absolute, file: existing };
    const file = await inspectPath(absolute);
    virtualFiles.set(absolute, file);
    return { absolute, file };
  };

  const getVirtualContent = async (absolute: string, file: VirtualFile): Promise<string> => {
    if (!file.exists || !file.isFile) throw new Error(`Cannot read non-file '${absolute}'.`);
    if (file.content === undefined) file.content = await readTargetFile(absolute, signal);
    return file.content;
  };

  for (const hunk of hunks) {
    throwIfAborted(signal);
    const source = await getVirtualFile(hunk.path, hunk.kind !== "delete");
    const sourceDisplay = displayPath(cwd, resolvePatchPath(hunk.path, cwd), hunk.path);

    if (hunk.kind === "add") {
      if (source.file.isDirectory || (source.file.exists && !source.file.isFile)) {
        throw new Error(`Cannot add file over non-file '${hunk.path}'.`);
      }
      source.file.exists = true;
      source.file.isDirectory = false;
      source.file.isFile = true;
      source.file.content = hunk.content;
      operations.push({
        kind: "add",
        path: source.absolute,
        displayPath: sourceDisplay,
        content: hunk.content,
      });
      continue;
    }

    if (hunk.kind === "delete") {
      if (!source.file.exists) throw new Error(`Cannot delete missing file '${hunk.path}'.`);
      if (!source.file.isSymbolicLink && (source.file.isDirectory || !source.file.isFile)) throw new Error(`Cannot delete non-file '${hunk.path}'.`);
      operations.push({ kind: "delete", path: source.absolute, displayPath: sourceDisplay });
      source.file.exists = false;
      source.file.isSymbolicLink = false;
      source.file.content = undefined;
      continue;
    }

    if (!source.file.exists) throw new Error(`Cannot update missing file '${hunk.path}'.`);
    if (source.file.isDirectory || !source.file.isFile) throw new Error(`Cannot update non-file '${hunk.path}'.`);
    const original = await getVirtualContent(source.absolute, source.file);
    let destination: { absolute: string; file: VirtualFile } | undefined;
    if (hunk.moveTo) {
      destination = await getVirtualFile(hunk.moveTo!);
      if (destination.absolute === source.absolute) throw new Error(`Cannot move '${hunk.path}' onto itself.`);
      if (destination.file.isDirectory || (destination.file.exists && !destination.file.isFile)) {
        throw new Error(`Cannot move file over non-file '${hunk.moveTo}'.`);
      }
    }

    const content = applyUpdateContent(original, hunk.chunks, hunk.path);
    if (destination) {
      // A move copies the referent's content, then unlinks the source entry.
      // Moving a symlink must not delete its referent.
      const sourceEntry = await getVirtualFile(hunk.path, false);
      operations.push({
        kind: "update",
        path: sourceEntry.absolute,
        displayPath: sourceDisplay,
        moveTo: destination.absolute,
        moveDisplayPath: displayPath(cwd, resolvePatchPath(hunk.moveTo!, cwd), hunk.moveTo!),
        chunkGroups: [[...hunk.chunks]],
        content,
      });
      sourceEntry.file.exists = false;
      sourceEntry.file.isSymbolicLink = false;
      sourceEntry.file.content = undefined;
      destination.file.exists = true;
      destination.file.isDirectory = false;
      destination.file.isFile = true;
      destination.file.content = content;
      continue;
    }

    const previous = operations.at(-1);
    if (previous?.kind === "update" && previous.path === source.absolute && !previous.moveTo) {
      previous.content = content;
      previous.chunkGroups.push([...hunk.chunks]);
    } else {
      operations.push({
        kind: "update",
        path: source.absolute,
        displayPath: sourceDisplay,
        chunkGroups: [[...hunk.chunks]],
        content,
      });
    }
    source.file.content = content;
  }

  return operations;
}

function resolvePatchPath(rawPath: string, cwd: string): string {
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
}

// Resolve aliases for preflight identity, including dangling links and missing
// descendants. This is not a filesystem sandbox; I/O uses normal Node semantics.
async function canonicalPath(
  absolute: string,
  followFinal = true,
  virtualFiles = new Map<string, VirtualFile>(),
  signal?: AbortSignal,
): Promise<string> {
  let links = 0;
  let current = parse(absolute).root;
  let pending = relative(current, absolute).split(sep).filter(Boolean);
  while (pending.length > 0) {
    throwIfAborted(signal);
    const component = pending.shift()!;
    if (component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    current = join(current, component);
    const file = virtualFiles.get(current) ?? await inspectPath(current);
    if (file.isSymbolicLink && (followFinal || pending.length > 0)) {
      if (++links > 40) throw new Error(`Too many symbolic links in patch path: ${absolute}`);
      const target = await readlink(current);
      const root = parse(target).root;
      current = root || dirname(current);
      // Do not normalize '..' in a link's stored target before following any
      // earlier links: the OS applies it to the resolved directory.
      pending = [...target.slice(root.length).split(sep).filter(Boolean), ...pending];
    } else if (pending.length > 0 && file.exists && !file.isDirectory) {
      throw new Error(`Parent path is not a directory: ${absolute}`);
    }
  }
  return current;
}

async function inspectPath(absolute: string): Promise<VirtualFile> {
  try {
    const stats = await lstat(absolute);
    return { exists: true, isDirectory: stats.isDirectory(), isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink() };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { exists: false, isDirectory: false, isFile: false };
  }
}

async function readTargetFile(absolute: string, signal?: AbortSignal): Promise<string> {
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`Patch target is not a regular file: ${absolute}`);
    if (stats.size > MAX_TARGET_FILE_BYTES) {
      throw new Error(`Patch target exceeds the ${MAX_TARGET_FILE_BYTES}-byte limit: ${absolute}`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const buffer = Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, MAX_TARGET_FILE_BYTES + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
      if (total > MAX_TARGET_FILE_BYTES) {
        throw new Error(`Patch target exceeds the ${MAX_TARGET_FILE_BYTES}-byte limit: ${absolute}`);
      }
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await file.close();
  }
}

async function writeTargetFile(absolute: string, content: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await mkdir(dirname(absolute), { recursive: true });
  throwIfAborted(signal);
  // Match Pi write: follow symlinks and retain the mutation lock until I/O settles.
  await writeFile(absolute, content, "utf8");
  throwIfAborted(signal);
}

function applyUpdateContent(original: string, chunks: UpdateChunk[], displayPath: string): string {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? original.slice(1) : original;
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const replacements: Array<{ start: number; length: number; lines: string[] }> = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = seekSequence(lines, [chunk.context], lineIndex, false);
      if (contextIndex === undefined) throw new Error(`Failed to find context '${chunk.context}' in ${displayPath}.`);
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({ start: lines.length, length: 0, lines: [...chunk.newLines] });
      continue;
    }

    let pattern = chunk.oldLines;
    let replacementLines = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile);
    if (found === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (replacementLines.at(-1) === "") replacementLines = replacementLines.slice(0, -1);
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile);
    }
    if (found === undefined) {
      throw new Error(`Failed to find expected lines in ${displayPath}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push({ start: found, length: pattern.length, lines: [...replacementLines] });
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (current.start < previous.start + previous.length) {
      throw new Error(`Overlapping update chunks are not allowed in ${displayPath}.`);
    }
  }

  const updated = [...lines];
  for (const replacement of [...replacements].reverse()) {
    updated.splice(replacement.start, replacement.length, ...replacement.lines);
  }
  if (updated.at(-1) !== "") updated.push("");
  return bom + updated.join(lineEnding);
}

function seekSequence(lines: string[], pattern: string[], start: number, endOfFile: boolean): number | undefined {
  if (pattern.length === 0) return Math.min(start, lines.length);
  if (pattern.length > lines.length) return undefined;
  const first = endOfFile ? Math.max(start, lines.length - pattern.length) : start;
  const last = lines.length - pattern.length;
  if (first > last) return undefined;

  // KMP keeps each normalization pass linear instead of rescanning the pattern at every line.
  for (const normalize of [(value: string) => value, (value: string) => value.trimEnd(), (value: string) => value.trim(), normalizePunctuation]) {
    const expected = pattern.map(normalize);
    const prefix = buildPrefixTable(expected);
    let matched = 0;
    for (let index = first; index < lines.length; index++) {
      const actual = normalize(lines[index]);
      while (matched > 0 && actual !== expected[matched]) matched = prefix[matched - 1];
      if (actual === expected[matched]) matched++;
      if (matched === expected.length) return index - expected.length + 1;
    }
  }
  return undefined;
}

function buildPrefixTable(pattern: string[]): number[] {
  const prefix = Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[index] === pattern[matched]) matched++;
    prefix[index] = matched;
  }
  return prefix;
}

function normalizePunctuation(value: string): string {
  return value.trim().replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018-\u201b]/g, "'").replace(/[\u201c-\u201f]/g, '"').replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

async function withMutationLocks<T>(paths: string[], callback: () => Promise<T>): Promise<T> {
  // Pi also canonicalizes queue keys. Deduplicate aliases before nesting queues,
  // or two names for one file would attempt to acquire the same lock twice.
  const uniquePaths = [...new Set(await Promise.all(paths.map((path) => canonicalPath(path))))].sort();
  const acquire = (index: number): Promise<T> =>
    index === uniquePaths.length ? callback() : withFileMutationQueue(uniquePaths[index], () => acquire(index + 1));
  return acquire(0);
}

function displayPath(root: string, absolute: string, fallback: string): string {
  const relativePath = relative(root, absolute);
  return relativePath && !relativePath.startsWith("..") ? relativePath : fallback;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
