import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DCG_TIMEOUT_MS,
  MAX_DCG_OUTPUT_BYTES,
  loadDcgBridgeConfig,
} from "../src/config.ts";

test("loads secure bridge defaults", () => {
  const config = loadDcgBridgeConfig({}, "/home/tester");
  assert.deepEqual(config, {
    binary: "dcg",
    timeoutMs: DEFAULT_DCG_TIMEOUT_MS,
    maxOutputBytes: MAX_DCG_OUTPUT_BYTES,
    onError: "allow",
    guardUserBash: true,
  });
});

test("prefers PI_DCG_BIN, expands home, and accepts block mode", () => {
  const config = loadDcgBridgeConfig({
    PI_DCG_BIN: "~/.local/bin/dcg",
    DCG_BIN: "/ignored/dcg",
    PI_DCG_TIMEOUT_MS: "9000",
    PI_DCG_ON_ERROR: "BLOCK",
    PI_DCG_GUARD_USER_BASH: "false",
  }, "/home/tester");

  assert.equal(config.binary, "/home/tester/.local/bin/dcg");
  assert.equal(config.timeoutMs, 9000);
  assert.equal(config.onError, "block");
  assert.equal(config.guardUserBash, false);
});

test("falls back to DCG_BIN and keeps literal command names", () => {
  assert.equal(loadDcgBridgeConfig({ DCG_BIN: "custom-dcg" }, "/home/tester").binary, "custom-dcg");
});

test("uses safe defaults for invalid values", () => {
  const config = loadDcgBridgeConfig({
    PI_DCG_TIMEOUT_MS: "99",
    PI_DCG_ON_ERROR: "explode",
    PI_DCG_GUARD_USER_BASH: "yes",
  }, "/home/tester");

  assert.equal(config.timeoutMs, DEFAULT_DCG_TIMEOUT_MS);
  assert.equal(config.onError, "allow");
  assert.equal(config.guardUserBash, true);
});
