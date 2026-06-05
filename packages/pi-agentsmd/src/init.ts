import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INIT_PROMPT } from "./prompt.js";

const DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md";

export async function handleInitCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  const force = trimmed === "--force" || trimmed === "-f";

  const initTarget = join(ctx.cwd, DEFAULT_AGENTS_MD_FILENAME);

  if (existsSync(initTarget) && !force) {
    ctx.ui.notify(
      `${DEFAULT_AGENTS_MD_FILENAME} already exists here. Use /init --force to overwrite.`,
      "warning",
    );
    return;
  }

  pi.sendUserMessage(INIT_PROMPT);
}
