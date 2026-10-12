import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A missing version is publishable; every other registry failure is fatal. */
export async function alreadyPublished(pack, fetchVersion = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pack.name)}/${encodeURIComponent(pack.version)}`;
  const response = await fetchVersion(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== pack.name || metadata.version !== pack.version ||
      typeof pack.integrity !== "string" || !pack.integrity.startsWith("sha512-") ||
      metadata.dist?.integrity !== pack.integrity) {
    throw new Error(`Published artifact differs from local package: ${pack.name}@${pack.version}`);
  }
  return true;
}

export async function checkWorkspace(workspace, fetchVersion = fetch) {
  if (!/^packages\/[a-z0-9][a-z0-9-]*$/.test(workspace ?? "")) {
    throw new Error("Expected a package workspace path");
  }
  const temp = await mkdtemp(join(tmpdir(), "pi-publish-check-"));
  try {
    // Pack once, without lifecycle scripts, to compare the actual shipped bytes.
    const { stdout } = await exec("npm", [
      "pack", "--workspace", workspace, "--json", "--ignore-scripts", "--pack-destination", temp,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const packs = JSON.parse(stdout);
    if (!Array.isArray(packs) || packs.length !== 1) throw new Error("Expected one packed package");
    const published = await alreadyPublished(packs[0], fetchVersion);
    return { published, pack: packs[0] };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { published, pack } = await checkWorkspace(process.argv[2]);
  console.log(`${pack.name}@${pack.version}: ${published ? "already published with matching integrity" : "not yet published"}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `already_published=${published}\n`);
  }
}
