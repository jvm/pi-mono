import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface Transport {
  pid: number;
  write(chars: string): void;
  dispose(): void;
}

export interface TransportOptions {
  cmd: string;
  cwd: string;
  tty: boolean;
  onData(data: Buffer): void;
  onExit(exitCode: number | null, signal: string | null): void;
}

/** Lazy PTY loading keeps the pipe path usable without a native binding. */
export async function launch(options: TransportOptions): Promise<Transport> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("pi-processes supports macOS and Linux only");
  }
  const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const args = process.platform === "darwin" ? ["-f", "-c", options.cmd] : ["--noprofile", "--norc", "-c", options.cmd];
  if (options.tty) {
    let pty: typeof import("node-pty");
    try {
      pty = await import("node-pty");
    } catch {
      throw new Error("PTY support is unavailable. Install node-pty 1.1.0 with its native binding, or use tty:false.");
    }
    const term = pty.spawn(shell, args, {
      cwd: options.cwd, env: process.env as Record<string, string>,
      name: "xterm-256color", cols: 120, rows: 40,
    });
    const data = term.onData(value => options.onData(Buffer.from(value)));
    const exit = term.onExit(event => options.onExit(event.exitCode, event.signal ? String(event.signal) : null));
    return { pid: term.pid, write: chars => term.write(chars), dispose: () => { data.dispose(); exit.dispose(); } };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: options.cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    // Decode each stream independently before merging; split UTF-8 must survive.
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    child.stdout.on("data", data => options.onData(Buffer.from(out.write(data))));
    child.stderr.on("data", data => options.onData(Buffer.from(err.write(data))));
    child.once("error", reject);
    child.once("spawn", () => resolve({
      pid: child.pid!,
      write: () => { throw new Error("Input requires tty:true"); },
      dispose: () => { child.stdout.destroy(); child.stderr.destroy(); },
    }));
    child.once("exit", () => {
      // A child keeping inherited fds open must not prevent the shell's close event.
      if (child.pid) {
        try { signalGroup(child.pid, "SIGKILL"); } catch { /* close will still drain output */ }
      }
    });
    child.once("close", (code, signal) => {
      options.onData(Buffer.from(out.end() + err.end()));
      options.onExit(code, signal);
    });
  });
}

/** Both forkpty and detached pipe children own a POSIX process group. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
