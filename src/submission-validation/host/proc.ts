import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string; // interleaved stdout+stderr
}

/** How a host pipeline phase executes commands; tests substitute a recording
 * or failing executor here. */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

export interface RunOptions {
  echo?: boolean;
  env?: Record<string, string>;
  /** kill the process group and resolve with code 124 after this long —
   * unset for interactive local builds, so Ctrl+C stays in charge */
  timeoutMs?: number;
  /** stop accumulating the transcript beyond this size; the overflow is
   * dropped with a marker, the process keeps running */
  maxOutputBytes?: number;
}

/**
 * Run a command, capturing interleaved output. When `echo` is set the output
 * is also streamed to our stdout (used to reprint build transcripts). `env`
 * entries are overlaid on the process environment.
 */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // a timeout must reap the whole tree (lake spawns lean workers), so the
    // child gets its own process group to signal; without a timeout the
    // child stays in ours so Ctrl+C reaches it
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      detached: opts.timeoutMs !== undefined,
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, opts.timeoutMs)
        : undefined;
    const sink = (data: Buffer): void => {
      if (opts.maxOutputBytes !== undefined && output.length >= opts.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          output += "\n[transcript truncated]\n";
        }
      } else {
        output += data.toString();
      }
      if (opts.echo) process.stdout.write(data);
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (e) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) output += `\n[killed after ${Math.round(opts.timeoutMs! / 1000)}s timeout]\n`;
      resolve({ code: timedOut ? 124 : (code ?? 1), output });
    });
  });
}
