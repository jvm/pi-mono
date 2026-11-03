import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ProcessResult, ProcessRuntime } from "./runtime.js";

type Status = Pick<ProcessResult, "status" | "exit_code" | "signal" | "timed_out" | "stopped">;
interface Card {
  status: Status;
  invalidate: () => void;
}
interface CardContext {
  state: object;
  invalidate: () => void;
}

function statusOf(result: Status): Status {
  return {
    status: result.status, exit_code: result.exit_code, signal: result.signal,
    timed_out: result.timed_out, stopped: result.stopped,
  };
}

/** Live launch headings only. Never read output, pin records, or mutate tool results. */
export class LiveProcessCards {
  private runtime?: ProcessRuntime;
  private unsubscribe?: () => void;
  // One launch card per owned process, bounded by the runtime's active records.
  private readonly active = new Map<string, Card>();
  // Row-local snapshots survive record eviction without retaining old tool rows.
  private readonly rows = new WeakMap<object, { id: string; card: Card }>();

  attach(runtime: ProcessRuntime): void {
    this.dispose();
    this.runtime = runtime;
    this.unsubscribe = runtime.subscribe(() => this.refresh());
  }

  result(result: AgentToolResult<unknown>, context?: CardContext): AgentToolResult<unknown> {
    const details = result.details as ProcessResult | undefined;
    if (details?.status !== "running" || typeof details.session_id !== "string" || !context?.state) return result;
    const id = details.session_id;
    let row = this.rows.get(context.state);
    if (!row || row.id !== id) {
      const current = this.runtime?.list().find(job => job.session_id === id);
      if (!current) return result; // Saved sessions have no recoverable process runtime.
      const card = this.active.get(id) ?? { status: statusOf(current), invalidate: context.invalidate };
      row = { id, card };
      this.rows.set(context.state, row);
      if (current.status === "running") this.active.set(id, card);
    }
    if (row.card.status.status === "running") row.card.invalidate = context.invalidate;
    return { ...result, details: { ...details, ...row.card.status } };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.runtime = undefined;
    this.active.clear();
  }

  private refresh(): void {
    if (!this.active.size) return;
    const jobs = new Map(this.runtime?.list().map(job => [job.session_id, job]));
    for (const [id, card] of this.active) {
      const job = jobs.get(id);
      if (job?.status !== "exited") continue;
      card.status = statusOf(job);
      this.active.delete(id);
      const invalidate = card.invalidate;
      card.invalidate = () => {};
      try { invalidate(); } catch { /* a closed terminal must not affect execution */ }
    }
  }
}
