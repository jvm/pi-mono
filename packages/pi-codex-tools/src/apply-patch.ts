// Adapted from OpenAI Codex apply-patch grammar/parser behavior; see NOTICE.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const MAX_PATCH_BYTES = 1_048_576;
export const MAX_PATCH_HUNKS = 1_000;
export const MAX_TARGET_FILE_BYTES = 64 * 1024 * 1024;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SECURE_FD_DIRECTORY = process.platform === "linux" ? "/proc/self/fd" : undefined;
const BASE_SECURE_FILESYSTEM_SUPPORTED = SECURE_FD_DIRECTORY !== undefined && O_NOFOLLOW !== 0;
let secureFilesystemSupportedOverride: boolean | undefined;

/** Whether apply_patch can safely execute against this platform's filesystem. */
export function secureFilesystemSupported(): boolean {
  return secureFilesystemSupportedOverride ?? BASE_SECURE_FILESYSTEM_SUPPORTED;
}

/** @internal Force the support flag so the activation path can be tested on any host platform. */
export function setSecureFilesystemSupportedForTest(value: boolean | undefined): void {
  secureFilesystemSupportedOverride = value;
}
const SECURE_DIRECTORY_FLAGS = constants.O_RDONLY | O_NOFOLLOW | (constants.O_DIRECTORY ?? 0) | (constants.O_NONBLOCK ?? 0);
const SECURE_READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
const SECURE_UPDATE_FLAGS = constants.O_WRONLY | O_NOFOLLOW | constants.O_TRUNC | (constants.O_NONBLOCK ?? 0);
const SECURE_CREATE_FLAGS = SECURE_UPDATE_FLAGS | constants.O_CREAT;
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

type SafePath = { absolute: string; exists: boolean; isDirectory: boolean; isFile: boolean };
type VirtualFile = Omit<SafePath, "absolute"> & { content?: string };

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  requireSecureFilesystem();
  const hunks = parseApplyPatch(input);
  const root = await realpath(resolve(options.cwd));
  const lockPaths = hunks.flatMap((hunk) => {
    const paths = [resolvePatchPath(hunk.path, root)];
    if (hunk.kind === "update" && hunk.moveTo) paths.push(resolvePatchPath(hunk.moveTo, root));
    return paths;
  });

  return withMutationLocks(lockPaths, async () => {
    const rootHandle = await openSecureRoot(root, options.signal);
    try {
      const operations = await planOperations(hunks, root, rootHandle, options.signal);
      throwIfAborted(options.signal);
      // ponytail: preflight catches parse/match errors before writes; cross-process failures can still leave a partial multi-file patch.
      for (const operation of operations) {
        throwIfAborted(options.signal);
        if (operation.kind === "add") {
          await writeSecureFile(rootHandle, root, operation.path, operation.content, true, options.signal);
        } else if (operation.kind === "delete") {
          await removeSecureFile(rootHandle, root, operation.path, options.signal);
        } else if (operation.moveTo) {
          await writeSecureFile(rootHandle, root, operation.moveTo, operation.content, true, options.signal);
          await removeSecureFile(rootHandle, root, operation.path, options.signal);
        } else {
          await writeSecureFile(rootHandle, root, operation.path, operation.content, false, options.signal);
        }
      }

      return {
        changes: operations.map((operation) => ({
          kind: operation.kind === "add" ? "added" : operation.kind === "delete" ? "deleted" : "updated",
          path: operation.displayPath,
          ...(operation.kind === "update" && operation.moveDisplayPath ? { moveTo: operation.moveDisplayPath } : {}),
        })),
      };
    } finally {
      await rootHandle.close();
    }
  });
}

