import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { OutputBuffer } from "./output.js";
import { launch, signalGroup, type Transport } from "./transport.js";
import { abortable } from "./confirmation-queue.js";
import { commandPreview } from "./display-text.js";
import { OutputLogs } from "./output-log.js";

export interface ProcessResult {
  session_id: string;
  status: "running" | "exited";
  exit_code: number | null;
  signal: string | null;
  output: string;
  dropped_bytes: number;
  unread_bytes: number;
  timed_out: boolean;
  title?: string;
  mode?: RunMode;
  next_cursor?: number;
  wait_status?: "interrupted_by_input";
  output_scope?: "log" | "tail";
  input_changes_observed?: boolean;
  completion_delivery?: "automatic" | "manual";
  stopped?: boolean;
}

export type CompletionMode = "nextTurn" | "followUp" | "steer";
export type RunMode = "foreground" | "background" | "service";
export type Attention = "none" | "needs_attention" | "acknowledged";
export interface ProcessView extends Omit<ProcessResult, "output" | "dropped_bytes" | "unread_bytes"> {
  title: string;
  tty: boolean;
  started_at: number;
  finished_at?: number;
  detached: boolean;
  attention: Attention;
}

export interface BackgroundProcess {
  session_id: string;
  command_preview: string;
  tty: boolean;
  started_at: number;
  mode?: RunMode;
}

interface Job {
  id: string;
  tty: boolean;
  commandPreview: string;
  startedAt: number;
  finishedAt?: number;
  title?: string;
  mode?: RunMode;
  transport?: Transport;
  output: OutputBuffer;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stopRequested: boolean;
  attention: Attention;
  detached: boolean;
  notify: boolean;
  completionMode?: CompletionMode;
  tail: OutputBuffer;
  completionBytes: number;
  inputVersion: number;
  activeReads: number;
  pins: number;
  notified: boolean;
  stopping?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
  queue: Promise<unknown>;
  queued: number;
}

export async function resolveWorkdir(workdir: string | undefined, cwd: string): Promise<string> {
  const path = await realpath(resolve(cwd, workdir ?? "."));
  if (!(await stat(path)).isDirectory()) throw new Error("workdir must be a directory");
  return path;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Process operation cancelled");
}

export class ProcessRuntime {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  // Reservations prevent concurrent spawn calls from exceeding the limit.
  private launching = 0;
  private readonly logs = new OutputLogs();
  private readonly subscribers = new Set<() => void>();

  constructor(
    private readonly completed: (result: ProcessResult, notify: boolean, mode?: CompletionMode) => void = () => {},
    private readonly limits = { active: 8, retained: 32, outputBytes: 1024 * 1024, killGraceMs: 500 },
    private readonly changed: () => void = () => {},
    private readonly version: () => number = () => 0,
    private readonly humanAttention = true,
  ) {}

