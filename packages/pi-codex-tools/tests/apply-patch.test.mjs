import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, lstat, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.CI = "1";

const { applyPatch, MAX_TARGET_FILE_BYTES, parseApplyPatch } = await import("../src/apply-patch.ts");

const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
const applyTest = (name, fn) => test(name, { timeout: 10_000 }, fn);

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

applyTest("applies move hunks by writing the destination and removing the source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "source.txt"), "old\n");
    await applyPatch(
      patch(`*** Update File: source.txt
*** Move to: destination.txt
@@
-old
+new`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new\n");
    await assert.rejects(readFile(join(cwd, "source.txt")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("allows Add File to overwrite an existing regular file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "existing.txt"), "old\n");
    await applyPatch(
      patch(`*** Add File: existing.txt
+new`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "new\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("keeps Codex pure additions at the end of the file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "first\nsecond\n");
    await applyPatch(
      patch(`*** Update File: file.txt
@@ first
+inserted`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "first\nsecond\ninserted\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("preflights repeated Add File and Update File hunks sequentially", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await applyPatch(
      patch(`*** Add File: repeated.txt
+one
*** Update File: repeated.txt
@@
-one
+two`),
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "repeated.txt"), "utf8"), "two\n");
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

applyTest("writes through symlinked parents outside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-codex-tools-outside-"));
  try {
    await writeFile(join(outside, "victim.txt"), "safe\n");
    await symlink(outside, join(cwd, "link"));
    await applyPatch(patch(`*** Add File: link/victim.txt
+overwritten
*** Add File: link/nested/new.txt
+created`), { cwd });
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "overwritten\n");
    assert.equal(await readFile(join(outside, "nested/new.txt"), "utf8"), "created\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

applyTest("deletes unreadable mode-000 files", async () => {
  // root bypasses file permissions, so the bug would not manifest; skip to keep the test honest.
  if (process.getuid && process.getuid() === 0) return;
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  const target = join(cwd, "locked.txt");
  try {
    await writeFile(target, "x");
    await chmod(target, 0o000);
    const result = await applyPatch(patch(`*** Delete File: locked.txt`), { cwd });
    assert.deepEqual(result.changes.map((change) => change.kind), ["deleted"]);
    await assert.rejects(readFile(target));
  } finally {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("allows relative and absolute paths outside the current working directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  const cwd = join(parent, "cwd");
  try {
    await mkdir(cwd);
    await writeFile(join(parent, "outside.txt"), "old\n");
    const absolute = join(parent, "absolute.txt");

    await applyPatch(
      patch(`*** Update File: ../outside.txt
@@
-old
+updated
*** Add File: ${absolute}
+created`),
      { cwd },
    );

    assert.equal(await readFile(join(parent, "outside.txt"), "utf8"), "updated\n");
    assert.equal(await readFile(absolute, "utf8"), "created\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

applyTest("does not partially apply a patch when preflight fails", async () => {
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
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("updates and overwrites file symlinks without replacing the link", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "target"), "old\n");
    await symlink("target", join(cwd, "link"));
    await applyPatch(patch(`*** Update File: link
@@
-old
+updated`), { cwd });
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "updated\n");
    await applyPatch(patch(`*** Add File: link
+overwritten`), { cwd });
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "overwritten\n");
    assert.ok((await lstat(join(cwd, "link"))).isSymbolicLink());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("preflights aliases as one file without acquiring the same queue twice", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "target"), "old\n");
    await symlink("target", join(cwd, "link"));
    await applyPatch(patch(`*** Update File: link
@@
-old
+first
*** Update File: target
@@
-first
+second`), { cwd });
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "second\n");
    await assert.rejects(applyPatch(patch(`*** Update File: link
*** Move to: target
@@
-second
+bad`), { cwd }), /onto itself/);
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "second\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("creates through dangling relative symlinks and shares virtual content with their targets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await symlink("target", join(cwd, "link"));
    await applyPatch(patch(`*** Add File: link
+first
*** Update File: target
@@
-first
+second`), { cwd });
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "second\n");
    assert.ok((await lstat(join(cwd, "link"))).isSymbolicLink());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("deletes links rather than referents, including dangling links", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "target"), "old\n");
    await symlink("target", join(cwd, "link"));
    await symlink("missing", join(cwd, "dangling"));
    await applyPatch(patch(`*** Delete File: link
*** Delete File: dangling
*** Update File: target
@@
-old
+retained
*** Add File: link
+new regular file`), { cwd });
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "retained\n");
    assert.equal(await readFile(join(cwd, "link"), "utf8"), "new regular file\n");
    assert.equal((await lstat(join(cwd, "link"))).isSymbolicLink(), false);
    await assert.rejects(lstat(join(cwd, "dangling")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("moves from and into symlinks without deleting the source referent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "source-target"), "old\n");
    await writeFile(join(cwd, "dest-target"), "other\n");
    await symlink("source-target", join(cwd, "source"));
    await symlink("dest-target", join(cwd, "dest"));
    await applyPatch(patch(`*** Update File: source
*** Move to: dest
@@
-old
+moved`), { cwd });
    assert.equal(await readFile(join(cwd, "source-target"), "utf8"), "old\n");
    assert.equal(await readFile(join(cwd, "dest-target"), "utf8"), "moved\n");
    assert.ok((await lstat(join(cwd, "dest"))).isSymbolicLink());
    await assert.rejects(lstat(join(cwd, "source")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("rejects symlink loops and directory targets before any writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await symlink("loop", join(cwd, "loop"));
    await mkdir(join(cwd, "directory"));
    await symlink("directory", join(cwd, "dir-link"));
    for (const path of ["loop", "dir-link"]) {
      await assert.rejects(applyPatch(patch(`*** Add File: untouched
+not written
*** Add File: ${path}
+bad`), { cwd }), /Too many symbolic links|non-file/);
      await assert.rejects(lstat(join(cwd, "untouched")), { code: "ENOENT" });
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(applyPatch(patch(`*** Add File: untouched
+not written`), { cwd, signal: controller.signal }), /aborted/);
    await assert.rejects(lstat(join(cwd, "untouched")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("resolves dot-dot in stored symlink targets after following earlier links", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await mkdir(join(cwd, "real", "child"), { recursive: true });
    await symlink(join(cwd, "real", "child"), join(cwd, "directory-link"));
    await symlink("directory-link/../target", join(cwd, "file-link"));
    await applyPatch(patch(`*** Add File: file-link
+correct target`), { cwd });
    assert.equal(await readFile(join(cwd, "real", "target"), "utf8"), "correct target\n");
    assert.equal(await readFile(join(cwd, "file-link"), "utf8"), "correct target\n");
    await assert.rejects(lstat(join(cwd, "target")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

applyTest("serializes concurrent patches through different aliases", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-"));
  try {
    await writeFile(join(cwd, "target"), "original\n");
    await symlink("target", join(cwd, "link"));
    await Promise.all([
      applyPatch(patch(`*** Update File: link
@@
+first`), { cwd }),
      applyPatch(patch(`*** Update File: target
@@
+second`), { cwd }),
    ]);
    assert.deepEqual((await readFile(join(cwd, "target"), "utf8")).trim().split("\n").sort(), ["first", "original", "second"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const lineEndingCase = async (files, body, expected, missing = []) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-tools-eol-"));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(cwd, name), content);
    await applyPatch(patch(body), { cwd });
    for (const [name, content] of Object.entries(expected)) {
      assert.equal(await readFile(join(cwd, name), "utf8"), content, name);
    }
    for (const name of missing) await assert.rejects(lstat(join(cwd, name)), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

applyTest("keeps LF endings in a pure LF file", () =>
  lineEndingCase(
    { "f.txt": "a\nb\nc\n" },
    `*** Update File: f.txt
@@
 a
-b
+B
+B2
 c`,
    { "f.txt": "a\nB\nB2\nc\n" },
  ));

applyTest("keeps CRLF endings in a pure CRLF file, including appended lines", () =>
  lineEndingCase(
    { "f.txt": "a\r\nb\r\nc\r\n" },
    `*** Update File: f.txt
@@
-a
+A
@@
 c
+d`,
    { "f.txt": "A\r\nb\r\nc\r\nd\r\n" },
  ));

applyTest("keeps untouched endings byte-for-byte in a mixed-ending file", () =>
  lineEndingCase(
    { "f.txt": "lf1\ncrlf1\r\nlf2\ncrlf2\r\nlf3\nlone\rcr\n" },
    `*** Update File: f.txt
@@
 crlf1
-lf2
+changed
+inserted
 crlf2`,
    { "f.txt": "lf1\ncrlf1\r\nchanged\ninserted\ncrlf2\r\nlf3\nlone\rcr\n" },
  ));

applyTest("gives replaced lines the first removed line's ending and keeps interior context", () =>
  lineEndingCase(
    { "f.txt": "one\ntwo\r\nkeep\nthree\r\nfour\n" },
    `*** Update File: f.txt
@@
 one
-two
+TWO
 keep
-three
+THREE
 four`,
    { "f.txt": "one\nTWO\r\nkeep\nTHREE\r\nfour\n" },
  ));

applyTest("gives pure insertions the ending of the line before them", () =>
  lineEndingCase(
    { "f.txt": "head\r\nmid\ntail\r\n" },
    `*** Update File: f.txt
@@
 head
+after-head
 mid
+after-mid
 tail`,
    { "f.txt": "head\r\nafter-head\r\nmid\nafter-mid\ntail\r\n" },
  ));

applyTest("gives insertions at the start of a file the ending of the following line", () =>
  lineEndingCase(
    { "f.txt": "first\r\nsecond\n" },
    `*** Update File: f.txt
@@
+zero
 first`,
    { "f.txt": "zero\r\nfirst\r\nsecond\n" },
  ));

applyTest("keeps a missing trailing newline when the last line is untouched", () =>
  lineEndingCase(
    { "f.txt": "a\r\nb\nlast", "g.txt": "only" },
    `*** Update File: f.txt
@@
-a
+A
 b
*** Update File: g.txt
@@
-only
+changed`,
    { "f.txt": "A\r\nb\nlast", "g.txt": "changed\n" },
  ));

applyTest("terminates a final line without newline when lines are appended after it", () =>
  lineEndingCase(
    { "f.txt": "a\r\nb" },
    `*** Update File: f.txt
@@
 b
+c
*** End of File`,
    { "f.txt": "a\r\nb\r\nc\r\n" },
  ));

applyTest("preserves mixed endings across move, add, and delete operations", () =>
  lineEndingCase(
    { "src.txt": "﻿x\r\ny\nz\r\n", "gone.txt": "bye\r\n" },
    `*** Update File: src.txt
*** Move to: dst.txt
@@
 x
-y
+Y
 z
*** Add File: new.txt
+fresh
*** Delete File: gone.txt`,
    { "dst.txt": "﻿x\r\nY\nz\r\n", "new.txt": "fresh\n" },
    ["src.txt", "gone.txt"],
  ));
