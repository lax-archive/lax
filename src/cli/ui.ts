// The CLI's presentation layer: every shape the author's terminal is allowed
// to show, in one place.
//
// The rules it enforces, so no command has to remember them:
//   - No command-name prefixes. The author knows what they typed.
//   - One title, one verdict. Notes last, in one block, each with its fix.
//   - Internals — run ids, comment URLs, archive commits, dispatch outcomes —
//     are `verbose()` and never reach the happy path.
//   - Colour is one accent and one dim: green ✓, yellow !, red ✗, dim details,
//     bold for the verdict and for commands the author should type.
//   - Piped output is the same words: no spinner, no cursor tricks, one line
//     per settled step, still complete. Agents read what this prints.
//
// Layout is a two-space indent throughout, with step labels padded to a fixed
// column so details line up down the block.

import path from "node:path";
import os from "node:os";
import { elapsed, LoadingBlock } from "./loading.js";

export type Status = "ok" | "warn" | "fail";

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Two-space indent, then `mark` and a space: the column details align to. */
export const INDENT = "  ";
/** Label column for a command's step list; `lax doctor` uses a narrower one. */
export const LABEL_WIDTH = 26;

let verboseEnabled = false;
let colorEnabled = defaultColor();
let lastWasBlank = true;

function defaultColor(): boolean {
  // NO_COLOR is a promise, not a preference (no-color.org); FORCE_COLOR is the
  // way a caller asks for colour through a pipe.
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return process.stdout.isTTY === true;
}

export function configure(options: { verbose?: boolean; color?: boolean } = {}): void {
  if (options.verbose !== undefined) verboseEnabled = options.verbose;
  if (options.color === false) colorEnabled = false;
  else if (options.color === true) colorEnabled = defaultColor();
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

function paint(code: string, value: string): string {
  return colorEnabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

export const bold = (value: string): string => paint("1", value);
export const dim = (value: string): string => paint("2", value);
export const green = (value: string): string => paint("32", value);
export const yellow = (value: string): string => paint("33", value);
export const red = (value: string): string => paint("31", value);

/** A command the author should type, so it stands out from the prose. */
export const cmd = (value: string): string => bold(value);

/**
 * Every step block currently drawing a live region.
 *
 * Anything printed while one of them is on screen has to erase it first: the
 * block redraws itself by counting the lines it wrote, so a line it does not
 * know about is a line it will erase instead of its own. Registering the blocks
 * here means no caller has to remember the ordering — a note, a verdict, or a
 * failure can be printed at any moment and the block simply redraws under it.
 */
const live = new Set<{ suspend(): void }>();
let committing = false;

function suspendLive(): void {
  // A commit *is* the block writing its own settled lines, mid-redraw; erasing
  // from inside that would recurse and lose the arithmetic it is doing.
  if (committing) return;
  for (const block of live) block.suspend();
}

/**
 * Not everything that writes to this terminal goes through `write()`.
 *
 * `lake`'s transcript under `--verbose`, the warm store's once-per-machine
 * notices, a stray `console.log` in a module that has no idea a CLI is drawing
 * anything — each lands in the middle of the live region, and a region that
 * erases itself by counting the lines it wrote will then erase somebody else's
 * line and leave one of its own behind. That is what a step list duplicating
 * its spinning row is.
 *
 * So while a block is live the two streams are wrapped: any write not made by
 * a block itself drops the region first, and the next tick draws it again below
 * the new text. `depth` is how a block's own writes say "this one is mine".
 */
let depth = 0;
let unguard: (() => void) | undefined;

function guardStreams(): void {
  if (unguard !== undefined) return;
  const restores = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((...args: Parameters<typeof stream.write>) => {
      if (depth === 0) suspendLive();
      return original(...args);
    }) as typeof stream.write;
    return () => {
      stream.write = original;
    };
  });
  unguard = () => {
    for (const restore of restores) restore();
  };
}

function releaseStreams(): void {
  if (live.size > 0 || unguard === undefined) return;
  unguard();
  unguard = undefined;
}

/** stdout as a block writes it: its own output, exempt from the guard above. */
const blockOutput = {
  get isTTY(): boolean | undefined {
    return process.stdout.isTTY;
  },
  get columns(): number | undefined {
    return process.stdout.columns;
  },
  write(chunk: string): unknown {
    depth += 1;
    try {
      return process.stdout.write(chunk);
    } finally {
      depth -= 1;
    }
  },
};

