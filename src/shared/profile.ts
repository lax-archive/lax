// Wall-clock and peak-memory profiling of the validation pipeline. Timing is
// always collected — a handful of `performance.now()` calls around work that
// takes seconds — and printed by `lax build --profile`, recorded next to the
// validation outputs, and echoed into the workflow step summary. Peak memory
// rides along where the executors can observe it (the container cgroup's
// high-water mark, sampled host process trees). It is diagnostics, never
// evidence: nothing the trusted publisher authenticates reads it, and a
// profiling failure never fails a validation.
//
// Spans nest: a phase opens one, the container invocations inside it open
// their own. The current span travels through `AsyncLocalStorage` rather
// than a stack, because the pipeline really does run spans concurrently
// (source and Archive fetch together, dependency captures four at a time) —
// a stack would attribute those children to whichever peer span happened to
// open last.

import { AsyncLocalStorage } from "node:async_hooks";

export interface Span {
  name: string;
  ms: number;
  children: Span[];
  /**
   * One container invocation. Summarized separately because container
   * startup, paid once per phase per job, is the cost the workflow's
   * one-job-or-many layout turns on.
   */
  container?: true;
  /**
   * Peak memory observed while the span ran, in bytes: the container
   * cgroup's kernel-maintained `memory.peak` for container invocations,
   * sampled process-tree RSS for host phase children. Best-effort
   * diagnostics — absent whenever nothing could measure it, and optional in
   * every recorded profile so older consumers keep working.
   */
  peakMemoryBytes?: number;
}

export interface SpanOptions {
  container?: true;
}

// Module-level rather than per-profiler, so a low-level executor (the host
// process runner, the container runner's memory monitor) can attribute an
// observation to whichever span is open on its task without threading the
// profiler through every call site. Concurrent profilers stay separate: each
// async task sees only the span its own profiler opened on it.
const openSpan = new AsyncLocalStorage<Span>();

export class Profiler {
  readonly root: Span = { name: "total", ms: 0, children: [] };
  private readonly startedAt = performance.now();

  /** Time `operation` as a child of the span currently open on this task. */
  async span<T>(
    name: string,
    operation: () => Promise<T> | T,
    options: SpanOptions = {},
  ): Promise<T> {
    const span: Span = {
      name,
      ms: 0,
      children: [],
      ...(options.container === true ? { container: true as const } : {}),
    };
    (openSpan.getStore() ?? this.root).children.push(span);
    const started = performance.now();
    try {
      return await openSpan.run(span, operation);
    } finally {
      span.ms = performance.now() - started;
    }
  }

  /**
   * The span tree with the root's duration closed off at now. Safe to call on
   * an aborted pipeline: whatever ran is what is reported.
   */
  snapshot(): Span {
    return { ...this.root, ms: performance.now() - this.startedAt };
  }
}

/**
 * Record a peak-memory observation, in bytes, against the span currently
 * open on this task, keeping the maximum. Callable from any code running
 * under a span; an observation outside every span, or a non-positive or
 * non-finite value, is dropped silently — profiling is best-effort
 * diagnostics and must never fail a validation.
 */
export function notePeakMemory(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const span = openSpan.getStore();
  if (span === undefined) return;
  if (span.peakMemoryBytes === undefined || bytes > span.peakMemoryBytes) {
    span.peakMemoryBytes = bytes;
  }
}

export function formatMs(ms: number): string {
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${(ms / 1_000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)}GiB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(0)}MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KiB`;
  return `${Math.round(bytes)}B`;
}

/**
 * Render the span tree: name, duration, share of the total, and — where an
 * executor measured one — the span's peak memory, deepest nesting indented.
 * A span whose children leave more than a second unaccounted for gets an
 * explicit `(other)` line, so the columns add up and nothing hides in the
 * gaps. Concurrent children can outrun their parent; no `(other)` line is
 * invented for the negative remainder that produces. When any span carries a
 * peak, a closing `peak memory` line reports the largest — the run's
 * headroom against the runner's memory ceiling.
 */
export function formatProfile(root: Span): string {
  const total = root.ms || 1;
  const lines = ["== profile =="];

  const emit = (span: Span, depth: number): void => {
    const indent = "  ".repeat(depth);
    const percent = ((span.ms / total) * 100).toFixed(0).padStart(3);
    const peak =
      span.peakMemoryBytes === undefined ? "" : `  peak ${formatBytes(span.peakMemoryBytes)}`;
    lines.push(
      `${(indent + span.name).padEnd(44)}${formatMs(span.ms).padStart(8)}  ${percent}%${peak}`,
    );
    for (const child of span.children) emit(child, depth + 1);
    const accounted = span.children.reduce((sum, child) => sum + child.ms, 0);
    const rest = span.ms - accounted;
    if (span.children.length > 0 && rest > 1_000) {
      emit({ name: "(other)", ms: rest, children: [] }, depth + 1);
    }
  };

  emit(root, 0);

  const containers: Span[] = [];
  const collect = (span: Span): void => {
    if (span.container === true) containers.push(span);
    for (const child of span.children) collect(child);
  };
  collect(root);
  if (containers.length > 0) {
    const spent = containers.reduce((sum, span) => sum + span.ms, 0);
    const shortest = containers.reduce((least, span) => Math.min(least, span.ms), Infinity);
    lines.push(
      `${`containers: ${containers.length} runs`.padEnd(44)}${formatMs(spent).padStart(8)}  ` +
        `${((spent / total) * 100).toFixed(0).padStart(3)}%`,
    );
    // The cheapest invocation is the runtime manifest read: near-pure
    // container startup, so it prices every other invocation's overhead.
    lines.push(`${"  shortest run (startup floor)".padEnd(44)}${formatMs(shortest).padStart(8)}`);
  }

  let heaviest: number | undefined;
  const findPeaks = (span: Span): void => {
    if (span.peakMemoryBytes !== undefined && (heaviest === undefined || span.peakMemoryBytes > heaviest)) {
      heaviest = span.peakMemoryBytes;
    }
    for (const child of span.children) findPeaks(child);
  };
  findPeaks(root);
  if (heaviest !== undefined) {
    lines.push(`${"peak memory (heaviest span)".padEnd(44)}${formatBytes(heaviest).padStart(8)}`);
  }
  return lines.join("\n");
}
