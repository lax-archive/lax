import { spawn } from "node:child_process";
import fs from "node:fs";
import { notePeakMemory } from "../../shared/profile.js";

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
    // Peak-memory profiling of the child's process tree, attributed to
    // whichever profiler span is open on this task (a no-op outside one).
    // Diagnostics only: any sampling failure just means no number.
    const memoryTimer =
      process.platform === "linux" && child.pid !== undefined
        ? setInterval(() => {
            const sample = sampleTreeMemoryBytes(child.pid!);
            if (sample !== undefined) notePeakMemory(sample);
          }, MEMORY_SAMPLE_INTERVAL_MS)
        : undefined;
    memoryTimer?.unref();
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
      if (memoryTimer !== undefined) clearInterval(memoryTimer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (memoryTimer !== undefined) clearInterval(memoryTimer);
      if (timedOut) output += `\n[killed after ${Math.round(opts.timeoutMs! / 1000)}s timeout]\n`;
      resolve({ code: timedOut ? 124 : (code ?? 1), output });
    });
  });
}

const MEMORY_SAMPLE_INTERVAL_MS = 250;

/** The memory-relevant lines of a /proc/<pid>/status blob; absent lines
 * yield absent fields (kernel threads report no Vm* values). */
export interface ProcMemoryStatus {
  ppid?: number;
  vmRssBytes?: number;
  vmHwmBytes?: number;
}

export function parseProcStatus(text: string): ProcMemoryStatus {
  const result: ProcMemoryStatus = {};
  for (const line of text.split("\n")) {
    const match = /^(PPid|VmRSS|VmHWM):\s+(\d+)/u.exec(line);
    if (match === null) continue;
    const value = Number(match[2]);
    if (match[1] === "PPid") result.ppid = value;
    else if (match[1] === "VmRSS") result.vmRssBytes = value * 1024; // kB units
    else result.vmHwmBytes = value * 1024;
  }
  return result;
}

/**
 * One best-effort sample of the memory the child's process tree holds right
 * now: summed VmRSS over the child and its descendants (lake spawns the lean
 * workers that carry the real footprint), floored by the child's own
 * kernel-tracked high-water mark (VmHWM) so a spike on the direct child
 * between samples is not lost. Linux-only; any failure yields undefined.
 */
function sampleTreeMemoryBytes(rootPid: number): number | undefined {
  try {
    const rss = new Map<number, number>();
    const childrenOf = new Map<number, number[]>();
    let rootHwm = 0;
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      let status: ProcMemoryStatus;
      try {
        status = parseProcStatus(fs.readFileSync(`/proc/${entry}/status`, "utf8"));
      } catch {
        continue; // the process exited mid-scan
      }
      rss.set(pid, status.vmRssBytes ?? 0);
      if (status.ppid !== undefined) {
        const siblings = childrenOf.get(status.ppid) ?? [];
        siblings.push(pid);
        childrenOf.set(status.ppid, siblings);
      }
      if (pid === rootPid) rootHwm = status.vmHwmBytes ?? 0;
    }
    if (!rss.has(rootPid)) return undefined;
    // The /proc scan is not atomic, so guard the walk against a pid-reuse
    // artifact ever forming a cycle: each pid is counted once.
    let sum = 0;
    const visited = new Set<number>();
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      sum += rss.get(pid) ?? 0;
      queue.push(...(childrenOf.get(pid) ?? []));
    }
    return Math.max(sum, rootHwm);
  } catch {
    return undefined;
  }
}
