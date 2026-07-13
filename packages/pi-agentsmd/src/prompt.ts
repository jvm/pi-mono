import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_OVERWRITE_INSTRUCTION =
  "Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.";
const FORCE_OVERWRITE_INSTRUCTION =
  "The user explicitly invoked /init with --force. Replace AGENTS.md in the current working directory, even if it already exists. Do not modify any other existing files.";

export const INIT_PROMPT = readFileSync(
  join(__dirname, "../prompts/init.md"),
  "utf8",
);

export const FORCE_INIT_PROMPT = INIT_PROMPT.replace(
  NO_OVERWRITE_INSTRUCTION,
  FORCE_OVERWRITE_INSTRUCTION,
);

if (FORCE_INIT_PROMPT === INIT_PROMPT) {
  throw new Error("Init prompt no-overwrite instruction is missing.");
}
