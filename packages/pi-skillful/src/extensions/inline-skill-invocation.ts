import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSkillBlock, sourceInfoToSkill, type SkillCommandInfo } from "../skills.js";

const SKILL_INVOCATION_PATTERN = /(^|[^\w/-])\/skill:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?=$|[^a-z0-9-])/g;

export default function inlineSkillInvocation(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.includes("/skill:")) {
      return { action: "continue" };
    }

    const skillsByName = getSkillsByName(pi);
    const invocations = findInvocations(event.text);
    if (invocations.length === 0) return { action: "continue" };

    const unknown = invocations.filter((invocation) => !skillsByName.has(invocation.name));
    if (unknown.length > 0) {
      ctx.ui.notify(
        `Unknown skill invocation(s): ${Array.from(new Set(unknown.map((invocation) => invocation.name))).join(", ")}`,
        "warning",
      );
    }

    const blocks = new Map<string, string>();
    for (const invocation of invocations) {
      const skill = skillsByName.get(invocation.name);
      if (!skill || blocks.has(invocation.name)) continue;

      try {
        blocks.set(invocation.name, await readSkillBlock(skill));
      } catch (error) {
        ctx.ui.notify(
          `Failed to read skill ${invocation.name}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }

    if (blocks.size === 0) return { action: "continue" };

    const expanded = event.text.replace(SKILL_INVOCATION_PATTERN, (fullMatch: string, prefix: string, name: string) => {
      const block = blocks.get(name);
      return block ? `${prefix}\n\n${block}\n\n` : fullMatch;
    });

    return { action: "transform", text: normalizeBlankLines(expanded), images: event.images };
  });

}

function getSkillsByName(pi: ExtensionAPI): Map<string, SkillCommandInfo> {
  const result = new Map<string, SkillCommandInfo>();
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    const skill = sourceInfoToSkill(command);
    if (skill) result.set(skill.name, skill);
  }
  return result;
}

function findInvocations(text: string): Array<{ name: string }> {
  const result: Array<{ name: string }> = [];
  const pattern = new RegExp(SKILL_INVOCATION_PATTERN.source, "g");
  for (const match of text.matchAll(pattern)) {
    result.push({ name: match[2] });
  }
  return result;
}

function normalizeBlankLines(text: string): string {
  return text.replace(/\n{4,}/g, "\n\n\n").trim();
}
