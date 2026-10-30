import assert from "node:assert/strict";
import test from "node:test";
import { admitGeneration } from "../.test-dist/src/admission.js";

test("cancelled queued generation cannot dispatch; admission is bounded and account-local", async () => {
  const signal = new AbortController().signal;
  const releaseA = await admitGeneration("fixture-account", signal);
  const releaseB = await admitGeneration("fixture-account", signal);
  const cancelled = new AbortController();
  const pending = admitGeneration("fixture-account", cancelled.signal);
  const other = await admitGeneration("different-account", signal);
  other();
  cancelled.abort();
  await assert.rejects(pending, /No generation request/);
  releaseA();
  releaseB();
  const release = await admitGeneration("fixture-account", signal);
  release();
});
