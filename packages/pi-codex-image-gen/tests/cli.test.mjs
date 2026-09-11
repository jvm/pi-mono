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
  const edit = cli(["edit", "--image", image, "--prompt", "test", "--model", "gpt-image-2.5-sunburst", "--quality", "max", "--size", "1536x864"]);
  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(JSON.parse(edit.stdout).quality, "max");
  assert.equal(JSON.parse(edit.stdout).size, "1536x864");
  const jobs = join(cwd, "jobs.jsonl");
  writeFileSync(jobs, JSON.stringify({ prompt: "test", model: "gpt-image-2.5-flare", quality: "xhigh", size: "3840x2160" }));
  const batch = cli(["generate-batch", "--input", jobs, "--out-dir", join(cwd, "out")]);
  assert.equal(batch.status, 0, batch.stderr);
  assert.match(batch.stdout, /"quality": "xhigh"/);
  assert.match(batch.stdout, /"size": "3840x2160"/);
  writeFileSync(jobs, JSON.stringify({ prompt: "test", model: "gpt-image-2", quality: "max" }));
  assert.notEqual(cli(["generate-batch", "--input", jobs, "--out-dir", join(cwd, "out")]).status, 0);
});

test("CLI recognizes documented 2.5 custom sizes and snapshot IDs", () => {
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare-2026-09-08", "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2-2026-04-21"]) {
    const result = cli(["generate", "--prompt", "test", "--model", model, "--size", "1536x864"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).size, "1536x864");
  }
  for (const size of ["1024x640", "3840x2160", "3840x1280"]) {
    assert.equal(cli(["generate", "--prompt", "test", "--model", "gpt-image-2.5-flare", "--size", size]).status, 0);
  }
});

test("CLI rejects invalid 2.5 dimensions and keeps older models on standard sizes", () => {
  for (const [size, message] of [
    ["3841x2160", /maximum edge/],
    ["1000x1000", /multiples of 16/],
    ["1024x320", /ratio/],
    ["256x256", /total pixels/],
    ["3840x3840", /total pixels/],
    ["not-a-size", /WIDTHxHEIGHT/],
  ]) {
    const result = cli(["generate", "--prompt", "test", "--model", "gpt-image-2.5-sunburst", "--size", size]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  const legacy = cli(["generate", "--prompt", "test", "--model", "gpt-image-1.5", "--size", "1536x864"]);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /one of/);
});
