import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface ScoutRepo {
  id: string;
  name: string;
  source: string;
  path: string;
  branch?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ScoutState {
  repos: ScoutRepo[];
}

const STATE_DIR = join(getAgentDir(), "scout");
const STATE_PATH = join(STATE_DIR, "repos.json");

export function getScoutStatePath(): string {
  return STATE_PATH;
}

export async function loadState(): Promise<ScoutState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScoutState>;
    return { repos: Array.isArray(parsed.repos) ? parsed.repos.filter(isScoutRepo) : [] };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { repos: [] };
    throw new Error(`Failed to read pi-scout state at ${STATE_PATH}: ${error?.message ?? String(error)}`);
  }
}

export async function saveState(state: ScoutState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const temporaryPath = join(dirname(STATE_PATH), `.${basename(STATE_PATH)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, STATE_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function mutateState<T>(
  mutation: (state: ScoutState) => Promise<T> | T,
): Promise<T> {
  return withFileMutationQueue(STATE_PATH, async () => {
    const state = (await pruneMissingRepos(await loadState())).state;
    const result = await mutation(state);
    await saveState(state);
    return result;
  });
}

export async function pruneMissingRepos(state: ScoutState): Promise<{ state: ScoutState; removed: ScoutRepo[] }> {
  const repos: ScoutRepo[] = [];
  const removed: ScoutRepo[] = [];
  const now = new Date().toISOString();

  for (const repo of state.repos) {
    if (await pathExists(repo.path)) {
      repos.push({ ...repo, lastSeenAt: now });
    } else {
      removed.push(repo);
    }
  }

  return { state: { repos }, removed };
}

export async function loadPrunedState(): Promise<ScoutState> {
  return withFileMutationQueue(STATE_PATH, async () => {
    const { state, removed } = await pruneMissingRepos(await loadState());
    if (removed.length > 0) await saveState(state);
    return state;
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isScoutRepo(value: unknown): value is ScoutRepo {
  if (!value || typeof value !== "object") return false;
  const repo = value as Record<string, unknown>;
  return typeof repo.id === "string"
    && typeof repo.name === "string"
    && typeof repo.source === "string"
    && typeof repo.path === "string"
    && typeof repo.createdAt === "string"
    && typeof repo.lastSeenAt === "string";
}
