import { Key, matchesKey, sliceByColumn, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { displayText, statusText } from "./render.js";
import type { ProcessResult } from "./runtime.js";

/** Bounded pages and horizontal navigation, without adding output to model context. */
export class ProcessPanel implements Component {
  private data: ProcessResult;
  private row = 0;
  private column = 0;
  private cursor = 0;
  private readonly previous: number[] = [];
  private tail = false;
  private following = false;

  constructor(
    private readonly read: (cursor: number, tail: boolean) => ProcessResult,
    private readonly close: () => void,
    private readonly redraw: () => void,
    private readonly rows: () => number,
  ) { this.data = read(0, false); }

  invalidate(): void {}
  private get lines(): string[] { return displayText(this.data.output).split(/\r?\n/); }
  private get height(): number { return Math.max(1, Math.min(20, this.rows() - 4)); }
  get followsOutput(): boolean { return this.following; }

  updateStatus(status: Pick<ProcessResult, "status" | "exit_code" | "signal" | "timed_out" | "stopped">): void {
    this.data = { ...this.data, ...status };
  }

  /** Live updates never move a paused reader or consume another reader's buffer. */
  refresh(live = false): void {
    if (live && !this.following) return;
    this.data = this.read(this.cursor, this.tail);
    this.row = this.following ? Math.max(0, this.lines.length - this.height)
      : Math.min(this.row, Math.max(0, this.lines.length - 1));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const heading = `${this.data.title ?? this.data.session_id.slice(0, 8)} · ${statusText(this.data)}`
      + (this.data.dropped_bytes ? ` · ${this.data.dropped_bytes} bytes omitted` : "");
    return [
      truncateToWidth(displayText(heading), width),
      ...this.lines.slice(this.row, this.row + this.height).map(line =>
        truncateToWidth(sliceByColumn(line, this.column, width), width)),
      truncateToWidth(`Follow: ${this.following ? "on" : "off"} · Line ${this.row + 1} · column ${this.column} · ${this.data.unread_bytes} bytes remaining`, width),
      truncateToWidth("f follow · ↑↓ lines · PgUp/PgDn pages · ←→ pan · n/p segments · t tail · r refresh", width),
    ];
  }

  handleInput(input: string): void {
    if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) { this.close(); return; }
    if (matchesKey(input, Key.down) || matchesKey(input, Key.pageDown)) {
      this.following = false;
      this.row = Math.min(Math.max(0, this.lines.length - 1), this.row + (matchesKey(input, Key.pageDown) ? this.height : 1));
    } else if (matchesKey(input, Key.up) || matchesKey(input, Key.pageUp)) {
      this.following = false;
      this.row = Math.max(0, this.row - (matchesKey(input, Key.pageUp) ? this.height : 1));
    }
    else if (matchesKey(input, Key.left)) this.column = Math.max(0, this.column - 10);
    else if (matchesKey(input, Key.right)) this.column = Math.min(64_000, this.column + 10);
    else if (input === "n" && this.data.next_cursor !== undefined && this.data.unread_bytes) {
      this.previous.push(this.cursor);
      if (this.previous.length > 128) this.previous.shift();
      this.cursor = this.data.next_cursor;
      this.tail = this.following = false;
      this.data = this.read(this.cursor, false);
      this.row = this.column = 0;
    } else if (input === "p" && this.previous.length) {
      this.cursor = this.previous.pop()!;
      this.tail = this.following = false;
      this.data = this.read(this.cursor, false);
      this.row = this.column = 0;
    } else if (input === "t") {
      this.tail = true;
      this.following = false;
      this.refresh();
      this.row = Math.max(0, this.lines.length - this.height);
      this.column = 0;
    } else if (input === "r") {
      this.refresh();
    } else if (input === "f") {
      this.following = !this.following;
      if (this.following) {
        this.tail = true;
        this.column = 0;
        this.refresh();
      }
    }
    this.redraw();
  }
}
