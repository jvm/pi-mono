import { fixture as dcgFixture } from "../../pi-dcg/tests/session-fixture.mjs";

export { textOf, deferred } from "../../pi-dcg/tests/session-fixture.mjs";

/** Exercise the real bash override, not the DCG fixture's synthetic shell. */
export async function fixture(t, options = {}) {
  return dcgFixture(t, { ...options, omitShell: true });
}

/**
 * Resolve once `check` passes, re-checking only when `subscribe` reports a
 * change. Tests wait for the event they depend on instead of a polling window.
 * Each wait has its own deadline, shorter than the 30-second test timeout, so a
 * missing event rejects with `describe()` context and always releases the
 * timer and subscription, even when nothing else ends the wait.
 */
export function until(subscribe, check, { timeout = 15_000, describe } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe;
    // Production refresh timers are unref'd; this referenced deadline keeps the
    // loop alive so they can fire. It never re-checks or resolves anything.
    const deadline = setTimeout(() => {
      if (settled) return;
      finish();
      let detail = "";
      if (describe) {
        try { detail = `\n${describe()}`; } catch (error) { detail = `\n(describe failed: ${error})`; }
      }
      reject(new Error(`expected event did not arrive within ${timeout} ms${detail}`));
    }, timeout);
    const finish = () => { settled = true; clearTimeout(deadline); unsubscribe?.(); };
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
