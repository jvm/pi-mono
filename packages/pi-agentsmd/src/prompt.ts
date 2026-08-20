import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_OVERWRITE_INSTRUCTION =
  "If AGENTS.md already exists in the current working directory, do not modify it. Tell the user to run /init --force.";
const FORCE_OVERWRITE_INSTRUCTION =
  "The user explicitly invoked /init with --force. If AGENTS.md already exists in the current working directory, update it carefully: preserve accurate repository-specific guidance, correct stale information, and remove duplication. Do not discard useful human-authored instructions or modify any other file.";

const BASE_INIT_PROMPT = readFileSync(
  join(__dirname, "../prompts/init.md"),
  "utf8",
);

export const INIT_PROMPT = `${BASE_INIT_PROMPT.trimEnd()}\n\n${NO_OVERWRITE_INSTRUCTION}\n`;
export const FORCE_INIT_PROMPT = `${BASE_INIT_PROMPT.trimEnd()}\n\n${FORCE_OVERWRITE_INSTRUCTION}\n`;