function write(text: string): void {
  suspendLive();
  console.log(text);
  lastWasBlank = text === "";
}

/** One blank line, never two. */
export function blank(): void {
  if (!lastWasBlank) write("");
}

/** The one line a slow command opens with. */
export function title(text: string): void {
  blank();
  write(`${INDENT}${text}`);
  write("");
  lastWasBlank = true;
}

/** Plain indented prose. */
export function line(text = ""): void {
  write(text === "" ? "" : `${INDENT}${text}`);
}

/** Indented prose in the dim voice details use. */
export function faint(text: string): void {
  write(`${INDENT}${dim(text)}`);
}

/** The bold one-line answer a command closes with. */
export function verdict(text: string): void {
  blank();
  write(`${INDENT}${bold(text)}`);
}

/** The one link worth clicking: the author's own page. */
export function link(url: string): void {
  write(`${INDENT}${url}`);
}

/**
 * A labelled closing line — `Cite  …`, `Open  …`. The label is dim and the
 * content is not, so the eye lands on the thing rather than on its heading.
 */
export function aside(label: string, text: string): void {
  write(`${INDENT}${dim(label)}  ${text}`);
}

/** Close a command that printed its verdict. */
export function done(): void {
  blank();
}

/** Internals: run ids, URLs, commits, transcripts. Never on the happy path. */
export function verbose(text: string): void {
  if (!verboseEnabled) return;
  for (const part of text.split("\n")) write(`${INDENT}${dim(part)}`);
}

/**
 * The diagnosis a failed command found — a red headline and its detail, in the
 * same shape as a note and in the same place. On stdout with the rest of the
 * report: this is report content whose order relative to the step rows is the
 * whole point, the exit code is what carries the failure, and an agent reading
 * one stream must not lose the diagnosis. `failure()` below is the other case —
 * an error thrown out of a command, where there is no report at all.
 */
export function problem(headline: string, body: readonly string[] = []): void {
  blank();
  write(`${INDENT}${red("✗")} ${headline}`);
  for (const text of body) write(`${INDENT}  ${text}`);
}

/**
 * The failure a command dies of. Continuation lines are indented under it, so a
 * multi-line message (a list of missing tools, a compile transcript) stays
 * visibly one answer.
 */
export function failure(message: string): void {
  suspendLive();
  const [first, ...rest] = message.split("\n");
  process.stderr.write(`${INDENT}${red("✗")} ${first ?? ""}\n`);
  for (const part of rest) process.stderr.write(part === "" ? "\n" : `${INDENT}  ${part}\n`);
  process.stderr.write("\n");
  lastWasBlank = true;
}

/** `~/foodir`, which is how an author refers to their own folder. */
export function tilde(target: string): string {
  const home = os.homedir();
  const resolved = path.resolve(target);
  if (resolved === home) return "~";
  return resolved.startsWith(home + path.sep)
    ? `~${path.sep}${path.relative(home, resolved)}`
    : resolved;
}

