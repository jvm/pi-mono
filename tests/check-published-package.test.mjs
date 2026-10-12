import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { alreadyPublished, checkWorkspace } from "../scripts/check-published-package.mjs";

const pack = { name: "@mocito/example", version: "0.1.0", integrity: "sha512-test" };
const response = (status, metadata) => async () => new Response(JSON.stringify(metadata), { status });

test("only 404 is treated as an unpublished version", async () => {
  assert.equal(await alreadyPublished(pack, response(404, {})), false);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(alreadyPublished(pack, response(status, {})), /Registry lookup failed/);
  }
  await assert.rejects(alreadyPublished(pack, async () => { throw new Error("offline"); }), /offline/);
});

test("existing versions require matching identity and sha512 integrity", async () => {
  const metadata = { name: pack.name, version: pack.version, dist: { integrity: pack.integrity } };
  assert.equal(await alreadyPublished(pack, response(200, metadata)), true);
  for (const changed of [
    { ...metadata, name: "other" }, { ...metadata, version: "0.2.0" },
    { ...metadata, dist: {} }, { ...metadata, dist: { integrity: "sha512-different" } },
  ]) {
    await assert.rejects(alreadyPublished(pack, response(200, changed)), /artifact differs/);
  }
});

test("registry lookup uses encoded identity, a timeout, and no redirects", async () => {
  await alreadyPublished(pack, async (url, options) => {
    assert.equal(url, "https://registry.npmjs.org/%40mocito%2Fexample/0.1.0");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, "error");
    return new Response("{}", { status: 404 });
  });
});

test("release check packs the real workspace and workflow gates publication", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/pi-processes/package.json", import.meta.url), "utf8"));
  const result = await checkWorkspace("packages/pi-processes", async (url) => {
    assert.equal(url, `https://registry.npmjs.org/pi-processes/${manifest.version}`);
    return new Response("{}", { status: 404 });
  });
  assert.equal(result.published, false);
  assert.match(result.pack.integrity, /^sha512-/);
  assert.ok(result.pack.files.some(file => file.path === "src/transport.ts"));
  assert.ok(!result.pack.files.some(file => file.path.startsWith("tests/")));
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/check-published-package\.mjs "\$PACKAGE_DIR"/);
  assert.match(workflow, /if: steps\.published\.outputs\.already_published != 'true'/);
  await assert.rejects(checkWorkspace("--unsafe"), /workspace path/);
});