  async start(
    cmd: string, cwd: string, tty: boolean, timeoutMs: number, notify: boolean,
    waitMs: number, maxBytes: number, signal?: AbortSignal, completionMode?: CompletionMode,
    options: { mode?: RunMode; title?: string; started?: (id: string) => void; yieldOnInput?: AbortSignal } = {},
  ): Promise<ProcessResult> {
    aborted(signal);
    if (this.closed) throw new Error("Process runtime is closed");
    if (this.launching + [...this.jobs.values()].filter(job => !job.exited).length >= this.limits.active) {
      throw new Error(`At most ${this.limits.active} processes can run at once`);
    }
    this.evict(1);
    if (this.jobs.size + this.launching >= this.limits.retained) {
      throw new Error(`At most ${this.limits.retained} process records can be retained; acknowledge or remove completed records, or release active readers`);
    }
    this.launching++;
    const job: Job = {
      id: randomUUID(), tty, output: new OutputBuffer(this.limits.outputBytes),
      commandPreview: commandPreview(cmd), startedAt: Date.now(),
      mode: options.mode, title: options.title ? commandPreview(options.title) : undefined,
      exited: false, exitCode: null, signal: null, timedOut: false, stopRequested: false, attention: "none",
      detached: false, notify, notified: false, activeReads: 0, pins: 0,
      completionMode,
      // A separate tail survives every reader and disk quota exhaustion.
      tail: new OutputBuffer(64_000), completionBytes: Math.min(64_000, Math.max(4, maxBytes)),
      inputVersion: this.version(),
      listeners: new Set(), queue: Promise.resolve(), queued: 0,
    };
    let reserved = true;
    try {
      this.logs.create(job.id);
      job.transport = await launch({
        cmd, cwd, tty,
        onData: data => {
          job.output.append(data);
          job.tail.append(data);
          this.logs.append(job.id, data);
          this.emit();
        },
        onExit: (code, exitSignal) => {
          job.exited = true;
          job.finishedAt = Date.now();
          job.exitCode = code;
          job.signal = exitSignal;
          this.updateAttention(job);
          clearTimeout(job.timer);
          // Stop descendants left behind by a command whose shell has exited.
          if (job.transport) {
            try { signalGroup(job.transport.pid, "SIGKILL"); } catch { /* best effort on exit */ }
          }
          for (const listener of job.listeners) listener();
          this.stateChanged();
          this.maybeNotify(job);
        },
      });
      this.jobs.set(job.id, job);
      this.launching--;
      reserved = false;
      if (this.closed || signal?.aborted) {
        await this.stop(job);
        throw new Error("Process operation cancelled");
      }
      if (!job.exited) {
        job.timer = setTimeout(() => {
          job.timedOut = true;
          void this.stop(job).catch(() => {});
        }, timeoutMs);
      }
      try { options.started?.(job.id); } catch { /* progress cannot change execution */ }
      const result = await this.read(job, waitMs, maxBytes, signal, options.yieldOnInput);
      if (options.yieldOnInput?.aborted && result.status === "running") result.wait_status = "interrupted_by_input";
      job.detached = result.status === "running" || options.mode === "background";
      this.stateChanged();
      this.maybeNotify(job);
      this.evict();
      return result;
    } catch (error) {
      if (job.transport) await this.stop(job);
      if (!this.jobs.has(job.id)) this.logs.remove(job.id);
      throw error;
    } finally {
      if (reserved) this.launching--;
    }
  }

  /** The lock includes confirmation and input so approval cannot apply to a different job/write. */
  async interact<T>(id: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = this.get(id);
    job.queued++;
    const previous = job.queue;
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    job.queue = previous.then(() => pending);
    try {
      await (signal ? abortable(previous, signal) : previous);
      aborted(signal);
      return await action();
    } finally { job.queued--; release(); }
  }

  isTty(id: string): boolean { return this.get(id).tty; }

  write(id: string, chars: string, signal?: AbortSignal): void {
    aborted(signal);
    const job = this.get(id);
    if (this.closed || job.exited) throw new Error("Process is no longer running");
    if (!job.tty) throw new Error("Input requires tty:true");
    job.transport!.write(chars);
  }

  poll(id: string, waitMs: number, maxBytes: number, signal?: AbortSignal): Promise<ProcessResult> {
    return this.read(this.get(id), waitMs, maxBytes, signal);
  }

  async kill(id: string): Promise<void> {
    const job = this.get(id);
    if (!job.exited) job.stopRequested = true;
    await this.stop(job);
  }

  /** Human acknowledgment is independent of output reads and model delivery. */
  acknowledge(id: string): void {
    const job = this.get(id);
    if (job.attention === "needs_attention") job.attention = "acknowledged";
    this.stateChanged();
  }

  acknowledgeAll(): void {
    for (const job of this.jobs.values()) {
      if (job.attention === "needs_attention") job.attention = "acknowledged";
    }
    this.stateChanged();
  }

