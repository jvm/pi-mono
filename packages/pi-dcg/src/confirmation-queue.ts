/** Wait without retaining an abort listener or accepting a late UI response. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    // Observe both outcomes even when cancellation wins the race.
    pending.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Pi's terminal dialogs share one editor slot. Queue only this bridge's prompts. */
export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();

  async confirm(signal: AbortSignal, show: () => Promise<boolean>): Promise<boolean> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    // A cancelled waiter must not let its successors overtake the current dialog.
    this.tail = previous.then(() => current);
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      const approved = await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return show();
      }), signal);
      return !signal.aborted && approved === true;
    } finally {
      release();
    }
  }
}
