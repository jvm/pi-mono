import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasSecretUrlParts, parseGitHubShorthand, resolveSource, storedSourceKey, trimLeading, trimTrailing, validateRef } from "./source.js";
import { loadPrunedState, mutateState, type ScoutRepo } from "./state.js";

export interface RegisterRepoOptions {
  source: string;
  name?: string;
  branch?: string;
  depth?: number;
  /** Fetch and fast-forward the clone when the source is already registered. */
  refresh?: boolean;
  /** Base directory for relative local paths. Defaults to the process working directory. */
  cwd?: string;
  signal?: AbortSignal;
}

export type AddRepoStatus = "cloned" | "reused" | "refreshed";

export interface AddRepoResult {
  repo: ScoutRepo;
  status: AddRepoStatus;
}

const GIT_TIMEOUT_MS = 120_000;
// Scout discards Git output. Pi >= 1.5 terminates a command past this limit;
// older hosts ignore the option.
export const GIT_MAX_BUFFER = 1024 * 1024;
// Never let configuration enable arbitrary-command transports, and fail
// instead of prompting on a terminal that Pi's TUI owns.
const GIT_SAFETY_ARGS = ["-c", "protocol.ext.allow=never", "-c", "credential.interactive=false"];
const BATCH_SSH_ARGS = ["-c", "core.sshCommand=ssh -oBatchMode=yes"];

/** The subset of `pi.exec` options Scout uses; `maxBuffer` exists from Pi 1.5. */
interface GitExecOptions {
  signal?: AbortSignal;
  timeout: number;
  cwd?: string;
  maxBuffer: number;
}

/** The subset of `pi.exec` results Scout reads; `truncated` exists from Pi 1.5. */
interface GitExecResult {
  code: number;
  stdout: string;
  killed?: boolean;
  truncated?: boolean;
}

function gitExec(pi: ExtensionAPI, args: string[], options: GitExecOptions): Promise<GitExecResult> {
  return pi.exec("git", args, options);
}

/** Register a repository, returning only the record. See {@link addRepo}. */
export async function registerRepo(pi: ExtensionAPI, options: RegisterRepoOptions): Promise<ScoutRepo> {
  return (await addRepo(pi, options)).repo;
}

/**
 * Clone and register a repository, or reuse the existing clone for an
 * equivalent source and ref. With `refresh`, an existing clone is fetched and
 * fast-forwarded first.
 */
