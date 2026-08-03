import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.CI = "1";

const { applyPatch, MAX_TARGET_FILE_BYTES, parseApplyPatch } = await import("../src/apply-patch.ts");

const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
const supportsSecureFilesystem = process.platform === "linux" || process.platform === "darwin";
const applyTest = (name, fn) => test(name, { skip: !supportsSecureFilesystem }, fn);

test("parses Codex add, delete, update, and move hunks", () => {
  assert.deepEqual(
    parseApplyPatch(
      patch(`*** Add File: add.txt
+one
+two
*** Delete File: delete.txt
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new`),
    ),
    [
      { kind: "add", path: "add.txt", content: "one\ntwo\n" },
      { kind: "delete", path: "delete.txt" },
      {
        kind: "update",
        path: "old.txt",
        moveTo: "new.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], endOfFile: false }],
      },
    ],
  );
});

test("fails closed on unsupported filesystems", { skip: supportsSecureFilesystem }, async () => {
  await assert.rejects(applyPatch(patch(`*** Add File: blocked.txt
+blocked`), { cwd: process.cwd() }), /POSIX filesystem/);
});

applyTest("applies a multi-file patch after preflighting all hunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "old.txt"), "first\nsecond\nthird\n");
    await writeFile(join(cwd, "delete.txt"), "gone\n");

    const result = await applyPatch(
      patch(`*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: src/old.txt
@@
 first
-second
+changed
 third
*** Update File: src/old.txt
@@
 third
+last
*** End of File`),
      { cwd },
    );

    assert.deepEqual(result.changes.map(({ kind, path }) => ({ kind, path })), [
      { kind: "added", path: "nested/new.txt" },
      { kind: "deleted", path: "delete.txt" },
      { kind: "updated", path: "src/old.txt" },
    ]);
    assert.equal(await readFile(join(cwd, "nested", "new.txt"), "utf8"), "created\n");
    assert.equal(await readFile(join(cwd, "src", "old.txt"), "utf8"), "first\nchanged\nthird\nlast\n");
    await assert.rejects(readFile(join(cwd, "delete.txt")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("creates a one-newline file for an empty add hunk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await applyPatch(
      patch(`*** Add File: empty.txt
+`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("adds a trailing newline when updating a file without one", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "before");
    await applyPatch(
      patch(`*** Update File: file.txt
@@
-before
+after`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "after\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("keeps indented patch markers as update context lines", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "before\n*** Update File: b.txt\n");
    await applyPatch(
      patch(`*** Update File: file.txt
@@
-before
+after
 *** Update File: b.txt`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "after\n*** Update File: b.txt\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("does not treat an indented End of File line as a control marker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "wrong\nold\n");
    await assert.rejects(
      applyPatch(
        patch(`*** Update File: file.txt
@@
-old
+new
 *** End of File`),
        { cwd },
      ),
      /Failed to find expected lines/,
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "wrong\nold\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("rejects update targets above the file-size limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    const path = join(cwd, "large.txt");
    await writeFile(path, "");
    await truncate(path, MAX_TARGET_FILE_BYTES + 1);
    await assert.rejects(
      applyPatch(
        patch(`*** Update File: large.txt
@@
-old
+new`),
        { cwd },
      ),
      /exceeds the 67108864-byte limit/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("uses Codex's lenient line matching and preserves CRLF endings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "  first  \r\nsecond\r\n");
    await applyPatch(
      patch(`*** Update File: file.txt
@@ first
-second
+changed`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "  first  \r\nchanged\r\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("rejects symlink path escapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-codex-tools-outside-"));
  try {
    await writeFile(join(outside, "victim.txt"), "safe\n");
    await symlink(outside, join(cwd, "link"));
    await assert.rejects(
      applyPatch(patch(`*** Add File: link/victim.txt
+overwritten`), { cwd }),
      /Symlink paths are not allowed|Patch path escapes/,
    );
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "safe\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

applyTest("rejects path escapes and does not partially apply a patch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await assert.rejects(
      applyPatch(
        patch(`*** Add File: created.txt
+must not exist
*** Update File: missing.txt
@@
-old
+new`),
        { cwd },
      ),
      /missing file/,
    );
    await assert.rejects(readFile(join(cwd, "created.txt")));

    await assert.rejects(
      applyPatch(patch(`*** Add File: ../outside.txt
+blocked`), { cwd }),
      /inside the current working directory/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
