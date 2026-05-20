import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeSkillName } from "./config.js";

export interface SkillCommandInfo {
  name: string;
  path: string;
  baseDir: string;
}

export interface LoadedSkillInfo {
  name: string;
  description: string;
}

interface CommandLike {
  name: string;
  source: string;
  description?: string;
}

export function listLoadedSkills(commands: Iterable<CommandLike>): LoadedSkillInfo[] {
  const byName = new Map<string, LoadedSkillInfo>();
  for (const command of commands) {
    if (command.source !== "skill") continue;
    const name = normalizeSkillName(command.name);
    if (!name) continue;
    byName.set(name, { name, description: command.description ?? "" });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? normalized.slice(match[0].length) : normalized;
}

export async function readSkillBlock(skill: SkillCommandInfo): Promise<string> {
  const content = await readFile(skill.path, "utf-8");
  const body = stripFrontmatter(content).trim();
  return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.path)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export function sourceInfoToSkill(command: {
  name: string;
  sourceInfo: { path: string; baseDir?: string };
}): SkillCommandInfo | null {
  if (!command.name.startsWith("skill:")) return null;
  const name = command.name.slice("skill:".length);
  if (!name) return null;
  return {
    name,
    path: command.sourceInfo.path,
    baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
