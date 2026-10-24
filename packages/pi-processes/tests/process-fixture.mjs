import { fixture as dcgFixture } from "../../pi-dcg/tests/session-fixture.mjs";

export { textOf, deferred } from "../../pi-dcg/tests/session-fixture.mjs";

/** Exercise the real bash override, not the DCG fixture's synthetic shell. */
export async function fixture(t, options = {}) {
  return dcgFixture(t, { ...options, omitShell: true });
}
