import assert from "node:assert/strict";
import test from "node:test";

const { scanPatchPreview } = await import("../src/patch-preview.ts");

function findFile(preview, path) {
  return preview.files.find((file) => file.path === path);
}

test("returns no files for an empty or header-only patch", () => {
  assert.deepEqual(scanPatchPreview("").files, []);
  assert.deepEqual(scanPatchPreview("*** Begin Patch").files, []);
});

test("does not throw on a truncated/partial patch body", () => {
  // Missing "*** End Patch"; a file header is mid-stream. Must not throw.
  const preview = scanPatchPreview("*** Begin Patch\n*** Update File: src/f");
  assert.equal(preview.files.length, 1);
  assert.equal(findFile(preview, "src/f").kind, "update");
});

test("counts added lines for a new (Add File) hunk", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Add File: lib/new.ts",
      "+export const x = 1;",
      "+export const y = 2;",
      "*** End Patch",
    ].join("\n"),
  );
  const file = findFile(preview, "lib/new.ts");
  assert.equal(file.kind, "add");
  assert.equal(file.lines.length, 2);
  assert.deepEqual(file.lines.map((line) => line.type), ["add", "add"]);
  assert.equal(preview.totalAdded, 2);
  assert.equal(preview.totalRemoved, 0);
});

test("counts added, removed, and context lines for an update hunk", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ context line here",
      " unchanged",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n"),
  );
  const file = findFile(preview, "src/app.ts");
  assert.equal(file.kind, "update");
  assert.equal(file.lines.length, 3);
  assert.deepEqual(
    file.lines.map((line) => line.type),
    ["ctx", "del", "add"],
  );
  assert.equal(file.lines[0].text, "unchanged");
  assert.equal(file.lines[1].text, "old line");
  assert.equal(file.lines[2].text, "new line");
  assert.equal(preview.totalAdded, 1);
  assert.equal(preview.totalRemoved, 1);
});

test("treats @@ and '@@ text' as chunk headers, not content", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "+first",
      "@@ another anchor",
      "+second",
      "*** End Patch",
    ].join("\n"),
  );
  const file = findFile(preview, "a.txt");
  assert.equal(file.lines.length, 2);
  assert.deepEqual(file.lines.map((line) => line.text), ["first", "second"]);
});

test("records a delete hunk with no diff lines", () => {
  const preview = scanPatchPreview(
    ["*** Begin Patch", "*** Delete File: stale.log", "*** End Patch"].join("\n"),
  );
  const file = findFile(preview, "stale.log");
  assert.equal(file.kind, "delete");
  assert.equal(file.lines.length, 0);
  // Deletes contribute no +/- tallies (the patch carries no content for them).
  assert.equal(preview.totalAdded, 0);
  assert.equal(preview.totalRemoved, 0);
});

test("aggregates counts across multiple files", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+a1",
      "+a2",
      "*** Update File: b.ts",
      "-b1",
      "+b2",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n"),
  );
  assert.equal(preview.files.length, 3);
  assert.equal(preview.totalAdded, 3);
  assert.equal(preview.totalRemoved, 1);
});

test("ignores Move-to headers without creating a phantom file", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Update File: old.ts",
      "*** Move to: new.ts",
      "@@ ctx",
      "+x",
      "*** End Patch",
    ].join("\n"),
  );
  assert.equal(preview.files.length, 1);
  assert.equal(findFile(preview, "new.ts"), undefined);
  assert.equal(findFile(preview, "old.ts").lines.length, 1);
});

test("re-scans fresh each call: a growing prefix does not double-count", () => {
  const head = "*** Begin Patch\n*** Add File: a.ts\n+one\n";
  const partial = scanPatchPreview(head);
  const grown = scanPatchPreview(head + "+two\n");
  assert.equal(partial.totalAdded, 1);
  assert.equal(grown.totalAdded, 2);
  assert.equal(partial.files[0].lines.length, 1);
  assert.equal(grown.files[0].lines.length, 2);
});

test("normalizes CRLF line endings before classifying lines", () => {
  const preview = scanPatchPreview("*** Begin Patch\r\n*** Add File: a.ts\r\n+hello\r\n*** End Patch");
  const file = findFile(preview, "a.ts");
  assert.equal(file.lines.length, 1);
  assert.equal(file.lines[0].type, "add");
  assert.equal(file.lines[0].text, "hello");
});

test("stops scanning at *** End Patch: trailing content does not skew totals", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+real",
      "*** End Patch",
      "+phantom added after terminator",
      "-phantom removed after terminator",
      "*** Update File: phantom.ts",
      "+more",
    ].join("\n"),
  );
  assert.equal(preview.files.length, 1);
  assert.equal(preview.totalAdded, 1);
  assert.equal(preview.totalRemoved, 0);
  assert.equal(findFile(preview, "phantom.ts"), undefined);
});

test("bounds a runaway patch: marks truncated and caps retained files", () => {
  const manyFiles = Array.from({ length: 2000 }, (_, i) => `*** Add File: f${i}.ts\n+x`).join("\n");
  const preview = scanPatchPreview(`*** Begin Patch\n${manyFiles}\n*** End Patch`);
  assert.equal(preview.truncated, true);
  assert.ok(preview.files.length <= 500, `expected <= 500 files, got ${preview.files.length}`);
});

