import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * List workspace package directory names under `packagesDir`, sorted.
 *
 * Only directories with a `package.json` count, matching npm's `packages/*`
 * workspace resolution. Git deletes only tracked files, so a removed package can
 * leave an untracked directory (generated or ignored files) behind; it is not a
 * package and must not be treated as one.
 */
export async function listWorkspacePackages(packagesDir) {
  const root = packagesDir instanceof URL ? fileURLToPath(packagesDir) : packagesDir;
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await stat(join(root, entry.name, "package.json"))).isFile()) names.push(entry.name);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  return names.sort();
}
