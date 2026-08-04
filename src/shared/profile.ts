// Wall-clock profiling of the validation pipeline. Timing is always
// collected — a handful of `performance.now()` calls around work that takes
// seconds — and printed by `lax build --profile`, recorded next to the
// validation outputs, and echoed into the workflow step summary. It is
// diagnostics, never evidence: nothing the trusted publisher authenticates
// reads it, and a profiling failure never fails a validation.
//
// Spans nest: a phase opens one, the container invocations inside it open
// their own. The current span travels through `AsyncLocalStorage` rather
// than a stack, because the pipeline really does run spans concurrently
// (source and Archive fetch together, dependency captures four at a time) —
// a stack would attribute those children to whichever sibling happened to
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
}

export interface SpanOptions {
  container?: true;
}

export class Profiler {
  readonly root: Span = { name: "total", ms: 0, children: [] };
  private readonly startedAt = performance.now();
  private readonly open = new AsyncLocalStorage<Span>();

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
    (this.open.getStore() ?? this.root).children.push(span);
    const started = performance.now();
    try {
      return await this.open.run(span, operation);
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

export function formatMs(ms: number): string {
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${(ms / 1_000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

/**
 * Render the span tree: name, duration, and share of the total, deepest
 * nesting indented. A span whose children leave more than a second
 * unaccounted for gets an explicit `(other)` line, so the columns add up and
 * nothing hides in the gaps. Concurrent children can outrun their parent; no
 * `(other)` line is invented for the negative remainder that produces.
 */
export function formatProfile(root: Span): string {
  const total = root.ms || 1;
  const lines = ["== profile =="];

  const emit = (span: Span, depth: number): void => {
    const indent = "  ".repeat(depth);
    const percent = ((span.ms / total) * 100).toFixed(0).padStart(3);
    lines.push(`${(indent + span.name).padEnd(44)}${formatMs(span.ms).padStart(8)}  ${percent}%`);
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
  return lines.join("\n");
}