test("marks truncated when the byte ceiling is exceeded", () => {
  const big = "+" + "x".repeat(300 * 1024);
  const preview = scanPatchPreview(`*** Begin Patch\n*** Add File: huge.txt\n${big}\n*** End Patch`);
  assert.equal(preview.truncated, true);
  assert.ok(preview.files.length >= 1);
});

test("single-file delete header shows the D status mark", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const out = formatApplyPatchCallText(
    ["*** Begin Patch", "*** Delete File: stale.log", "*** End Patch"].join("\n"),
    theme,
    { expanded: false },
  ).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /D stale\.log/);
});

test("captures Move-to destination and renders the source -> destination transition", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { scanPatchPreview, formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/old.ts",
    "*** Move to: src/new.ts",
    "@@ ctx",
    "+x",
    "*** End Patch",
  ].join("\n");
  const preview = scanPatchPreview(patch);
  assert.equal(preview.files.length, 1);
  assert.equal(findFile(preview, "src/old.ts").moveTo, "src/new.ts");
  const out = formatApplyPatchCallText(patch, theme, { expanded: false }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /src\/old\.ts -> src\/new\.ts/);
});

test("coalesces multiple update hunks for the same path into one file", () => {
  const preview = scanPatchPreview(
    [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ a",
      "+one",
      "*** Update File: src/app.ts",
      "@@ b",
      "+two",
      "*** End Patch",
    ].join("\n"),
  );
  assert.equal(preview.files.length, 1, "same-path hunks must not duplicate roster rows");
  assert.equal(findFile(preview, "src/app.ts").lines.length, 2);
  assert.equal(preview.totalAdded, 2);
});

test("collapsed multi-file roster is capped; expansion reveals the rest", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const hunks = Array.from({ length: 25 }, (_, i) => `*** Add File: f${i}.ts\n+x`).join("\n");
  const patch = `*** Begin Patch\n${hunks}\n*** End Patch`;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const collapsed = strip(formatApplyPatchCallText(patch, theme, { expanded: false }));
  const expanded = strip(formatApplyPatchCallText(patch, theme, { expanded: true }));
  assert.match(collapsed, /… 15 more files/);
  // The roster (before the blank-line-separated glimpse) is capped at 10.
  const [rosterSection] = collapsed.split("\n\n");
  const rosterRows = rosterSection.split("\n").filter((l) => /^A f\d+\.ts/.test(l)).length;
  assert.ok(rosterRows <= 10, `roster should be capped, got ${rosterRows}`);
  // Expanded still lists every file in the roster (hard-capped at MAX_PREVIEW_FILES);
  // the focus label lives in the glimpse section, not the roster.
  const expandedRoster = expanded.split("\n\n")[0];
  const expandedRows = expandedRoster.split("\n").filter((l) => /^A f\d+\.ts/.test(l)).length;
  assert.equal(expandedRows, 25);
});

test("the focused file labels the glimpse even when hidden behind the roster cap", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const hunks = Array.from({ length: 25 }, (_, i) => `*** Add File: f${i}.ts\n+x`).join("\n");
  const patch = `*** Begin Patch\n${hunks}\n*** End Patch`;
  const out = formatApplyPatchCallText(patch, theme, { expanded: false }).replace(/\x1b\[[0-9;]*m/g, "");
  const [, glimpse] = out.split("\n\n");
  // focusFile picks f24 (latest with content), which is NOT in the capped roster (f0..f9).
  assert.ok(glimpse.includes("f24.ts"), "the hidden focused file should label the glimpse");
});

test("truncates unusually long file paths", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const longPath = `${"p".repeat(300)}.ts`;
  const patch = `*** Begin Patch\n*** Add File: ${longPath}\n+x\n*** End Patch`;
  const out = formatApplyPatchCallText(patch, theme, { expanded: false }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(out.includes("…"), "long path should be truncated");
  assert.ok(!out.includes(longPath), "the full path must not be rendered");
  assert.ok(out.includes(".ts"), "the filename/extension should be preserved");
});

test("glimpse lines carry no fabricated line numbers", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const patch = ["*** Begin Patch", "*** Update File: a.ts", "@@ ctx", "-old", "+new", "*** End Patch"].join("\n");
  const out = formatApplyPatchCallText(patch, theme, { expanded: false }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /^-old$/m);
  assert.match(out, /^\+new$/m);
  // No synthetic "-1"/"+2" gutter numbers.
  assert.doesNotMatch(out, /[-+]\d+ (old|new)/);
});

test("caps a single very long glimpse line", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { formatApplyPatchCallText } = await import("../src/patch-preview.ts");
  initTheme("dark");
  const theme = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
  const long = "x".repeat(2000);
  const patch = `*** Begin Patch\n*** Add File: min.json\n+${long}\n*** End Patch`;
  const out = formatApplyPatchCallText(patch, theme, { expanded: false }).replace(/\x1b\[[0-9;]*m/g, "");
  const glimpseLine = out.split("\n").find((l) => l.startsWith("+"));
  assert.ok(glimpseLine.length < long.length, "long line should be truncated");
  assert.ok(glimpseLine.endsWith("…"), "truncated line should end with an ellipsis");
});
