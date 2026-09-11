import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../skills/imagegen/scripts/image_gen.py", import.meta.url));

// Standard-library-only dry runs: no SDK, API key, or network access needed.
// Use python3 directly so the package test also runs on CI without uv installed.
function cli(args) {
  const result = spawnSync("python3", [script, ...args, "--dry-run"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, OPENAI_API_KEY: "" },
  });
  assert.ifError(result.error);
  return result;
}

test("CLI accepts both Images 2.5 models and snapshots with extended quality", () => {
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare-2026-09-08", "gpt-image-2.5-sunburst-2026-09-08"]) {
    for (const quality of ["xhigh", "max"]) {
      const result = cli(["generate", "--prompt", "test", "--model", model, "--quality", quality]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.model, model);
      assert.equal(payload.quality, quality);
    }
  }
});

test("CLI preserves defaults and rejects extended quality for older or unknown models", () => {
  const result = cli(["generate", "--prompt", "test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).model, "gpt-image-2");
  for (const model of ["gpt-image-2", "gpt-image-1.5", "gpt-image-2.5-unknown"]) {
    const rejected = cli(["generate", "--prompt", "test", "--model", model, "--quality", "max"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /quality/);
  }
});

test("CLI allows GPT Image 2 transparent PNG/WebP but rejects JPEG", () => {
  for (const format of ["png", "webp", "jpeg"]) {
    const result = cli(["generate", "--prompt", "test", "--background", "transparent", "--output-format", format]);
    if (format === "jpeg") {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /transparent background requires/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).background, "transparent");
    }
  }
});

test("CLI edit and batch paths retain Images 2.5 quality controls", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "imagegen-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const image = join(cwd, "input.png");
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const edit = cli(["edit", "--image", image, "--prompt", "test", "--model", "gpt-image-2.5-sunburst", "--quality", "max"]);
  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(JSON.parse(edit.stdout).quality, "max");
  const jobs = join(cwd, "jobs.jsonl");
  writeFileSync(jobs, JSON.stringify({ prompt: "test", model: "gpt-image-2.5-flare", quality: "xhigh" }));
  const batch = cli(["generate-batch", "--input", jobs, "--out-dir", join(cwd, "out")]);
  assert.equal(batch.status, 0, batch.stderr);
  assert.match(batch.stdout, /"quality": "xhigh"/);
  writeFileSync(jobs, JSON.stringify({ prompt: "test", model: "gpt-image-2", quality: "max" }));
  assert.notEqual(cli(["generate-batch", "--input", jobs, "--out-dir", join(cwd, "out")]).status, 0);
});