  /** Remove only completed, unpinned records and their owned logs. Never signal a process. */
  remove(id: string): void {
    const job = this.get(id);
    if (!job.exited) throw new Error("Stop the process before removing its record");
    if (job.activeReads || job.pins || job.queued || job.stopping) throw new Error("Process output is in use; try again after the reader or stop operation finishes");
    job.transport?.dispose();
    this.logs.remove(id);
    this.jobs.delete(id);
    this.stateChanged();
  }

  clearCompleted(): string[] {
    const removed: string[] = [];
    for (const job of [...this.jobs.values()]) {
      if (!job.exited || job.activeReads || job.pins || job.queued || job.stopping) continue;
      this.remove(job.id);
      removed.push(job.id);
    }
    return removed;
  }

  /** Subscribers observe lifecycle/output changes without consuming output. */
  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {};
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  /** Human output inspection pins retention, never model completion delivery. */
  retain(id: string): () => void {
    const job = this.get(id);
    job.pins++;
    let released = false;
    return () => { if (!released) { released = true; job.pins--; } };
  }

  /** Non-consuming output with an independent byte cursor for each caller. */
  output(id: string, cursor: number, maxBytes: number, tail = false): ProcessResult {
    const job = this.get(id);
    return tail
      ? { ...this.metadata(job), ...job.tail.tail(maxBytes), output_scope: "tail" }
      : { ...this.metadata(job), ...this.logs.read(id, cursor, maxBytes, job.exited), output_scope: "log" };
  }

