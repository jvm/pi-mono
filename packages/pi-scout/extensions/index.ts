import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildScoutPrompt, formatRepo, loadPrunedState, registerRepo, removeRepo } from "../src/index.js";

const RegisterRepoParams = Type.Object({
  source: Type.String({ description: "Git repository URL, local path, or GitHub shorthand like owner/repo to clone into Pi Scout's temporary cache." }),
  name: Type.Optional(Type.String({ description: "Optional friendly name for the registered repository." })),
  branch: Type.Optional(Type.String({ description: "Optional branch, tag, or ref to clone." })),
  depth: Type.Optional(Type.Integer({ minimum: 1, description: "Optional shallow clone depth." })),
});

const RemoveRepoParams = Type.Object({
  idOrName: Type.String({ description: "Registered repository id or name to remove from Pi Scout records." }),
  deleteClone: Type.Optional(Type.Boolean({ description: "Also delete the cloned temporary directory." })),
});

export default function piScout(pi: ExtensionAPI) {
  pi.registerCommand("scout", {
    description: "Register and manage local reference repositories for codebase exploration",
    handler: async (args, ctx) => {
      await handleScoutCommand(pi, args, ctx);
    },
  });

  pi.registerTool({
    name: "scout_add",
    label: "Scout Add",
    description: "Clone a Git repository into Pi Scout's local temporary cache and register it as a reference codebase.",
    promptSnippet: "Register reference repositories for local codebase exploration.",
    promptGuidelines: [
      "Use scout_add when the user asks to register or scout an external Git repository for local codebase exploration.",
    ],
    parameters: RegisterRepoParams,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as { source: string; name?: string; branch?: string; depth?: number };
      const repo = await registerRepo(pi, { ...params, signal });
      return {
        content: [{ type: "text", text: `Registered Pi Scout repository:\n${formatRepo(repo)}` }],
        details: { repo },
      };
    },
  });

  pi.registerTool({
    name: "scout_ls",
    label: "Scout List",
    description: "List Pi Scout registered reference repositories that still exist in the local temporary cache.",
    promptSnippet: "List registered Pi Scout reference repositories.",
    promptGuidelines: [
      "Use scout_ls before exploring registered reference repositories if you need their current local paths.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const state = await loadPrunedState();
      const text = state.repos.length === 0
        ? "No Pi Scout repositories are currently registered."
        : `Registered Pi Scout repositories:\n\n${state.repos.map(formatRepo).join("\n\n")}`;
      return { content: [{ type: "text", text }], details: { repos: state.repos } };
    },
  });

  pi.registerTool({
    name: "scout_rm",
    label: "Scout Remove",
    description: "Remove a repository from Pi Scout records. This does not delete the cloned directory.",
    promptSnippet: "Remove registered Pi Scout reference repositories from records.",
    promptGuidelines: [
      "Use scout_rm only when the user asks to unregister or remove a Pi Scout repository record.",
    ],
    parameters: RemoveRepoParams,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as { idOrName: string; deleteClone?: boolean };
      const removed = await removeRepo(params.idOrName, { deleteClone: params.deleteClone });
      const text = removed
        ? `Removed Pi Scout repository from records:\n${formatRepo(removed)}\n\nLocal clone ${params.deleteClone ? "deleted" : "was not deleted"}.`
        : `No Pi Scout repository matched "${params.idOrName}".`;
      return { content: [{ type: "text", text }], details: { removed, deletedClone: Boolean(params.deleteClone && removed) } };
    },
  });

  pi.on("before_agent_start", async (event) => {
    const state = await loadPrunedState();
    const scoutPrompt = buildScoutPrompt(state.repos);
    if (!scoutPrompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${scoutPrompt}` };
  });
}

async function handleScoutCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (trimmed) {
    const repo = await registerRepo(pi, { source: trimmed });
    ctx.ui.notify(`Pi Scout registered ${repo.name}`, "info");
    return;
  }

  const action = await ctx.ui.select("Pi Scout", [
    "Register repository",
    "List repositories",
    "Remove repository",
  ]);

  if (action === "Register repository") {
    const source = await ctx.ui.input("Repository URL or local path", "https://github.com/owner/repo.git");
    if (!source?.trim()) return;
    const name = await ctx.ui.input("Optional friendly name", "");
    const repo = await registerRepo(pi, { source, name: name?.trim() || undefined });
    ctx.ui.notify(`Pi Scout registered ${repo.name}`, "info");
    return;
  }

  if (action === "List repositories") {
    const state = await loadPrunedState();
    const text = state.repos.length === 0
      ? "No Pi Scout repositories are currently registered."
      : state.repos.map(formatRepo).join("\n\n");
    await ctx.ui.editor("Pi Scout repositories", text);
    return;
  }

  if (action === "Remove repository") {
    const state = await loadPrunedState();
    if (state.repos.length === 0) {
      ctx.ui.notify("No Pi Scout repositories are currently registered.", "info");
      return;
    }
    const labels = state.repos.map((repo) => `${repo.name} (${repo.id})`);
    const selected = await ctx.ui.select("Remove repository", labels);
    if (!selected) return;
    const id = selected.match(/\(([^)]+)\)$/)?.[1];
    if (!id) return;
    const deleteClone = await ctx.ui.confirm("Delete local clone?", "Also delete the cloned temporary directory?");
    const removed = await removeRepo(id, { deleteClone });
    if (removed) ctx.ui.notify(`Removed ${removed.name}${deleteClone ? " and deleted its clone" : " from Pi Scout records"}`, "info");
  }
}
