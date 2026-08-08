import assert from "node:assert/strict";
import { openSync, closeSync, mkdtempSync, symlinkSync, rmSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { getOpenAtBindings } = await import("../src/native.ts");
const binding = getOpenAtBindings();

// The binding is darwin-only; on other platforms getOpenAtBindings() returns null and these skip.
test("openat surfaces the syscall errno, not one clobbered by free()", { skip: process.platform !== "darwin" }, () => {
  assert.ok(binding, "Expected the Darwin native binding to load");
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-tools-native-"));
  let dirfd;
  try {
    dirfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);

    // Missing path -> ENOENT. Guards that errno captured before free(path) is what is thrown.
    assert.throws(
      () => binding.openat(dirfd, "missing", constants.O_RDONLY | constants.O_NOFOLLOW, 0),
      (error) => error.code === "ENOENT",
    );

    // Symlink with O_NOFOLLOW is rejected; macOS reports ELOOP (ENOTDIR when O_DIRECTORY is also set).
    symlinkSync("/etc", join(dir, "lnk"));
    assert.throws(
      () => binding.openat(dirfd, "lnk", constants.O_RDONLY | constants.O_NOFOLLOW, 0),
      (error) => error.code === "ELOOP" || error.code === "ENOTDIR",
    );
  } finally {
    if (dirfd !== undefined) closeSync(dirfd);
    rmSync(dir, { recursive: true, force: true });
  }
});
