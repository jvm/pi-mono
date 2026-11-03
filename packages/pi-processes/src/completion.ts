import type { ProcessResult } from "./runtime.js";

interface Record {
  task: number;
  result?: ProcessResult;
  observers: Set<string>;
  reserved: boolean;
}

/** Model delivery is separate from process exit and from user-facing progress. */
export class CompletionCoordinator {
  private task = 0;
  private readonly records = new Map<string, Record>();
  private readonly early = new Map<string, ProcessResult>();
  private readonly observations = new Map<string, Set<string>>();

  constructor(private readonly onChange: () => void = () => {}) {}

  newTask(): void {
    this.task++;
    this.records.clear();
    this.early.clear();
    this.observations.clear();
    this.changed();
  }

  arm(id: string, task = this.task): boolean {
    if (task !== this.task || this.records.size >= 32) return false;
    const result = this.early.get(id);
    this.early.delete(id);
    this.records.set(id, { task, result, observers: new Set(), reserved: false });
    this.changed();
    return true;
  }

  get taskId(): number { return this.task; }
  get armed(): number { return this.records.size; }

  complete(result: ProcessResult): void {
    const record = this.records.get(result.session_id);
    if (record) record.result = result;
    else {
      // Covers an exit between the runtime's initial result and arm().
      this.early.set(result.session_id, result);
      while (this.early.size > 32) this.early.delete(this.early.keys().next().value!);
    }
  }

  observe(callId: string, ids: string[]): void {
    this.observations.set(callId, new Set(ids));
    for (const id of ids) this.records.get(id)?.observers.add(callId);
  }

  finish(callId: string, terminalIds: string[], success: boolean): void {
    const previous = this.records.size;
    for (const id of this.observations.get(callId) ?? []) {
      this.records.get(id)?.observers.delete(callId);
      if (success && terminalIds.includes(id)) this.records.delete(id);
    }
    this.observations.delete(callId);
    if (previous !== this.records.size) this.changed();
  }

  acknowledge(ids: string[]): void {
    const previous = this.records.size;
    for (const id of ids) this.records.delete(id);
    if (previous !== this.records.size) this.changed();
  }

  private changed(): void {
    try { this.onChange(); } catch { /* display feedback must not affect delivery */ }
  }

  retryUncommitted(): void {
    for (const record of this.records.values()) record.reserved = false;
  }

  /** Called only at a safe boundary. A batch is reserved before it is sent. */
  take(): ProcessResult[] {
    const results: ProcessResult[] = [];
    let budget = 64_000;
    for (const [id, record] of this.records) {
      if (!record.result || record.observers.size || record.reserved || record.task !== this.task) continue;
      const bytes = Buffer.byteLength(record.result.output);
      if (results.length && bytes > budget) break;
      results.push(record.result);
      budget -= bytes;
      record.reserved = true;
      if (results.length === 8) break;
    }
    return results;
  }
}
