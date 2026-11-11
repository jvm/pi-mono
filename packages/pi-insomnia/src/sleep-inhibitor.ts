import { spawn, type ChildProcess } from "node:child_process";
import { LinuxSleepInhibitor } from "./linux-sleep-inhibitor.js";

export const DEFAULT_CAFFEINATE_PATH = "/usr/bin/caffeinate";

export interface MacSleepInhibitorOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  caffeinatePath?: string;
}

export class MacSleepInhibitor {
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly caffeinatePath: string;
  private child: ChildProcess | undefined;
  private active = false;

  constructor(options: MacSleepInhibitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.caffeinatePath = options.caffeinatePath ?? DEFAULT_CAFFEINATE_PATH;
  }

  get isSupported(): boolean {
    return this.platform === "darwin";
  }

  get isActive(): boolean {
    return this.active;
  }

  get isInhibiting(): boolean {
    return this.child !== undefined;
  }

  acquire(): boolean {
    if (!this.isSupported) return false;

    this.active = true;
    this.start();
    return this.isInhibiting;
  }

  release(): void {
    if (!this.isSupported) return;

    this.active = false;
    this.stop();
  }

  forceStop(): void {
    this.active = false;
    this.stop();
  }

  private start(): void {
    if (this.child) return;

    try {
      const child = spawn(this.caffeinatePath, ["-i", "-w", String(this.pid)], {
        stdio: "ignore",
      });

      this.child = child;
      child.once("error", () => {
        if (this.child === child) this.child = undefined;
      });
      child.once("exit", () => {
        if (this.child === child) this.child = undefined;
      });
      child.unref();
    } catch {
      this.child = undefined;
    }
  }

  private stop(): void {
    const child = this.child;
    if (!child) return;

    this.child = undefined;
    if (!child.killed) child.kill("SIGTERM");
  }
}

export interface SleepInhibitor {
  readonly isInhibiting: boolean;
  acquire(): boolean;
  release(): void;
  forceStop(): void;
  /** Set by the extension; called at most once when inhibition becomes unavailable. */
  onUnavailable?: ((message: string) => void) | undefined;
}

/** Select the platform backend: `caffeinate` on macOS, `systemd-inhibit` on Linux, no-op elsewhere. */
export function createSleepInhibitor(platform: NodeJS.Platform = process.platform): SleepInhibitor {
  return platform === "linux" ? new LinuxSleepInhibitor({ platform }) : new MacSleepInhibitor({ platform });
}
