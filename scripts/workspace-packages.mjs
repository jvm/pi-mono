import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

const copyExcludes = ["node_modules", ".git", ".pi", ".test-dist"];
const piHostPackages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

/**
 * Copy the monorepo at `source` into the disposable directory `dir` and pin
 * every Pi host dev dependency, in the root and in each workspace package, to
 * `version`. Isolated host lanes install from the result.
 */
export async function prepareHostWorkspace(source, dir, version) {
  await cp(source, dir, { recursive: true, filter: path => !copyExcludes.includes(basename(path)) });
  const rootPath = join(dir, "package.json");
  const rootManifest = JSON.parse(await readFile(rootPath, "utf8"));
  rootManifest.devDependencies = Object.fromEntries(piHostPackages.map(name => [name, version]));
  await writeFile(rootPath, JSON.stringify(rootManifest, null, 2) + "\n");
  for (const name of await listWorkspacePackages(join(dir, "packages"))) {
    const path = join(dir, "packages", name, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
      if (dependency.startsWith("@earendil-works/pi-")) manifest.devDependencies[dependency] = version;
    }
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  }
}