async function planOperations(hunks: ApplyPatchHunk[], root: string, rootHandle: FileHandle, signal?: AbortSignal): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  const virtualFiles = new Map<string, VirtualFile>();

  const getVirtualFile = async (rawPath: string): Promise<{ absolute: string; file: VirtualFile }> => {
    const absolute = resolvePatchPath(rawPath, root);
    const existing = virtualFiles.get(absolute);
    if (existing) return { absolute, file: existing };
    const safe = await safePath(rawPath, root, signal);
    const file: VirtualFile = {
      exists: safe.exists,
      isDirectory: safe.isDirectory,
      isFile: safe.isFile,
    };
    virtualFiles.set(absolute, file);
    return { absolute, file };
  };

  const getVirtualContent = async (absolute: string, file: VirtualFile): Promise<string> => {
    if (!file.exists || !file.isFile) throw new Error(`Cannot read non-file '${absolute}'.`);
    if (file.content === undefined) file.content = await readSecureFile(rootHandle, root, absolute, signal);
    return file.content;
  };

  for (const hunk of hunks) {
    throwIfAborted(signal);
    const source = await getVirtualFile(hunk.path);

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
        displayPath: displayPath(root, source.absolute, hunk.path),
        content: hunk.content,
      });
      continue;
    }

    if (hunk.kind === "delete") {
      if (!source.file.exists) throw new Error(`Cannot delete missing file '${hunk.path}'.`);
      if (source.file.isDirectory || !source.file.isFile) throw new Error(`Cannot delete non-file '${hunk.path}'.`);
      operations.push({ kind: "delete", path: source.absolute, displayPath: displayPath(root, source.absolute, hunk.path) });
      source.file.exists = false;
      source.file.content = undefined;
      continue;
    }

    if (!source.file.exists) throw new Error(`Cannot update missing file '${hunk.path}'.`);
    if (source.file.isDirectory || !source.file.isFile) throw new Error(`Cannot update non-file '${hunk.path}'.`);
    const original = await getVirtualContent(source.absolute, source.file);
    const moveTo = hunk.moveTo ? resolvePatchPath(hunk.moveTo, root) : undefined;
    if (moveTo === source.absolute) throw new Error(`Cannot move '${hunk.path}' onto itself.`);

    let destination: { absolute: string; file: VirtualFile } | undefined;
    if (moveTo) {
      destination = await getVirtualFile(hunk.moveTo!);
      if (destination.file.isDirectory || (destination.file.exists && !destination.file.isFile)) {
        throw new Error(`Cannot move file over non-file '${hunk.moveTo}'.`);
      }
    }

    const content = applyUpdateContent(original, hunk.chunks, hunk.path);
    if (destination) {
      operations.push({
        kind: "update",
        path: source.absolute,
        displayPath: displayPath(root, source.absolute, hunk.path),
        moveTo: moveTo!,
        moveDisplayPath: displayPath(root, moveTo!, hunk.moveTo!),
        chunkGroups: [[...hunk.chunks]],
        content,
      });
      source.file.exists = false;
      source.file.content = undefined;
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
        displayPath: displayPath(root, source.absolute, hunk.path),
        chunkGroups: [[...hunk.chunks]],
        content,
      });
    }
    source.file.content = content;
  }

  return operations;
}

function resolvePatchPath(rawPath: string, root: string): string {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  if (!isWithin(root, absolute) || absolute === root) {
    throw new Error(`Patch path must stay inside the current working directory: ${rawPath}`);
  }
  return absolute;
}

async function safePath(rawPath: string, root: string, signal?: AbortSignal): Promise<SafePath> {
  throwIfAborted(signal);
  const absolute = resolvePatchPath(rawPath, root);

  let current = absolute;
  while (true) {
    throwIfAborted(signal);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Symlink paths are not allowed in apply_patch: ${rawPath}`);
      }
      const resolved = await realpath(current);
      if (!isWithin(root, resolved)) {
        throw new Error(`Patch path escapes the current working directory: ${rawPath}`);
      }
      if (current !== absolute && !stats.isDirectory()) {
        throw new Error(`Parent path is not a directory: ${rawPath}`);
      }
      return {
        absolute,
        exists: current === absolute,
        isDirectory: current === absolute && stats.isDirectory(),
        isFile: current === absolute && stats.isFile(),
      };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve patch path: ${rawPath}`);
      current = parent;
    }
  }
}

function requireSecureFilesystem(): void {
  if (!secureFilesystemSupported()) {
    throw new Error("apply_patch requires a POSIX filesystem with descriptor-based no-follow support.");
  }
}

function secureChildPath(parent: FileHandle, child: string): string {
  if (!SECURE_FD_DIRECTORY) throw new Error("Secure filesystem operations are unavailable on this platform.");
  return join(SECURE_FD_DIRECTORY, String(parent.fd), child);
}

