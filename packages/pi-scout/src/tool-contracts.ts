import { Type } from "typebox";
import type { ScoutRepo } from "./state.js";
import { createHash } from "node:crypto";

export const SCOUT_NAMESPACE = {
  name: "scout",
  description: "Find, register and remove local read-only reference clones.",
  instructions: "First use scout_list({filter,limit}) to select existing references without parsing prompt prose or cloning. It returns public repos, revision and nextOffset. Continue using the same filter and revision; a changed registry rejects continuation, so restart at offset 0. Read only relevant files at the selected repo.path with the file tools. scout_add returns { repo }; scout_rm returns { removed: repo|null, deletedClone: boolean }. Public repo fields exclude origin/source metadata and credentials. Clone/process/storage failures reject; a missing removal target is successful data with removed:null. Both mutations run sequentially. Await dependent operations. After the first registration, start a new codemode call to discover/use scout_rm: the running script has a snapshot of callable tools. scout_add may access remote Git hosts. scout_rm can delete a clone when requested; use it only with user authorization. Repositories remain read-only references unless the user requests edits. Availability follows the active tool set; scout_rm is present only while references exist.",
};

const repo = Type.Object({
  id: Type.String(), name: Type.String(), path: Type.String(),
  branch: Type.Optional(Type.String()), createdAt: Type.String(), lastSeenAt: Type.String(),
}, { additionalProperties: false });
export const ADD_REPO_OUTPUT = Type.Object({ repo }, { additionalProperties: false });
export const LIST_REPOS_OUTPUT = Type.Object({
  repos: Type.Array(repo), revision: Type.String(), total: Type.Integer(),
  offset: Type.Integer(), nextOffset: Type.Optional(Type.Integer()),
}, { additionalProperties: false });

export function listPublicRepos(repos: ScoutRepo[], params: { filter?: string; offset?: number; limit?: number; revision?: string }) {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
    || (params.filter !== undefined && (typeof params.filter !== "string" || params.filter.length > 256))) throw new Error("Invalid Scout pagination.");
  const sorted = repos.map(publicRepo).sort((a, b) => a.id.localeCompare(b.id));
  // lastSeenAt changes during pruning, not registry membership. Do not invalidate
  // pages for that bookkeeping update. Mutations to public identity do invalidate.
  const revision = createHash("sha256").update(JSON.stringify(sorted.map(({ lastSeenAt: _, ...repo }) => repo))).digest("hex");
  if ((offset > 0 && !params.revision) || (params.revision && params.revision !== revision)) {
    throw new Error("Scout registry changed or revision missing; restart listing at offset 0.");
  }
  const filter = params.filter?.toLowerCase() ?? "";
  const selected = sorted.filter(repo => repo.name.toLowerCase().includes(filter) || repo.id.toLowerCase().includes(filter));
  const page = [];
  let bytes = 512;
  for (const repo of selected.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(repo)) + 1;
    if (bytes + size > 50_000) break;
    bytes += size;
    page.push(repo);
  }
  if (!page.length && offset < selected.length) throw new Error("Scout record exceeds listing byte budget.");
  return { repos: page, revision, total: selected.length, offset,
    ...(offset + page.length < selected.length ? { nextOffset: offset + page.length } : {}) };
}
export const REMOVE_REPO_OUTPUT = Type.Object({
  removed: Type.Union([repo, Type.Null()]), deletedClone: Type.Boolean(),
}, { additionalProperties: false });

export function publicRepo(value: ScoutRepo) {
  return {
    id: value.id, name: value.name, path: value.path,
    ...(typeof value.branch === "string" && value.branch ? { branch: value.branch } : {}),
    createdAt: value.createdAt, lastSeenAt: value.lastSeenAt,
  };
}

export function formatPublicRepo(value: ScoutRepo): string {
  const repo = publicRepo(value);
  return `${repo.name}${repo.branch ? ` (${repo.branch})` : ""}\n  id: ${repo.id}\n  path: ${repo.path}`;
}
