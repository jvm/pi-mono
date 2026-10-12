import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { OutputBuffer } from "./output.js";
import { launch, signalGroup, type Transport } from "./transport.js";
import { abortable } from "./confirmation-queue.js";

export interface ProcessResult {
  session_id: string;
  status: "running" | "exited";
  exit_code: number | null;
  signal: string | null;
  output: string;
  dropped_bytes: number;
  unread_bytes: number;
  timed_out: boolean;
}

interface Job {
  id: string;
  tty: boolean;
  transport?: Transport;
  output: OutputBuffer;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  detached: boolean;
  notify: boolean;
  activeReads: number;
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

  constructor(
    private readonly completed: (result: ProcessResult, notify: boolean) => void = () => {},
    private readonly limits = { active: 8, retained: 32, outputBytes: 1024 * 1024, killGraceMs: 500 },
  ) {}

  async start(
    cmd: string, cwd: string, tty: boolean, timeoutMs: number, notify: boolean,
    waitMs: number, maxBytes: number, signal?: AbortSignal,
  ): Promise<ProcessResult> {
    aborted(signal);
    if (this.closed) throw new Error("Process runtime is closed");
    if (this.launching + [...this.jobs.values()].filter(job => !job.exited).length >= this.limits.active) {
      throw new Error(`At most ${this.limits.active} processes can run at once`);
    }
    this.launching++;
    const job: Job = {
      id: randomUUID(), tty, output: new OutputBuffer(this.limits.outputBytes),
      exited: false, exitCode: null, signal: null, timedOut: false,
      detached: false, notify, notified: false, activeReads: 0,
      listeners: new Set(), queue: Promise.resolve(), queued: 0,
    };
    let reserved = true;
    try {
      job.transport = await launch({
        cmd, cwd, tty,
        onData: data => job.output.append(data),
        onExit: (code, exitSignal) => {
          job.exited = true;
          job.exitCode = code;
          job.signal = exitSignal;
          clearTimeout(job.timer);
          // Stop descendants left behind by a command whose shell has exited.
          if (job.transport) {
            try { signalGroup(job.transport.pid, "SIGKILL"); } catch { /* best effort on exit */ }
          }
          for (const listener of job.listeners) listener();
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
      const result = await this.read(job, waitMs, maxBytes, signal);
      job.detached = result.status === "running";
      this.maybeNotify(job);
      this.evict();
      return result;
    } catch (error) {
      if (job.transport) await this.stop(job);
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

  async kill(id: string): Promise<void> { await this.stop(this.get(id)); }

  list(): Omit<ProcessResult, "output" | "dropped_bytes" | "unread_bytes">[] {
    return [...this.jobs.values()].map(job => this.metadata(job));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.jobs.values()].map(job => this.stop(job)));
    for (const job of this.jobs.values()) job.transport?.dispose();
    this.jobs.clear();
  }

  /** Last-resort synchronous cleanup on a normal Node process exit. */
  killAllSync(): void {
    for (const job of this.jobs.values()) {
      if (!job.exited && job.transport) {
        try { signalGroup(job.transport.pid, "SIGKILL"); } catch { /* exit cleanup */ }
      }
    }
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
    };
  }

  private async read(job: Job, waitMs: number, maxBytes: number, signal?: AbortSignal): Promise<ProcessResult> {
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
        };
        job.listeners.add(done);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
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
    try { this.completed({ ...this.metadata(job), output: "", dropped_bytes: 0, unread_bytes: 0 }, job.notify); }
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
        job.signal = "SIGKILL";
        for (const listener of job.listeners) listener();
        this.maybeNotify(job);
      }
    })();
    return job.stopping;
  }

  private evict(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.limits.retained) break;
      if (job.exited && !job.activeReads && !job.queued) {
        job.transport?.dispose();
        this.jobs.delete(id);
      }
    }
  }
}
