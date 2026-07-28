import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Walks from cwd up through all ancestor directories (no git boundary)
 * and discovers `.agents/skills/` directories that Pi's built-in discovery
 * misses because it stops at the git repo root.
 *
 * This mirrors how AGENTS.md context files are loaded from every parent
 * directory, not just within the repo boundary.
 */
export default function progressiveSkills(pi: ExtensionAPI) {
  pi.on("resources_discover", async (event) => {
    const gitRoot = findGitRoot(event.cwd);

    // No git repo — Pi already walks to filesystem root, nothing to add.
    if (!gitRoot) return;

    const resolvedGitRoot = resolve(gitRoot);
    const homeAgentsSkills = resolve(homedir(), ".agents", "skills");
    const skillPaths: string[] = [];

    // Walk from git root's parent up to filesystem root.
    // Order: git-parent first (closer to cwd = higher priority via first-wins).
    let dir = dirname(resolvedGitRoot);
    while (true) {
      const agentsSkills = join(dir, ".agents", "skills");
      const resolved = resolve(agentsSkills);

      // Skip ~/.agents/skills (handled globally by Pi) and non-existent dirs.
      if (resolved !== homeAgentsSkills && existsSync(resolved)) {
        skillPaths.push(resolved);
      }

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    if (skillPaths.length === 0) return;
    return { skillPaths };
  });
}

function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
