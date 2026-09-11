import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/sync-codex-prompt.yml", import.meta.url),
  "utf8",
);

test("Codex prompt monitor fetches the relocated upstream asset", () => {
  const fetchStep = workflow.split("- name: Fetch original prompt from Codex")[1]?.split("- name:")[0];
  assert.ok(fetchStep, "The workflow must retain the fetch step");
  assert.match(
    fetchStep,
    /curl -fsSL -o \/tmp\/codex-prompt\.md \\\n\s+"https:\/\/raw\.githubusercontent\.com\/openai\/codex\/main\/codex-rs\/tui\/assets\/prompt_for_init_command\.md"/,
  );
});

test("Codex prompt monitor issue links use the relocated upstream asset", () => {
  const links = workflow.match(/https:\/\/github\.com\/openai\/codex\/blob\/main\/[^)\s]+/g);
  assert.deepEqual(links, Array(2).fill(
    "https://github.com/openai/codex/blob/main/codex-rs/tui/assets/prompt_for_init_command.md",
  ));
  assert.ok(!workflow.includes("tui/prompt_for_init_command.md"));
});
