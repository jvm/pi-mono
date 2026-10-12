/** Observe late settlements but never let them approve an aborted operation. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error("Process operation cancelled")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    pending.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Queue this extension's dialogs without making cancelled waiters block a turn. */
export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();

  async confirm(signal: AbortSignal, show: () => Promise<boolean>): Promise<boolean> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => current);
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      const approved = await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return show();
      }), signal);
      return !signal.aborted && approved === true;
    } finally { release(); }
  }
}
