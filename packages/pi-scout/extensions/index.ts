import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportInstallTelemetry } from "../src/install-telemetry.js";
import { buildScoutPrompt, formatRepo, loadPrunedState, registerRepo, removeRepo } from "../src/index.js";

const RegisterRepoParams = Type.Object({
  source: Type.String({ description: "Git URL/path or owner/repo." }),
});

const RemoveRepoParams = Type.Object({
  idOrName: Type.String({ description: "Repo id or name." }),
  deleteClone: Type.Optional(Type.Boolean({ description: "Delete temp clone too." })),
});

export default function piScout(pi: ExtensionAPI) {
  reportInstallTelemetry();

  let scoutRmRegistered = false;

  function setToolActive(name: string, active: boolean): void {
    const activeTools = pi.getActiveTools();
    const hasTool = activeTools.includes(name);
    if (active && !hasTool) pi.setActiveTools([...activeTools, name]);
    if (!active && hasTool) pi.setActiveTools(activeTools.filter((tool) => tool !== name));
  }

  async function syncScoutRmTool(): Promise<void> {
    const hasRepos = (await loadPrunedState()).repos.length > 0;
    if (hasRepos && !scoutRmRegistered) {
      pi.registerTool({
        name: "scout_rm",
        label: "Scout Remove",
        description: "Remove a Scout repo record.",
        promptSnippet: "Remove Scout repo records.",
        promptGuidelines: [
          "Use scout_rm only when asked to unregister a Scout repo.",
        ],
        parameters: RemoveRepoParams,
        async execute(_toolCallId, rawParams) {
          const params = rawParams as { idOrName: string; deleteClone?: boolean };
          const removed = await removeRepo(params.idOrName, { deleteClone: params.deleteClone });
          await syncScoutRmTool();
          const text = removed
            ? `Removed Pi Scout repository from records:\n${formatRepo(removed)}\n\nLocal clone ${params.deleteClone ? "deleted" : "was not deleted"}.`
            : `No Pi Scout repository matched "${params.idOrName}".`;
          return { content: [{ type: "text", text }], details: { removed, deletedClone: Boolean(params.deleteClone && removed) } };
        },
      });
      scoutRmRegistered = true;
    }
    if (scoutRmRegistered) setToolActive("scout_rm", hasRepos);
  }

  pi.on("session_start", async () => {
    await syncScoutRmTool();
  });

  pi.registerCommand("scout", {
    description: "Manage Scout reference repos",
    handler: async (args, ctx) => {
      await handleScoutCommand(pi, args, ctx, syncScoutRmTool);
    },
  });

  pi.registerTool({
    name: "scout_add",
    label: "Scout Add",
    description: "Clone/register a reference repo.",
    promptSnippet: "Add Scout reference repos.",
    promptGuidelines: [
      "Use scout_add to register a Git repo for code exploration.",
    ],
    parameters: RegisterRepoParams,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as { source: string };
      const repo = await registerRepo(pi, { source: params.source, signal });
      await syncScoutRmTool();
      return {
        content: [{ type: "text", text: `Registered Pi Scout repository:\n${formatRepo(repo)}` }],
        details: { repo },
      };
    },
  });


  pi.on("before_agent_start", async (event) => {
    await syncScoutRmTool();
    const state = await loadPrunedState();
    const scoutPrompt = buildScoutPrompt(state.repos);
    if (!scoutPrompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${scoutPrompt}` };
  });
}

async function handleScoutCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  syncScoutRmTool: () => Promise<void>,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed) {
    const repo = await registerRepo(pi, { source: trimmed });
    await syncScoutRmTool();
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
    await syncScoutRmTool();
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
    await syncScoutRmTool();
    if (removed) ctx.ui.notify(`Removed ${removed.name}${deleteClone ? " and deleted its clone" : " from Pi Scout records"}`, "info");
  }
}
