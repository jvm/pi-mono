import type { ScoutRepo } from "./state.js";

export function buildScoutPrompt(repos: ScoutRepo[]): string {
  if (repos.length === 0) return "";

  const repoList = repos.map((repo) => `- ${repo.name}: ${repo.path}`).join("\n");

  return `Scout repos:\n${repoList}\nUse as read-only reference codebases when relevant.`;
}
