import type { ScoutRepo } from "./state.js";

export function buildScoutPrompt(repos: ScoutRepo[]): string {
  if (repos.length === 0) return "";

  const repoList = repos.map((repo) => `- ${repo.name}: ${repo.path}`).join("\n");

  return `<pi_scout_repositories>\n${repoList}\n</pi_scout_repositories>\n\nPi Scout has registered the local repository paths above as reference codebases. You may inspect them with local file tools such as read, find, grep, ls, and bash by using their absolute local paths. Use these repositories when the user asks to understand a codebase, compare implementation approaches, research open-source reuse, or replicate a feature. Treat registered repositories as reference material: do not modify them unless the user explicitly asks. If a registered repository is relevant, mention which repository path you inspected.`;
}
