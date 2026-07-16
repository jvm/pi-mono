import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mutateState, type ScoutRepo } from "./state.js";

export interface RegisterRepoOptions {
  source: string;
  name?: string;
  branch?: string;
  depth?: number;
  signal?: AbortSignal;
}

export async function registerRepo(pi: ExtensionAPI, options: RegisterRepoOptions): Promise<ScoutRepo> {
  const source = normalizeSource(options.source.trim());
  if (!source) throw new Error("Repository source is required.");

  const id = randomUUID().slice(0, 12);
  const name = sanitizeName(options.name?.trim() || inferName(source) || `repo-${id}`);
  const root = getScoutCloneRoot();
  const destination = join(root, `${name}-${id}`);
  await ensurePrivateCloneRoot(root);
  await mkdir(destination, { mode: 0o700 });

  const args = ["clone"];
  if (options.branch?.trim()) args.push("--branch", options.branch.trim());
  const depth = options.depth && Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 1;
  args.push("--depth", String(depth));
  args.push(source, destination);

  const result = await pi.exec("git", args, { signal: options.signal, timeout: 120_000 });
  if (result.code !== 0) {
    await rm(destination, { recursive: true, force: true });
    const stderr = result.stderr?.trim() || result.stdout?.trim() || "git clone failed";
    throw new Error(stderr);
  }
  if (platform() !== "win32") await chmod(destination, 0o700);

  const now = new Date().toISOString();
  const repo: ScoutRepo = {
    id,
    name,
    source,
    path: destination,
    branch: options.branch?.trim() || undefined,
    createdAt: now,
    lastSeenAt: now,
  };

  await mutateState((state) => {
    state.repos.push(repo);
  });
  return repo;
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

function getCurrentUid(): number {
  if (!process.getuid) throw new Error("Pi Scout cannot determine current user ID.");
  return process.getuid();
}

function inferName(source: string): string {
  const shorthand = parseGitHubShorthand(source);
  if (shorthand) return shorthand.repo;

  const withoutTrailingSlash = source.replace(/[\\/]+$/, "");
  const last = basename(withoutTrailingSlash).replace(/\.git$/i, "");
  return last || "repo";
}

function normalizeSource(source: string): string {
  const shorthand = parseGitHubShorthand(source);
  if (!shorthand) return source;
  return `https://github.com/${shorthand.owner}/${shorthand.repo}.git`;
}

function parseGitHubShorthand(source: string): { owner: string; repo: string } | undefined {
  const match = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/i, "") };
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "repo";
}
