const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ProgressOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string): unknown;
}

export function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export class LoadingLine {
  private frame = 0;
  private active = false;
  private previous?: string;

  constructor(private readonly output: ProgressOutput) {}

  /**
   * `detail` (an elapsed time, say) belongs to the live line only: a log
   * without a cursor to rewrite would otherwise get a new line per tick, so
   * there the message alone decides whether anything is printed.
   */
  update(message: string, detail?: string): void {
    if (this.output.isTTY === true) {
      const indicator = spinner[this.frame % spinner.length]!;
      this.frame += 1;
      this.output.write(`\r\u001B[2K${indicator} ${message}${detail === undefined ? "" : ` · ${detail}`}`);
      this.active = true;
    } else if (message !== this.previous) {
      this.output.write(`${message}\n`);
    }
    this.previous = message;
  }

  clear(): void {
    if (this.active) this.output.write("\r\u001B[2K");
    this.active = false;
  }
}

interface Row {
  readonly key: string;
  label: string;
  started: number;
  detail?: string;
  settled?: readonly string[];
}

export interface LoadingBlockOptions {
  /** Where a settled row's final lines go. Defaults to `console.log`, which
   * keeps a report on stdout while the live region uses the raw stream. */
  readonly commit?: (line: string) => void;
  readonly now?: () => number;
  /** Prefix for live rows, to align the spinner with the settled mark. */
  readonly indent?: string;
  /** How long a row must be pending before its elapsed time is shown. */
  readonly elapsedAfterMs?: number;
}

/**
 * Several concurrent tasks, each a line that spins until it settles.
 *
 * Rows are declared in display order and settle in completion order, so a row
 * is committed — printed for good, above the live region — only once every row
 * before it has settled too. That keeps the report's order stable no matter
 * how the work interleaves, keeps the redrawn region small enough to stay
 * within the terminal, and degrades to exactly that streamed prefix when there
 * is no cursor to rewrite.
 */
export class LoadingBlock {
  private readonly rows: Row[] = [];
  private readonly commit: (line: string) => void;
  private readonly now: () => number;
  private readonly indent: string;
  private readonly elapsedAfterMs: number;
  private liveLines = 0;
  private frame = 0;
  private committed = 0;
  private cursorHidden = false;
  private detach?: () => void;

  constructor(private readonly output: ProgressOutput, options: LoadingBlockOptions = {}) {
    this.commit = options.commit ?? ((line) => { console.log(line); });
    this.now = options.now ?? Date.now;
    this.indent = options.indent ?? "";
    this.elapsedAfterMs = options.elapsedAfterMs ?? 3_000;
  }

  add(key: string, label: string): void {
    this.rows.push({ key, label, started: this.now() });
  }

  /** Replace a row's label — for work whose nature is only known once it
   * starts (an install the caller discovered it has to do, say). */
  relabel(key: string, label: string): void {
    const row = this.row(key);
    if (row !== undefined) row.label = label;
    this.render();
  }

  /** Say that a row cannot start yet, and what it is queued behind. */
  waiting(key: string, reason: string): void {
    const row = this.row(key);
    if (row !== undefined) row.detail = reason;
    this.render();
  }

  /** The row's own work has begun: drop whatever it was queued behind and
   * restart its clock, so the elapsed time measures the work rather than the
   * wait in front of it. */
  begin(key: string): void {
    const row = this.row(key);
    if (row !== undefined) {
      row.detail = undefined;
      row.started = this.now();
    }
    this.render();
  }

  /** Extra text on a still-pending row — a running count, say. */
  progress(key: string, detail: string): void {
    const row = this.row(key);
    if (row !== undefined) row.detail = detail;
    this.render();
  }

  /** Finish a row. `lines` is its final output; an empty array drops the row
   * from the report without disturbing the ones after it. */
  settle(key: string, lines: readonly string[]): void {
    const row = this.row(key);
    if (row !== undefined) row.settled = lines;
    this.render();
  }

  /** Redraw the live region, advancing the spinner. Safe to call on a timer. */
  render(): void {
    this.erase();
    while (this.rows[this.committed]?.settled !== undefined) {
      for (const line of this.rows[this.committed]!.settled!) this.commit(line);
      this.committed += 1;
    }
    if (this.output.isTTY !== true) return;
    const live = this.rows.slice(this.committed);
    if (live.length === 0) return;
    this.frame += 1;
    // A pty can report 0 columns (no window size attached — `script`, some CI
    // terminals). Nullish coalescing alone let that through and truncated
    // every row to nothing.
    const columns = this.output.columns;
    const width = (columns !== undefined && columns > 0 ? columns : 80) - 1;
    let text = "";
    if (!this.cursorHidden) {
      text += "\u001B[?25l";
      this.hideCursor();
    }
    for (const row of live) text += `${truncate(this.line(row), width)}\n`;
    this.output.write(text);
    this.liveLines = live.length;
  }

  /** Commit what settled, drop the live region, and give the cursor back. */
  finish(): void {
    this.render();
    this.erase();
    this.showCursor();
  }

  /**
   * A hidden cursor outlives the process that hid it, so the ways out that
   * skip the caller's `finally` have to put it back too. Ctrl-C during a run
   * that can legitimately take minutes is the common one, and Node's default
   * SIGINT kill runs no `exit` handler — installing a handler suppresses that
   * default, so it has to terminate the process itself.
   */
  private hideCursor(): void {
    if (this.detach !== undefined) return;
    this.cursorHidden = true;
    const restore = (): void => { this.showCursor(); };
    const onSignal = (signal: NodeJS.Signals): void => {
      this.showCursor();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.on("exit", restore);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    this.detach = (): void => {
      process.off("exit", restore);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
  }

  private showCursor(): void {
    if (!this.cursorHidden) return;
    this.cursorHidden = false;
    this.output.write("\u001B[?25h");
    this.detach?.();
    this.detach = undefined;
  }

  private row(key: string): Row | undefined {
    return this.rows.find((row) => row.key === key);
  }

  /** A settled row held back by an unsettled one before it still shows its
   * result — only its place in the report is waiting, not its answer. */
  private line(row: Row): string {
    if (row.settled !== undefined) return row.settled[0] ?? "";
    const waited = this.now() - row.started;
    const parts = [row.label];
    if (row.detail !== undefined) parts.push(row.detail);
    if (waited >= this.elapsedAfterMs) parts.push(elapsed(waited));
    return `${this.indent}${spinner[this.frame % spinner.length]!} ${parts.join(" · ")}`;
  }

  private erase(): void {
    if (this.liveLines === 0) return;
    this.output.write(`\u001B[${this.liveLines}A\r\u001B[0J`);
    this.liveLines = 0;
  }
}

/** Wrapping would desynchronise the cursor arithmetic that redraws the region,
 * so a long line is cut rather than allowed to occupy two. */
function truncate(line: string, width: number): string {
  if (width <= 1) return "";
  const characters = [...line];
  return characters.length <= width ? line : `${characters.slice(0, width - 1).join("")}…`;
}