async function openSecureRoot(root: string, signal?: AbortSignal): Promise<FileHandle> {
  requireSecureFilesystem();
  let current = await open(sep, SECURE_DIRECTORY_FLAGS);
  try {
    for (const component of root.split(sep).filter(Boolean)) {
      throwIfAborted(signal);
      const next = await openSecureDirectoryChild(current, component);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function openSecureDirectoryChild(parent: FileHandle, component: string): Promise<FileHandle> {
  const handle = await open(secureChildPath(parent, component), SECURE_DIRECTORY_FLAGS);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error(`Secure path component is not a directory: ${component}`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

type SecureParent = { handle: FileHandle; owned: boolean };

async function openSecureParentDirectory(rootHandle: FileHandle, root: string, absolute: string, createParents: boolean, signal?: AbortSignal): Promise<SecureParent> {
  const parentPath = dirname(absolute);
  const relativeParent = relative(root, parentPath);
  const components = relativeParent ? relativeParent.split(sep) : [];
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error(`Patch path must stay inside the current working directory: ${absolute}`);
  }

  let current = rootHandle;
  let owned = false;
  try {
    for (const component of components) {
      throwIfAborted(signal);
      let next: FileHandle;
      try {
        next = await openSecureDirectoryChild(current, component);
      } catch (error) {
        if (!createParents || !isNoEntryError(error)) throw error;
        try {
          await mkdir(secureChildPath(current, component));
        } catch (mkdirError) {
          if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
        }
        next = await openSecureDirectoryChild(current, component);
      }
      if (owned) await current.close();
      current = next;
      owned = true;
    }
    return { handle: current, owned };
  } catch (error) {
    if (owned) await current.close().catch(() => undefined);
    throw error;
  }
}

async function withSecureFile<T>(
  rootHandle: FileHandle,
  root: string,
  absolute: string,
  flags: number,
  createParents: boolean,
  callback: (file: FileHandle, size: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = await openSecureParentDirectory(rootHandle, root, absolute, createParents, signal);
  let file: FileHandle | undefined;
  try {
    file = await open(secureChildPath(parent.handle, basename(absolute)), flags, 0o666);
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`Patch target is not a regular file: ${absolute}`);
    return await callback(file, stats.size);
  } finally {
    await file?.close().catch(() => undefined);
    if (parent.owned) await parent.handle.close().catch(() => undefined);
  }
}

async function readSecureFile(rootHandle: FileHandle, root: string, absolute: string, signal?: AbortSignal): Promise<string> {
  return withSecureFile(rootHandle, root, absolute, SECURE_READ_FLAGS, false, async (file, size) => {
    if (size > MAX_TARGET_FILE_BYTES) {
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
  }, signal);
}

async function writeSecureFile(rootHandle: FileHandle, root: string, absolute: string, content: string, createParents: boolean, signal?: AbortSignal): Promise<void> {
  const flags = createParents ? SECURE_CREATE_FLAGS : SECURE_UPDATE_FLAGS;
  await withSecureFile(rootHandle, root, absolute, flags, createParents, async (file) => {
    await file.writeFile(content, "utf8");
  }, signal);
}

async function removeSecureFile(rootHandle: FileHandle, root: string, absolute: string, signal?: AbortSignal): Promise<void> {
  const parent = await openSecureParentDirectory(rootHandle, root, absolute, false, signal);
  try {
    const target = secureChildPath(parent.handle, basename(absolute));
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new Error(`Symlink paths are not allowed in apply_patch: ${absolute}`);
    if (stats.isDirectory()) throw new Error(`Cannot delete directory '${absolute}'.`);
    await unlink(target);
  } finally {
    if (parent.owned) await parent.handle.close().catch(() => undefined);
  }
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
  const uniquePaths = [...new Set(paths)].sort();
  const acquire = (index: number): Promise<T> =>
    index === uniquePaths.length ? callback() : withFileMutationQueue(uniquePaths[index], () => acquire(index + 1));
  return acquire(0);
}

function displayPath(root: string, absolute: string, fallback: string): string {
  const relativePath = relative(root, absolute);
  return relativePath && !relativePath.startsWith("..") ? relativePath : fallback;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isNoEntryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
