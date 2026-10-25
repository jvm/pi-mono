import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { ProcessPanel } from "./process-panel.js";
import { displayText, statusText } from "./render.js";
import type { ProcessRuntime, ProcessView } from "./runtime.js";

type Confirmation = { kind: "stop" | "remove"; ids: string[]; prompt: string };

/** One local, live screen. Human attention never acknowledges model delivery. */
export class ProcessManager implements Component {
  private jobs: ProcessView[] = [];
  private selected?: string;
  private output?: ProcessPanel;
  private release?: () => void;
  private confirmation?: Confirmation;
  private message = "";
  private busy = false;
  private help = false;
  private helpRow = 0;
  private disposed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly clock: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: ProcessRuntime,
    private readonly cancelDelivery: (ids: string[]) => void,
    private readonly close: () => void,
    private readonly redraw: () => void,
    private readonly rows: () => number,
    private readonly keys?: Pick<KeybindingsManager, "matches">,
    private readonly theme?: Pick<Theme, "fg">,
  ) {
    this.refresh();
    this.unsubscribe = runtime.subscribe(() => this.schedule());
    this.clock = setInterval(() => this.schedule(), 1000);
    this.clock.unref();
  }

  invalidate(): void {}

  private schedule(): void {
    if (this.disposed || this.refreshTimer) return;
    // Coalesce arbitrary output chunk rates into at most ten UI reads per second.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.disposed) return;
      this.refresh();
      this.redraw();
    }, 100);
    this.refreshTimer.unref();
  }

  private refresh(): void {
    const rank = (job: ProcessView) => job.attention === "needs_attention" ? 0 : job.status === "running" ? 1 : 2;
    this.jobs = this.runtime.views().sort((a, b) => rank(a) - rank(b) || b.started_at - a.started_at);
    if (!this.jobs.some(job => job.session_id === this.selected)) {
      this.leaveOutput();
      this.selected = this.jobs[0]?.session_id;
    }
    const job = this.current();
    if (this.output && job) {
      this.output.updateStatus(job);
      try { this.output.refresh(true); }
      catch { this.leaveOutput(); this.message = "Output is no longer available."; }
    }
  }

  private current(): ProcessView | undefined { return this.jobs.find(job => job.session_id === this.selected); }
  private match(input: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
    return this.keys?.matches?.(input, `tui.select.${action}`) ?? matchesKey(input,
      action === "up" ? Key.up : action === "down" ? Key.down : action === "confirm" ? Key.enter : Key.escape);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const running = this.jobs.filter(job => job.status === "running").length;
    const attention = this.jobs.filter(job => job.attention === "needs_attention").length;
    const lines = [`Processes · ${running} running · ${attention} need attention · ${this.jobs.length - running} completed`];
    if (this.help) {
      const help = [
        "↑/↓: select a process; scroll output by one line",
        "Page Up/Down: move one page",
        "Enter: view output; Esc: output → list → close",
        "f: toggle live output follow; scrolling pauses follow",
        "←/→: pan output; n/p: next/previous log segment",
        "t: latest output snapshot; r: refresh current segment",
        "a: acknowledge this failure; A: acknowledge all failures",
        "s: stop running process (confirm); retain its output",
        "d: remove completed record and output (confirm)",
        "D: clear completed records (confirm); never stop running work",
        "Viewing output does not acknowledge a failure.",
        "Acknowledgment keeps output and does not change model delivery.",
        "Removing output cancels its pending automatic delivery.",
        "Esc or ?: return",
      ];
      lines.push(...help.slice(this.helpRow, this.helpRow + Math.max(1, this.rows() - 2)),
        "↑↓ scroll help · Esc or ? return");
    } else if (this.output) {
      lines.push(...this.output.render(width));
    } else {
      const height = Math.max(1, Math.min(20, this.rows() - 4));
      const index = Math.max(0, this.jobs.findIndex(job => job.session_id === this.selected));
      const start = Math.max(0, Math.min(index - height + 1, this.jobs.length - height));
      for (const job of this.jobs.slice(start, start + height)) {
        const marker = job.attention === "needs_attention" ? "!" : job.status === "running" ? "●" : job.stopped ? "■" : job.exit_code === 0 ? "✓" : "·";
        const seconds = Math.max(0, Math.floor(((job.finished_at ?? Date.now()) - job.started_at) / 1000));
        const line = `${job.session_id === this.selected ? "> " : "  "}${marker} ${job.title} · ${job.mode ?? "process"} · ${statusText({ ...job, output: "", dropped_bytes: 0, unread_bytes: 0 })} · ${seconds}s · ${job.session_id.slice(0, 8)}`
          + (job.attention === "acknowledged" ? " · acknowledged" : "");
        const safe = displayText(line);
        lines.push(this.theme ? this.theme.fg(job.session_id === this.selected ? "accent"
          : job.attention === "needs_attention" ? "warning" : "text", safe) : safe);
      }
      if (!this.jobs.length) lines.push("No retained processes.");
      else if (this.jobs.length > height) lines.push(`Showing ${start + 1}–${Math.min(start + height, this.jobs.length)} of ${this.jobs.length}`);
    }
    if (!this.help) {
      lines.push(this.confirmation ? "y confirm · Esc cancel · " + this.confirmation.prompt
        : this.busy ? "Stopping process…" : this.message || "Viewing output does not acknowledge failures.");
      const job = this.current();
      lines.push([
        "? help",
        this.output ? "Esc list" : "↑↓ select · Enter output · Esc close",
        ...(job?.attention === "needs_attention" ? ["a acknowledge"] : []),
        ...(job?.status === "running" ? ["s stop"] : job ? ["d remove"] : []),
        "A acknowledge all · D clear completed",
      ].join(" · "));
    }
    return lines.slice(0, Math.max(1, this.rows())).map(line => truncateToWidth(line, width));
  }

  handleInput(input: string): void {
    if (this.disposed) return;
    this.refresh();
    if (this.help) {
      if (this.match(input, "cancel") || input === "?") this.help = false;
      else if (this.match(input, "down")) this.helpRow = Math.min(13, this.helpRow + 1);
      else if (this.match(input, "up")) this.helpRow = Math.max(0, this.helpRow - 1);
    } else if (this.confirmation) {
      if (this.match(input, "cancel") || input === "n") this.confirmation = undefined;
      else if (input === "y") {
        const action = this.confirmation;
        this.confirmation = undefined;
        void this.perform(action);
      }
    } else if (this.busy) {
      if (this.match(input, "cancel")) this.close();
    } else if (input === "?") {
      this.help = true;
      this.helpRow = 0;
    } else if (input === "a") {
      if (this.current()?.attention === "needs_attention") {
        this.runtime.acknowledge(this.selected!);
        this.message = "Failure acknowledged; output retained.";
      }
      this.refresh();
    } else if (input === "A") {
      this.runtime.acknowledgeAll();
      this.message = "All current failures acknowledged; output retained.";
      this.refresh();
    } else if (input === "s" && this.current()?.status === "running") {
      this.confirmation = { kind: "stop", ids: [this.selected!], prompt: `Stop ${this.current()!.title}? Output will be retained.` };
    } else if (input === "d" && this.current()?.status === "exited") {
      this.confirmation = { kind: "remove", ids: [this.selected!], prompt: "Remove this completed record and its retained output?" };
    } else if (input === "D") {
      const ids = this.jobs.filter(job => job.status === "exited").map(job => job.session_id);
      if (ids.length) this.confirmation = { kind: "remove", ids, prompt: `Remove ${ids.length} completed record(s) and their output? Running work is unchanged.` };
    } else if (this.output) {
      if (this.match(input, "cancel") || this.match(input, "confirm")) this.leaveOutput();
      else this.output.handleInput(this.match(input, "up") ? "\x1b[A" : this.match(input, "down") ? "\x1b[B" : input);
    } else if (this.match(input, "cancel")) {
      this.close();
    } else if (this.match(input, "confirm") && this.selected) {
      try {
        this.release = this.runtime.retain(this.selected);
        const id = this.selected;
        this.output = new ProcessPanel((cursor, tail) => this.runtime.output(id, cursor, 64_000, tail),
          () => this.leaveOutput(), this.redraw, () => this.rows() - 3);
      } catch {
        this.leaveOutput();
        this.message = "Output could not be opened.";
      }
    } else if (this.match(input, "up") || this.match(input, "down") ||
      matchesKey(input, Key.pageUp) || matchesKey(input, Key.pageDown)) {
      const index = this.jobs.findIndex(job => job.session_id === this.selected);
      const step = matchesKey(input, Key.pageUp) || matchesKey(input, Key.pageDown) ? Math.max(1, Math.min(20, this.rows() - 4)) : 1;
      const direction = this.match(input, "up") || matchesKey(input, Key.pageUp) ? -1 : 1;
      this.selected = this.jobs[Math.max(0, Math.min(this.jobs.length - 1, index + direction * step))]?.session_id;
    }
    this.redraw();
  }

  private async perform(action: Confirmation): Promise<void> {
    this.busy = true;
    try {
      if (action.kind === "stop") {
        this.cancelDelivery(action.ids);
        await this.runtime.kill(action.ids[0]);
        this.message = "Stop requested; output retained.";
      } else {
        if (this.selected && action.ids.includes(this.selected)) this.leaveOutput();
        const removed: string[] = [];
        for (const id of action.ids) {
          try { this.runtime.remove(id); removed.push(id); }
          catch { /* active readers and running work are never removed */ }
        }
        this.cancelDelivery(removed);
        this.message = `Removed ${removed.length} completed record(s).`
          + (removed.length < action.ids.length ? " Records in use or no longer available were skipped." : "");
      }
    } catch { this.message = "Operation could not finish; refresh and try again."; }
    finally {
      this.busy = false;
      if (!this.disposed) { this.refresh(); this.redraw(); }
    }
  }

  private leaveOutput(): void {
    this.output = undefined;
    this.release?.();
    this.release = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.clock);
    clearTimeout(this.refreshTimer);
    this.unsubscribe();
    this.leaveOutput();
  }
}
