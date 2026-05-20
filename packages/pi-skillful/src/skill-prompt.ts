import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

export const SKILLS_SECTION_PATTERN = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

export function replaceSkillsSection(systemPrompt: string, skills: Skill[]): string | undefined {
  const next = systemPrompt.replace(SKILLS_SECTION_PATTERN, formatSkillsForPrompt(skills));
  return next === systemPrompt ? undefined : next;
}
