import { createHmac, randomBytes } from "node:crypto";

const key = randomBytes(32);
const MAX_SCOPES = 128;
const MAX_QUEUED = 100;
export const HTTP_CONCURRENCY = 3;
type Scope = { active: number; queue: Array<() => void>; cooldown: number };
const scopes = new Map<string, Scope>();
export class AdmissionError extends Error {}

/** Never retain or expose credentials as coordination keys. */
export function requestScope(url: string, headers?: HeadersInit): string {
  const normalized = [...new Headers(headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHmac("sha256", key).update(JSON.stringify([new URL(url).origin, normalized])).digest("hex");
}

/** Admission deadline is the caller's HTTP deadline, including queue wait. */
export async function coordinate<T>(identity: string, signal: AbortSignal, work: (cooldown: (ms: number) => void) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let scope = scopes.get(identity);
  if (!scope) {
    for (const [id, value] of scopes) {
      if (!value.active && !value.queue.length && value.cooldown <= Date.now()) scopes.delete(id);
    }
    if (scopes.size >= MAX_SCOPES) throw new AdmissionError("Provider coordination capacity exceeded.");
    scope = { active: 0, queue: [], cooldown: 0 };
    scopes.set(identity, scope);
  }
  const state = scope;
  if (state.queue.length >= MAX_QUEUED) throw new AdmissionError("Provider request queue is full.");
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => {
      const index = state.queue.indexOf(admit);
      if (index !== -1) state.queue.splice(index, 1);
      signal.removeEventListener("abort", cancelled);
      reject(signal.reason);
    };
    const admit = () => {
      signal.removeEventListener("abort", cancelled);
      state.active++;
      resolve();
    };
    signal.addEventListener("abort", cancelled, { once: true });
    if (state.active < HTTP_CONCURRENCY) admit();
    else state.queue.push(admit);
  });
  try {
    const remaining = Math.max(0, state.cooldown - Date.now());
    if (remaining) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, remaining);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return await work(ms => { state.cooldown = Math.max(state.cooldown, Date.now() + Math.min(30_000, Math.max(0, ms))); });
  } finally {
    state.active--;
    state.queue.shift()?.();
    if (!state.active && !state.queue.length && state.cooldown <= Date.now()) scopes.delete(identity);
  }
}

type Flight<T> = { controller: AbortController; waiters: number; promise: Promise<T> };
const flights = new Map<string, Flight<unknown>>();

/** Each waiter owns cancellation; only the last departing waiter cancels shared work. */
export function shareFetch<T>(identity: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  let flight = flights.get(identity) as Flight<T> | undefined;
  if (!flight) {
    if (flights.size >= 100) throw new Error("Fetch sharing capacity exceeded.");
    const controller = new AbortController();
    const created: Flight<T> = { controller, waiters: 0, promise: undefined! };
    created.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).finally(() => { if (flights.get(identity) === created) flights.delete(identity); });
    flights.set(identity, created);
    flight = created;
  }
  const current = flight;
  current.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      if (--current.waiters === 0) {
        if (flights.get(identity) === current) flights.delete(identity);
        current.controller.abort();
      }
      callback();
    };
    const abort = () => finish(() => reject(new Error("Web tool cancelled.")));
    signal?.addEventListener("abort", abort, { once: true });
    current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}
