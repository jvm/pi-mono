import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

export const DEFAULT_SYSTEMD_INHIBIT_PATHS = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"] as const;
export const DEFAULT_CAT_PATHS = ["/usr/bin/cat", "/bin/cat"] as const;

// Bound the helper's stderr that is kept for the refusal notice.
const MAX_STDERR_BYTES = 1024;
const MAX_REASON_CHARS = 200;
// How long to wait after exit for stderr to end before judging the exit.
const STDERR_DRAIN_MS = 250;
// systemd 257 added `--no-ask-password`; older releases reject it during option
// parsing (getopt names the option in any locale) and never ask for interactive
// authorization, so they run safely without it.
const NO_ASK_PASSWORD = "--no-ask-password";

export type Spawner = (command: string, args: readonly string[]) => ChildProcess;

export interface LinuxSleepInhibitorOptions {
  platform?: NodeJS.Platform;
  /** Candidate absolute paths for `systemd-inhibit`; the first existing one is used. */
  systemdInhibitPaths?: readonly string[];
  /** Candidate absolute paths for `cat`, the command that holds the lock. */
  catPaths?: readonly string[];
  exists?: (path: string) => boolean;
  spawn?: Spawner;
}

const defaultSpawner: Spawner = (command, args) => spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });

/**
 * Holds a systemd-logind `idle:sleep` inhibitor lock while the agent works.
 *
 * `systemd-inhibit` keeps the lock until its command exits. The command is `cat`
 * reading a pipe from Pi: stopping closes the pipe and terminates the helper, and
 * if Pi exits unexpectedly the pipe closes too, so the lock never outlives Pi.
 */
export class LinuxSleepInhibitor {
  private readonly platform: NodeJS.Platform;
  private readonly systemdInhibitPaths: readonly string[];
  private readonly catPaths: readonly string[];
  private readonly exists: (path: string) => boolean;
  private readonly spawner: Spawner;
  private child: ChildProcess | undefined;
  private active = false;
  private unavailable = false;
  private noAskPassword = true;

  /** Called once when inhibition is unavailable (missing binary or refused lock). */
  onUnavailable: ((message: string) => void) | undefined;

  constructor(options: LinuxSleepInhibitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.systemdInhibitPaths = options.systemdInhibitPaths ?? DEFAULT_SYSTEMD_INHIBIT_PATHS;
    this.catPaths = options.catPaths ?? DEFAULT_CAT_PATHS;
    this.exists = options.exists ?? existsSync;
    this.spawner = options.spawn ?? defaultSpawner;
  }

  get isSupported(): boolean {
    return this.platform === "linux" && !this.unavailable;
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
    this.active = false;
    this.stop();
  }

  forceStop(): void {
    this.active = false;
    this.stop();
  }

  private start(): void {
    if (this.child) return;

    const inhibit = this.systemdInhibitPaths.find((path) => this.exists(path));
    const cat = this.catPaths.find((path) => this.exists(path));
    if (!inhibit || !cat) {
      this.markUnavailable(
        inhibit
          ? "pi-insomnia: `cat` was not found; sleep prevention is off."
          : "pi-insomnia: `systemd-inhibit` was not found; sleep prevention is off.",
      );
      return;
    }

    const noAskPassword = this.noAskPassword;
    let child: ChildProcess;
    try {
      child = this.spawner(inhibit, [
        "--what=idle:sleep",
        "--who=pi-insomnia",
        "--why=Pi agent is working",
        "--mode=block",
        ...(noAskPassword ? [NO_ASK_PASSWORD] : []),
        cat,
      ]);
    } catch (error) {
      this.markUnavailable(`pi-insomnia: could not start systemd-inhibit (${describeError(error)}); sleep prevention is off.`);
      return;
    }

    this.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr = (stderr + chunk).slice(0, MAX_STDERR_BYTES);
    });
    // The pipe only signals Pi's lifetime; a closed reader must not crash Pi.
    child.stdin?.on("error", () => {});
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.markUnavailable(`pi-insomnia: could not start systemd-inhibit (${describeError(error)}); sleep prevention is off.`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      // Only Pi closes the pipe, so any exit while held means the lock was refused or lost.
      afterStderrDrains(child, () => {
        if (noAskPassword && stderr.includes(NO_ASK_PASSWORD)) {
          // systemd < 257: retry once without the option.
          this.noAskPassword = false;
          if (this.active && !this.unavailable) this.start();
          return;
        }
        const reason = firstLine(stderr) ?? (signal ? `signal ${signal}` : `exit code ${code}`);
        this.markUnavailable(`pi-insomnia: systemd-inhibit refused the sleep inhibitor (${reason}); sleep prevention is off.`);
      });
    });
    unrefStream(child.stdin);
    unrefStream(child.stderr);
    child.unref();
  }

  private stop(): void {
    const child = this.child;
    if (!child) return;

    this.child = undefined;
    child.stdin?.destroy();
    child.stderr?.destroy();
    if (!child.killed) child.kill("SIGTERM");
  }

  private markUnavailable(message: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.active = false;
    this.onUnavailable?.(message);
  }
}

// A held `cat` inherits stderr, so stderr may stay open after systemd-inhibit
// exits; wait for it to end, but no longer than STDERR_DRAIN_MS.
function afterStderrDrains(child: ChildProcess, done: () => void): void {
  const stderr = child.stderr;
  if (!stderr || stderr.readableEnded || stderr.destroyed) {
    done();
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, STDERR_DRAIN_MS);
  timer.unref?.();
  stderr.once("end", finish);
  stderr.once("close", finish);
}

function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return undefined;
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}…` : line;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message.slice(0, MAX_REASON_CHARS) : "unknown error";
}