/** `1,204` — a count an author reads at a glance. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** `4 concepts`, `1 proof`. */
export function plural(value: number, noun: string, plural_ = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural_}`;
}

/**
 * One row of a step list: mark, label, detail, elapsed — each in its column so
 * the details line up whatever the labels are.
 */
export function formatRow(options: {
  mark: string;
  label: string;
  detail?: string;
  time?: string;
  labelWidth?: number;
}): string {
  const width = options.labelWidth ?? LABEL_WIDTH;
  const { detail, time } = options;
  let text = `${INDENT}${options.mark} `;
  if (detail === undefined && time === undefined) return text + options.label;
  text += pad(options.label, width);
  if (detail !== undefined) text += time === undefined ? dim(detail) : dim(pad(detail, width));
  if (time !== undefined) text += dim(time);
  return text;
}

/** The column a row's detail starts in — where its fix lines belong too. */
export function detailColumn(labelWidth = LABEL_WIDTH): string {
  return " ".repeat(INDENT.length + 2 + labelWidth);
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

/**
 * Everything actionable a command found, printed once, after the verdict, each
 * with the fix on the line below it. A `!` in the left column and nothing else:
 * a note is a thing to do, not a thing to be alarmed by.
 */
export class Notes {
  private readonly entries: Array<{ headline: string; body: readonly string[] }> = [];

  add(headline: string, ...body: string[]): void {
    this.entries.push({ headline, body });
  }

  get size(): number {
    return this.entries.length;
  }

  print(): void {
    if (this.entries.length === 0) return;
    blank();
    for (const entry of this.entries) {
      write(`${INDENT}${yellow("!")} ${entry.headline}`);
      for (const body of entry.body) write(`${INDENT}  ${body}`);
    }
  }
}

export interface StepOutcome {
  /** Which mark the row settles with. Defaults to `ok`. */
  status?: Status;
  /** Final label, when it differs from the one the row spun under. */
  label?: string;
  detail?: string;
  /**
   * The elapsed time. Left out on anything under three seconds, because a row
   * that settled instantly did no work worth timing; `false` suppresses it
   * outright, a string overrides it.
   */
  time?: string | false;
  /** Continuation lines under the detail column — a fix, say. */
  under?: readonly string[];
  /** Drop the row from the report: the work turned out to be nothing. */
  hidden?: boolean;
}

/**
 * A step list: declared rows that settle in completion order and commit in
 * declaration order, so the report never reorders itself. Without a cursor to
 * rewrite it degrades to exactly that committed prefix — one line per settled
 * step, same words.
 *
 * The rows run one at a time unless `concurrent` says otherwise, and only the
 * running one spins: a step still waiting its turn is a plan, drawn dim under a
 * `·`, with no clock of its own to disagree with the one above it.
 */
export class Steps {
  private readonly block: LoadingBlock;
  private readonly labelWidth: number;
  private ticker?: NodeJS.Timeout;
  private readonly openedAt = Date.now();

  constructor(options: { labelWidth?: number; concurrent?: boolean } = {}) {
    this.labelWidth = options.labelWidth ?? LABEL_WIDTH;
    live.add(this);
    guardStreams();
    this.block = new LoadingBlock(blockOutput, {
      indent: INDENT,
      concurrent: options.concurrent ?? false,
      commit: (text) => {
        committing = true;
        try {
          write(text);
        } finally {
          committing = false;
        }
      },
      pending: (row) =>
        row.started
          ? formatRow({
              mark: row.spinner,
              label: row.label,
              ...(row.detail === undefined ? {} : { detail: row.detail }),
              ...(row.time === undefined ? {} : { time: row.time }),
              labelWidth: this.labelWidth,
            })
          : dim(formatRow({ mark: "·", label: row.label, labelWidth: this.labelWidth })),
    });
  }

  add(key: string, label: string): this {
    this.block.add(key, label);
    this.ticker ??= setInterval(() => this.block.render(), 100);
    return this;
  }

  /** Replace a row's label, for work whose nature is only known once it starts. */
  relabel(key: string, label: string): void {
    this.block.relabel(key, label);
  }

  /** Extra text on a still-spinning row: what it is doing right now. */
  detail(key: string, text: string): void {
    this.block.progress(key, text);
  }

  /** Say that a row cannot start yet, and what it is queued behind. */
  waiting(key: string, reason: string): void {
    this.block.waiting(key, reason);
  }

  /** This row's own work has begun: restart its clock. */
  begin(key: string): void {
    this.block.begin(key);
  }

  /** How long this row has been running. */
  runningFor(key: string): number {
    return this.block.runningFor(key);
  }

  settle(key: string, outcome: StepOutcome = {}): void {
    if (outcome.hidden === true) {
      this.block.settle(key, []);
      return;
    }
    const waited = this.runningFor(key);
    const time =
      outcome.time === false
        ? undefined
        : typeof outcome.time === "string"
          ? outcome.time
          : waited >= 3_000
            ? elapsed(waited)
            : undefined;
    const status = outcome.status ?? "ok";
    const mark = status === "ok" ? green(MARK.ok) : status === "warn" ? yellow(MARK.warn) : red(MARK.fail);
    const lines = [
      formatRow({
        mark,
        label: outcome.label ?? this.block.labelOf(key) ?? key,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(time === undefined ? {} : { time }),
        labelWidth: this.labelWidth,
      }),
      ...(outcome.under ?? []).map((text) => `${detailColumn(this.labelWidth)}${text}`),
    ];
    this.block.settle(key, lines);
  }

  /** Erase the live region for a caller about to print something itself. */
  suspend(): void {
    this.block.suspend();
  }

  /** Commit what settled, drop the live region, give the cursor back. */
  finish(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    live.delete(this);
    this.block.finish();
    releaseStreams();
  }

  /** Wall clock since the first row was declared — the verdict's own number. */
  total(): string {
    return elapsed(Date.now() - this.openedAt);
  }
}
