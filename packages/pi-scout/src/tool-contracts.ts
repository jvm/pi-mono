import { Type } from "typebox";
import type { ScoutRepo } from "./state.js";

export const SCOUT_NAMESPACE = {
  name: "scout",
  description: "Register and remove local read-only reference clones.",
  instructions: "scout_add returns { repo }; scout_rm returns { removed: repo|null, deletedClone: boolean }. Public repo fields exclude origin/source metadata and credentials. Clone/process/storage failures reject; a missing removal target is successful data with removed:null. Both operations mutate state and run sequentially. Await dependent operations. After the first registration, start a new codemode call to discover/use scout_rm: the running script has a snapshot of callable tools. scout_add may access remote Git hosts. scout_rm can delete a clone when requested; use it only with user authorization. Repositories remain read-only references unless the user requests edits. Availability follows the active tool set; scout_rm is present only while references exist.",
};

const repo = Type.Object({
  id: Type.String(), name: Type.String(), path: Type.String(),
  branch: Type.Optional(Type.String()), createdAt: Type.String(), lastSeenAt: Type.String(),
}, { additionalProperties: false });
export const ADD_REPO_OUTPUT = Type.Object({ repo }, { additionalProperties: false });
export const REMOVE_REPO_OUTPUT = Type.Object({
  removed: Type.Union([repo, Type.Null()]), deletedClone: Type.Boolean(),
}, { additionalProperties: false });

export function publicRepo(value: ScoutRepo) {
  return {
    id: value.id, name: value.name, path: value.path,
    ...(value.branch ? { branch: value.branch } : {}),
    createdAt: value.createdAt, lastSeenAt: value.lastSeenAt,
  };
}

export function formatPublicRepo(value: ScoutRepo): string {
  const repo = publicRepo(value);
  return `${repo.name}${repo.branch ? ` (${repo.branch})` : ""}\n  id: ${repo.id}\n  path: ${repo.path}`;
}
