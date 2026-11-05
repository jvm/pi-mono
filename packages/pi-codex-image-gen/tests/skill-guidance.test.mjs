import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all shared skill guidance requests native alpha instead of chroma-key-first or paid fallback", async () => {
  for (const file of ["SKILL.md", "references/prompting.md", "references/sample-prompts.md"]) {
    const content = await readFile(new URL(`../skills/imagegen/${file}`, import.meta.url), "utf8");
    assert.match(content, /background: "transparent"/, file);
    assert.match(content, /preserve.*alpha|preserv.*transparency/i, file);
    assert.doesNotMatch(content, /prompt for a flat.*chroma|perfectly flat solid #00ff00|Pi tool still uses chroma-key/i, file);
  }
});

test("skill preserves Pi-specific delivery, reference, transport, and quota safeguards", async () => {
  const content = await readFile(new URL("../skills/imagegen/SKILL.md", import.meta.url), "utf8");
  for (const required of ["codex_generate_image_artifact", "codex_list_image_artifacts", "referencedImagePaths",
    'background: "transparent"', "measuredImage", "PNG-only", "read", "Do not automatically repeat"]) {
    assert.ok(content.includes(required), required);
  }
  assert.doesNotMatch(content, /\$CODEX_HOME|generatedImage\(result\)|@exec/);
});
