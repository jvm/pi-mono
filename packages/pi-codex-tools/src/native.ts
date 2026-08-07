import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * POSIX *at bindings for descriptor-relative filesystem walks. macOS has no
 * procfs, so the TOCTOU-safe walk used by apply_patch (open each directory
 * component relative to a trusted parent fd with O_NOFOLLOW) needs openat /
 * mkdirat / unlinkat. Node does not expose these, so a tiny N-API addon
 * provides them on darwin. Linux keeps its /proc/self/fd path and never loads
 * this binding.
 */
export interface OpenAtBindings {
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: string, mode: number): void;
  unlinkat(dirfd: number, path: string): void;
  lstatAt(dirfd: number, path: string): { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };
}

let cached: OpenAtBindings | null | undefined;

/** Returns the native *at bindings on darwin, or null on any other platform / load failure. */
export function getOpenAtBindings(): OpenAtBindings | null {
  if (cached !== undefined) return cached;
  if (process.platform !== "darwin") {
    cached = null;
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const resolveBinding = require("node-gyp-build") as (dir: string) => unknown;
    // native.ts lives in src/; the binding (build/ or prebuilds/) ships at the package root.
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const addon = resolveBinding(packageRoot) as OpenAtBindings;
    cached = typeof addon?.openat === "function" ? addon : null;
  } catch {
    cached = null;
  }
  return cached;
}
