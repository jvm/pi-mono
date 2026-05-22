import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { convertReaderInput } from "../src/index.js";
import { parseCommandArgs } from "../extensions/index.js";

test("converts an HTML file to markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reader-"));
  const input = join(dir, "article.html");
  await writeFile(input, `<!doctype html><html><head><title>Hello</title></head><body><article><h1>Hello</h1><p>Readable content.</p></article></body></html>`);

  const result = await convertReaderInput({ input, format: "markdown" });

  assert.equal(result.format, "markdown");
  assert.match(result.text, /# Hello/);
  assert.match(result.text, /Readable content\./);
  assert.equal(result.metadata.title, "Hello");
});

test("writes JSON output without overwriting by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reader-"));
  const input = join(dir, "note.txt");
  const output = join(dir, "note.json");
  await writeFile(input, "hello");

  await convertReaderInput({ input, format: "json", output });
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.content, "hello");

  await assert.rejects(() => convertReaderInput({ input, format: "json", output }), /already exists/);
});

test("parses slash command arguments", () => {
  assert.deepEqual(parseCommandArgs(`"https://example.com/a b" --format json --output out.json --overwrite`), {
    input: "https://example.com/a b",
    format: "json",
    output: "out.json",
    overwrite: true,
  });
});
