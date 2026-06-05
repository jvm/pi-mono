import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const INIT_PROMPT = readFileSync(
  join(__dirname, "../prompts/init.md"),
  "utf8",
);