export async function addRepo(pi: ExtensionAPI, options: RegisterRepoOptions): Promise<AddRepoResult> {
  const source = resolveSource(options.source, options.cwd ?? process.cwd());
  const branch = validateRef(options.branch);
  const key = repoKey(source.key, branch);

  const existing = findByKey((await loadPrunedState()).repos, key);
  if (existing) {
    if (!options.refresh) return { repo: existing, status: "reused" };
    await refreshRepo(pi, existing, options.signal);
    return { repo: existing, status: "refreshed" };
  }

  const id = randomUUID().slice(0, 12);
  const name = sanitizeName(options.name?.trim() || inferName(source.stored) || `repo-${id}`);
  const root = getScoutCloneRoot();
  const destination = join(root, `${name}-${id}`);
  await ensurePrivateCloneRoot(root);
  await mkdir(destination, { mode: 0o700 });

  const args = [...await networkSafetyArgs(pi, [], root, options.signal), "clone", "--quiet", "--no-progress"];
  // The `--opt=value` form keeps the ref a value even if validation regressed.
  if (branch) args.push(`--branch=${branch}`);
  const depth = options.depth && Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 1;
  args.push("--depth", String(depth));
  args.push("--", source.clone, destination);

  try {
    await runGit(pi, args, options.signal, "clone", "Check the source and Git authentication.", root);
    // Git stores the origin verbatim in .git/config, which the agent can read.
    if (hasSecretUrlParts(source.clone)) {
      await runGit(pi, ["-C", destination, "remote", "set-url", "--", "origin", source.stored], options.signal,
        "remote update", "Could not remove credentials from the clone configuration.", root);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  if (platform() !== "win32") await chmod(destination, 0o700);

  const now = new Date().toISOString();
  const repo: ScoutRepo = {
    id,
    name,
    source: source.stored,
    path: destination,
    branch,
    createdAt: now,
    lastSeenAt: now,
  };

  const raced = await mutateState((state) => {
    const match = findByKey(state.repos, key);
    if (!match) state.repos.push(repo);
    return match;
  });
  if (raced) {
    await rm(destination, { recursive: true, force: true });
    return { repo: raced, status: "reused" };
  }
  return { repo, status: "cloned" };
}

/**
 * Fetch the clone's configured upstream and fast-forward to it. Uses the
 * refspec Git recorded at clone time, so no caller input reaches Git. A
 * failure leaves the working tree unchanged.
 */
export async function refreshRepo(pi: ExtensionAPI, repo: ScoutRepo, signal?: AbortSignal): Promise<void> {
  await assertOwnedClone(repo.path);
  const local = ["-C", repo.path];
  const git = [...await networkSafetyArgs(pi, local, repo.path, signal), ...local];
  await runGit(pi, [...git, "fetch", "--quiet", "--no-progress", "--no-tags", "origin"], signal,
    "fetch", "Check the network and Git authentication; the existing clone is unchanged.", repo.path);
  await runGit(pi, [...git, "merge", "--ff-only", "--quiet", "FETCH_HEAD"], signal,
    "fast-forward", "Local changes or rewritten upstream history block it; the existing clone is unchanged.", repo.path);
}

export async function removeRepo(idOrName: string, options: { deleteClone?: boolean } = {}): Promise<ScoutRepo | undefined> {
  const needle = idOrName.trim();
  if (!needle) return undefined;

  const removed = await mutateState((state) => {
    const index = state.repos.findIndex((repo) => repo.id === needle || repo.name === needle);
    if (index === -1) return undefined;
    return state.repos.splice(index, 1)[0];
  });

  if (options.deleteClone && removed) {
    await rm(removed.path, { recursive: true, force: true });
  }

  return removed;
}

export function formatRepo(repo: ScoutRepo): string {
  const branch = repo.branch ? ` (${repo.branch})` : "";
  return `${repo.name}${branch}\n  id: ${repo.id}\n  source: ${repo.source}\n  path: ${repo.path}`;
}

export function getScoutCloneRoot(): string {
  const parent = process.env.PI_SCOUT_TMPDIR || tmpdir();
  if (platform() === "win32") return join(parent, "pi-scout");
  return join(parent, `pi-scout-${getCurrentUid()}`);
}

export async function ensurePrivateCloneRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (platform() === "win32") return;

  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe Pi Scout clone root: ${root} is not a real directory.`);
  }
  if (info.uid !== getCurrentUid()) {
    throw new Error(`Unsafe Pi Scout clone root: ${root} is not owned by current user.`);
  }
  await chmod(root, 0o700);
}

async function assertOwnedClone(path: string): Promise<void> {
  const root = getScoutCloneRoot();
  if (dirname(path) !== root) {
    throw new Error("Cannot refresh a clone outside the current private Scout directory. Remove and add the repository again.");
  }
  await ensurePrivateCloneRoot(root);
  if (platform() === "win32") return;
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== getCurrentUid()) {
    throw new Error("Cannot refresh: the Scout clone is not a real directory owned by the current user.");
  }
}

/**
 * Safety options for Git calls that may contact a remote. SSH runs in batch
 * mode so passphrase, password and host-key prompts fail instead of opening
 * the terminal. A user-chosen SSH command (`GIT_SSH_COMMAND`, `GIT_SSH`, or
 * `core.sshCommand`) is kept unchanged: it may not accept OpenSSH options.
 * `pi.exec` cannot set environment variables, so this uses `-c`.
 */
async function networkSafetyArgs(pi: ExtensionAPI, local: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return GIT_SAFETY_ARGS;
  let configured = false;
  try {
    const result = await gitExec(pi, [...local, "config", "--get", "core.sshCommand"],
      { signal, timeout: GIT_TIMEOUT_MS, cwd, maxBuffer: GIT_MAX_BUFFER });
    configured = result.code === 0 && result.stdout.trim() !== "";
  } catch {
    // Unknown configuration: batch mode is the non-interactive default.
  }
  return configured ? GIT_SAFETY_ARGS : [...GIT_SAFETY_ARGS, ...BATCH_SSH_ARGS];
}

async function runGit(pi: ExtensionAPI, args: string[], signal: AbortSignal | undefined, step: string, hint: string, cwd?: string): Promise<void> {
  let result;
  try {
    result = await gitExec(pi, args, { signal, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, ...(cwd ? { cwd } : {}) });
  } catch {
    throw new Error(signal?.aborted ? `Git ${step} cancelled.` : `Git ${step} could not run. Check Git and authentication.`);
  }
  if (signal?.aborted) throw new Error(`Git ${step} cancelled.`);
  // Output is discarded, so truncation alone is harmless. Pi stops the command
  // when it truncates, which surfaces below as a nonzero exit code.
  if (result.truncated && result.code !== 0) throw new Error(`Git ${step} stopped: output exceeded ${GIT_MAX_BUFFER} bytes. ${hint}`);
  if (result.killed) throw new Error(`Git ${step} timed out. ${hint}`);
  // Git can echo origin URLs, credentials or arbitrary remote output: never surface it.
  if (result.code !== 0) throw new Error(`Git ${step} failed (exit code ${result.code}). ${hint}`);
}

function repoKey(sourceKey: string, branch: string | undefined): string {
  return `${sourceKey}#${branch ?? ""}`;
}

function findByKey(repos: ScoutRepo[], key: string): ScoutRepo | undefined {
  return repos.find((repo) => {
    const sourceKey = storedSourceKey(repo.source);
    return sourceKey !== undefined && repoKey(sourceKey, repo.branch || undefined) === key;
  });
}

function getCurrentUid(): number {
  if (!process.getuid) throw new Error("Pi Scout cannot determine current user ID.");
  return process.getuid();
}

function inferName(source: string): string {
  const shorthand = parseGitHubShorthand(source);
  if (shorthand) return shorthand.repo;

  // URL userinfo/query/fragment may contain credentials. Never use them as a
  // public name or destination basename, including origins without a path.
  if (source.includes("://")) {
    try { source = new URL(source).pathname; }
    catch { return "repo"; }
  }
  const withoutTrailingSlash = trimTrailing(source, "/\\");
  const last = basename(withoutTrailingSlash).replace(/\.git$/i, "");
  return last || "repo";
}

function sanitizeName(name: string): string {
  const dashed = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return trimLeading(trimTrailing(dashed, "-"), "-").slice(0, 64) || "repo";
}