  /** One event-driven wait, regardless of how many processes or output chunks exist. */
  hold(ids: string[]): () => void {
    const jobs = ids.map(id => this.get(id));
    for (const job of jobs) job.activeReads++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const job of jobs) { job.activeReads--; this.maybeNotify(job); }
    };
  }

  async wait(ids: string[], all: boolean, waitMs: number, signal?: AbortSignal): Promise<void> {
    const jobs = ids.map(id => this.get(id));
    aborted(signal);
    const ready = () => all ? jobs.every(job => job.exited) : jobs.some(job => job.exited);
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (ready()) done(); };
      const done = () => { cleanup(); resolve(); };
      const cancel = () => { cleanup(); reject(new Error("Process wait cancelled; processes remain running")); };
      const timer = setTimeout(done, waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        for (const job of jobs) job.listeners.delete(check);
        signal?.removeEventListener("abort", cancel);
      };
      for (const job of jobs) job.listeners.add(check);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else check();
    });
  }

  views(): ProcessView[] {
    if (this.closed) return [];
    return [...this.jobs.values()].map(job => ({
      ...this.metadata(job), title: job.title ?? job.commandPreview,
      tty: job.tty, started_at: job.startedAt, detached: job.detached, attention: job.attention,
      ...(job.finishedAt === undefined ? {} : { finished_at: job.finishedAt }),
    }));
  }

  list(): Omit<ProcessResult, "output" | "dropped_bytes" | "unread_bytes">[] {
    return [...this.jobs.values()].map(job => this.metadata(job));
  }

  /** Display metadata only; never consume unread output or count foreground work. */
  background(): BackgroundProcess[] {
    if (this.closed) return [];
    return [...this.jobs.values()].filter(job => job.detached && !job.exited).map(job => ({
      session_id: job.id, command_preview: job.title ?? job.commandPreview, tty: job.tty, started_at: job.startedAt,
      ...(job.mode ? { mode: job.mode } : {}),
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stateChanged();
    await Promise.all([...this.jobs.values()].map(job => this.stop(job)));
    for (const job of this.jobs.values()) job.transport?.dispose();
    this.jobs.clear();
    this.logs.close();
    this.subscribers.clear();
  }

  /** Last-resort synchronous cleanup on a normal Node process exit. */
  killAllSync(): void {
    for (const job of this.jobs.values()) {
      if (!job.exited && job.transport) {
        try { signalGroup(job.transport.pid, "SIGKILL"); } catch { /* exit cleanup */ }
      }
    }
    this.logs.close();
  }

  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown process session (ended, evicted, or from another Pi session)");
    return job;
  }

  private metadata(job: Job) {
    return {
      session_id: job.id, status: job.exited ? "exited" as const : "running" as const,
      exit_code: job.exitCode, signal: job.signal, timed_out: job.timedOut,
      ...(job.stopRequested ? { stopped: true } : {}),
      ...(job.title ? { title: job.title } : {}),
      ...(job.mode ? { mode: job.mode } : {}),
      ...(job.mode && job.mode !== "service" ? { input_changes_observed: this.version() !== job.inputVersion } : {}),
    };
  }

  private stateChanged(): void {
    try { this.changed(); } catch { /* display failures never alter process execution */ }
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.subscribers]) {
      try { listener(); } catch { /* observers never change execution */ }
    }
  }

  private updateAttention(job: Job): void {
    if (this.humanAttention && job.mode && !job.stopRequested && (job.timedOut || job.signal !== null || job.exitCode !== 0)) {
      job.attention = "needs_attention";
    }
  }

  private async read(job: Job, waitMs: number, maxBytes: number, signal?: AbortSignal, early?: AbortSignal): Promise<ProcessResult> {
    aborted(signal);
    job.activeReads++;
    try {
      // Yield until exit or the deadline, not every output chunk. No busy polling.
      if (!job.exited) await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const cancel = () => { cleanup(); reject(new Error("Process wait cancelled; use process_kill to stop it")); };
        const timer = setTimeout(done, waitMs);
        const cleanup = () => {
          clearTimeout(timer);
          job.listeners.delete(done);
          signal?.removeEventListener("abort", cancel);
          early?.removeEventListener("abort", done);
        };
        job.listeners.add(done);
        signal?.addEventListener("abort", cancel, { once: true });
        early?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) cancel();
        else if (early?.aborted) done();
        else if (job.exited) done();
      });
      aborted(signal);
      return { ...this.metadata(job), ...job.output.read(maxBytes) };
    } finally {
      job.activeReads--;
      this.maybeNotify(job);
    }
  }

  private maybeNotify(job: Job): void {
    if (this.closed || !job.detached || !job.exited || job.notified || job.activeReads) return;
    job.notified = true;
    if (!job.notify && !job.completionMode) return;
    const tail = job.completionMode ? job.tail.tail(job.completionBytes)
      : { output: "", dropped_bytes: 0, unread_bytes: 0 };
    try { this.completed({ ...this.metadata(job), ...tail }, job.notify, job.completionMode); }
    catch { /* notification failures never alter process state */ }
  }

  private async stop(job: Job): Promise<void> {
    if (job.stopping) return job.stopping;
    if (job.exited || !job.transport) return;
    job.stopping = (async () => {
      clearTimeout(job.timer);
      signalGroup(job.transport!.pid, "SIGTERM");
      // Always escalate the group, even if its leader exits first.
      await new Promise(resolve => setTimeout(resolve, this.limits.killGraceMs));
      // The exit callback already escalates the group. Avoid re-signalling a
      // dead leader's group after a PID could have been recycled.
      if (!job.exited) signalGroup(job.transport!.pid, "SIGKILL");
      // Close the parent's pipe/PTY listeners if a child escaped and keeps fds open.
      job.transport!.dispose();
      if (!job.exited) {
        job.exited = true;
        job.finishedAt = Date.now();
        job.signal = "SIGKILL";
        this.updateAttention(job);
        for (const listener of job.listeners) listener();
        this.stateChanged();
        this.maybeNotify(job);
      }
    })().finally(() => { job.stopping = undefined; });
    return job.stopping;
  }

  private evict(space = 0): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size + this.launching <= this.limits.retained - space) break;
      if (job.exited && job.attention !== "needs_attention" && !job.activeReads && !job.pins && !job.queued && !job.stopping) {
        job.transport?.dispose();
        this.jobs.delete(id);
        this.logs.remove(id);
      }
    }
  }
}
