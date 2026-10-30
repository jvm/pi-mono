import { createHmac, randomBytes } from "node:crypto";

const secret = randomBytes(32);
type Account = { active: number; queue: Array<() => void> };
const accounts = new Map<string, Account>();

/** Shared by direct and artifact calls; credentials/account IDs never leave this map. */
export async function admitGeneration(account: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const key = createHmac("sha256", secret).update(account).digest("hex");
  let state = accounts.get(key);
  if (!state) {
    if (accounts.size >= 32) throw new Error("Image admission capacity exceeded. No generation request was made.");
    state = { active: 0, queue: [] };
    accounts.set(key, state);
  }
  const current = state;
  if (current.queue.length >= 8) throw new Error("Image generation queue is full. No generation request was made.");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = current.queue.indexOf(start);
      if (index !== -1) current.queue.splice(index, 1);
      signal.removeEventListener("abort", abort);
      reject(new Error("Image generation cancelled before admission. No generation request was made."));
    };
    const start = () => {
      signal.removeEventListener("abort", abort);
      current.active++;
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (current.active < 2) start();
    else current.queue.push(start);
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.active--;
    current.queue.shift()?.();
    if (!current.active && !current.queue.length) accounts.delete(key);
  };
}
