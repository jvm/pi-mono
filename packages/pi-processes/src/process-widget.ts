import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { BackgroundProcess, ProcessRuntime } from "./runtime.js";

export const WIDGET_KEY = "pi-processes";

export class ProcessWidget {
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly background: () => BackgroundProcess[],
    private readonly redraw: () => void,
    private readonly now: () => number = Date.now,
  ) {
    // This timer refreshes elapsed time only. Runtime events update membership.
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref();
  }

  render(width: number): string[] {
    const jobs = this.background();
    if (!jobs.length || width < 1) return [];
    const lines = [
      `Background processes · ${jobs.length}`,
      ...jobs.slice(0, 3).map(job => {
        const seconds = Math.max(0, Math.floor((this.now() - job.started_at) / 1000));
        return `  ${job.session_id.slice(0, 8)} · ${job.mode ?? "background"} · ${job.tty ? "PTY" : "pipe"} · ${seconds}s · ${job.command_preview}`;
      }),
      ...(jobs.length > 3 ? [`  … ${jobs.length - 3} more running`] : []),
      "/processes: output and stop controls",
    ];
    // Uncolored text inherits the active terminal palette; no cached theme ANSI.
    return lines.map(line => truncateToWidth(line, width));
  }

  refresh(): void {
    try { this.redraw(); } catch { /* terminal teardown must not affect live processes */ }
  }
  invalidate(): void { /* no render cache */ }
  dispose(): void { clearInterval(this.timer); }
}

/** Own only our widget slot. Do not replace an editor, footer, or another widget. */
export class ProcessDisplay {
  private widget?: ProcessWidget;
  private shown = false;
  private disposed = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly runtime: ProcessRuntime,
    private readonly monitors: () => number = () => 0,
  ) {}

  sync(): void {
    if (this.disposed || this.ctx.mode !== "tui") return;
    // Shells track execution; monitors track task-scoped automatic delivery.
    const running = this.runtime.background().length;
    const monitors = this.monitors();
    const status = [
      ...(running ? [`${running} ${running === 1 ? "shell" : "shells"}`] : []),
      ...(monitors ? [`${monitors} ${monitors === 1 ? "monitor" : "monitors"}`] : []),
    ];
    try { this.ctx.ui.setStatus("pi-processes-results", status.length
      ? `${status.join(" · ")} · /processes` : undefined); }
    catch { /* display-only feedback */ }
    if (!running) {
      this.clear();
      return;
    }
    if (!this.shown) {
      this.ctx.ui.setWidget(WIDGET_KEY, (tui: TUI) => {
        this.widget = new ProcessWidget(() => this.runtime.background(), () => tui.requestRender());
        return this.widget;
      }, { placement: "aboveEditor" });
      this.shown = true;
    }
    this.widget?.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    try { this.ctx.ui.setStatus("pi-processes-results", undefined); } catch { /* teardown */ }
  }

  private clear(): void {
    this.widget?.dispose();
    this.widget = undefined;
    if (this.shown) {
      this.shown = false;
      try { this.ctx.ui.setWidget(WIDGET_KEY, undefined); }
      catch { /* a terminal teardown failure must not prevent process cleanup */ }
    }
  }
}
