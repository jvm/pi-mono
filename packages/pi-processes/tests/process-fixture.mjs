import { fixture as dcgFixture } from "../../pi-dcg/tests/session-fixture.mjs";

export { textOf, deferred } from "../../pi-dcg/tests/session-fixture.mjs";

/** Exercise the real bash override, not the DCG fixture's synthetic shell. */
export async function fixture(t, options = {}) {
  return dcgFixture(t, { ...options, omitShell: true });
}

/**
 * Resolve once `check` passes, re-checking only when `subscribe` reports a
 * change. Tests wait for the event they depend on instead of a polling window;
 * the test's own timeout bounds a missing event.
 */
export function until(subscribe, check) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe;
    // Production refresh timers are unref'd; keep the loop alive while waiting
    // so they can fire. This never re-checks or resolves anything itself.
    const keepAlive = setInterval(() => {}, 1 << 30);
    const finish = () => { settled = true; clearInterval(keepAlive); unsubscribe?.(); };
    const evaluate = () => {
      if (settled) return;
      let passed;
      try { passed = check(); } catch (error) { finish(); reject(error); return; }
      if (!passed) return;
      finish();
      resolve();
    };
    unsubscribe = subscribe(evaluate);
    if (settled) unsubscribe?.();
    else evaluate();
  });
}

/** A change signal for callbacks a test observes directly. */
export function changes() {
  const listeners = new Set();
  return {
    notify() { for (const listener of [...listeners]) listener(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
