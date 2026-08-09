import { describe, expect, it } from "vitest";
import { LoadingBlock } from "../../src/cli/loading.js";

/** A capturing stand-in for `process.stdout`. */
function fakeOutput(options: { isTTY?: boolean; columns?: number } = {}) {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.isTTY,
    columns: options.columns,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

describe("LoadingBlock", () => {
  it("commits in declaration order however the rows settle", () => {
    const committed: string[] = [];
    const block = new LoadingBlock(fakeOutput(), { commit: (line) => committed.push(line) });
    block.add("a", "a");
    block.add("b", "b");
    block.add("c", "c");

    // `b` finishing first must not let it overtake `a` in the report.
    block.settle("b", ["b done"]);
    expect(committed).toEqual([]);

    block.settle("a", ["a done"]);
    expect(committed).toEqual(["a done", "b done"]);

    block.settle("c", ["c done"]);
    expect(committed).toEqual(["a done", "b done", "c done"]);
  });

  it("keeps a row that reports nothing from stalling the rows behind it", () => {
    const committed: string[] = [];
    const block = new LoadingBlock(fakeOutput(), { commit: (line) => committed.push(line) });
    block.add("a", "a");
    block.add("b", "b");

    block.settle("a", []);
    block.settle("b", ["b done"]);
    expect(committed).toEqual(["b done"]);
  });

  it("writes no cursor control without a TTY", () => {
    const output = fakeOutput({ isTTY: false });
    const committed: string[] = [];
    const block = new LoadingBlock(output, { commit: (line) => committed.push(line) });
    block.add("a", "a");
    block.render();
    block.settle("a", ["a done"]);
    block.finish();

    expect(output.writes).toEqual([]);
    expect(committed).toEqual(["a done"]);
  });

  it("rewinds by exactly as many lines as it drew", () => {
    const output = fakeOutput({ isTTY: true, columns: 80 });
    const block = new LoadingBlock(output, { commit: () => undefined });
    for (const key of ["a", "b", "c"]) block.add(key, key);

    block.render();
    const drawn = output.writes.at(-1)!;
    expect(drawn.split("\n").length - 1).toBe(3);

    block.render();
    expect(output.writes.at(-2)).toBe("\u001B[3A\r\u001B[0J");

    // A committed row leaves the live region, so the next rewind is shorter.
    block.settle("a", ["a done"]);
    block.render();
    expect(output.writes.at(-2)).toBe("\u001B[2A\r\u001B[0J");
    block.finish();
  });

  it("truncates rather than letting a line wrap", () => {
    const output = fakeOutput({ isTTY: true, columns: 20 });
    const block = new LoadingBlock(output, { commit: () => undefined });
    block.add("a", "x".repeat(200));
    block.render();

    // Colour is measured as the zero width it occupies, and a cut line ends
    // with a reset so a severed escape cannot leave the terminal dyed.
    const line = output.writes.at(-1)!.replace("\u001B[?25l", "").replace(/\n$/u, "");
    expect([...line.replace(/\u001B\[[0-9;]*m/gu, "")].length).toBeLessThanOrEqual(19);
    expect(line.endsWith("…\u001B[0m")).toBe(true);
    block.finish();
  });

  it("hides the cursor while drawing and gives it back at the end", () => {
    const output = fakeOutput({ isTTY: true, columns: 80 });
    const block = new LoadingBlock(output, { commit: () => undefined });
    block.add("a", "a");
    block.render();
    expect(output.writes.at(-1)!.startsWith("\u001B[?25l")).toBe(true);

    block.settle("a", ["a done"]);
    block.finish();
    expect(output.writes.at(-1)).toBe("\u001B[?25h");
  });

  it("names what a queued row is waiting for, and shows elapsed time", () => {
    const clock = fakeClock();
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, {
      commit: () => undefined,
      now: clock.now,
      elapsedAfterMs: 3_000,
    });
    block.add("lake", "lake");
    block.waiting("lake", "waiting for elan");

    block.render();
    expect(output.writes.at(-1)).toContain("waiting for elan");
    expect(output.writes.at(-1)).not.toContain("0s");

    clock.advance(10_000);
    block.render();
    expect(output.writes.at(-1)).toContain("10s");
    block.finish();
  });

  it("restarts a row's clock when its own work begins", () => {
    const clock = fakeClock();
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, {
      commit: () => undefined,
      now: clock.now,
      elapsedAfterMs: 3_000,
    });
    block.add("lake", "lake");
    block.waiting("lake", "waiting for elan");
    clock.advance(10_000);

    block.relabel("lake", "lake — installing a toolchain");
    block.begin("lake");
    clock.advance(4_000);
    block.render();

    const line = output.writes.at(-1)!;
    expect(line).toContain("installing a toolchain");
    // The queue it sat in is neither named nor counted any more.
    expect(line).not.toContain("waiting for elan");
    expect(line).toContain("4s");
    expect(line).not.toContain("14s");
    block.finish();
  });

  it("shows a settled row's result while it waits for its turn to commit", () => {
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, { commit: () => undefined });
    block.add("a", "a");
    block.add("b", "b");

    block.settle("b", ["  ✓ b: fine"]);
    expect(output.writes.at(-1)).toContain("✓ b: fine");
    block.finish();
  });

  it("spins only the row that is running", () => {
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, { commit: () => undefined });
    block.add("a", "Compiling concepts");
    block.add("b", "Compiling proofs");
    block.render();

    // Two spinners mean two things are happening. Only one is.
    const lines = drawn(output);
    expect(lines[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Compiling concepts$/u);
    expect(lines[1]).toBe("· Compiling proofs");
    block.finish();
  });

  it("starts a row's clock when its turn comes, not when it was declared", () => {
    const clock = fakeClock();
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, {
      commit: () => undefined,
      now: clock.now,
      elapsedAfterMs: 3_000,
    });
    block.add("a", "Rebuilding in the archive");
    block.add("b", "Writing the public record");

    block.render();
    clock.advance(68_000);
    block.render();
    // The row that has not started has no honest duration, so it shows none —
    // two rows counting from the same declaration is how a report comes to
    // claim the later step has been running longer than the earlier one.
    expect(drawn(output)[0]).toContain("1m08s");
    expect(drawn(output)[1]).toBe("· Writing the public record");

    block.settle("a", ["  ✓ Rebuilt in the archive"]);
    clock.advance(4_000);
    block.render();
    expect(drawn(output)[0]).toContain("4s");
    expect(drawn(output)[0]).not.toContain("1m12s");
    block.finish();
  });

  it("spins every row when the work really is concurrent", () => {
    const output = fakeOutput({ isTTY: true, columns: 200 });
    const block = new LoadingBlock(output, { commit: () => undefined, concurrent: true });
    block.add("lean", "Lean");
    block.add("git", "Git");
    block.render();

    // `lax doctor` probes everything at once, and each row is its own answer.
    for (const line of drawn(output)) expect(line).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u);
    block.finish();
  });
});

/** The live region as the terminal would show it, one entry per row. */
function drawn(output: { writes: string[] }): string[] {
  return output.writes
    .at(-1)!
    .replace("\u001B[?25l", "")
    .split("\n")
    .filter((line) => line !== "");
}

describe("a live region sharing the terminal", () => {
  it("drops the region before output it did not write", async () => {
    const ui = await import("../../src/cli/ui.js");
    const chunks: string[] = [];
    const realWrite = process.stdout.write;
    const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const realColumns = process.stdout.columns;
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.columns = 200;

    const steps = new ui.Steps();
    try {
      steps.add("a", "Inspecting the statements");
      steps.detail("a", "working");
      const before = chunks.length;

      // lake's own transcript under --verbose, the warm store's notices, a
      // stray console.log in a module that has never heard of this CLI: each
      // lands inside a region that erases itself by counting its own lines,
      // and the row it displaces is duplicated into the scrollback.
      process.stdout.write("✔ [4/4] Built laxinspector:exe (886ms)\n");

      expect(chunks[before]).toBe("\u001B[1A\r\u001B[0J");
      expect(chunks[before + 1]).toBe("✔ [4/4] Built laxinspector:exe (886ms)\n");
    } finally {
      steps.finish();
      process.stdout.write = realWrite;
      process.stdout.columns = realColumns;
      if (realIsTTY !== undefined) Object.defineProperty(process.stdout, "isTTY", realIsTTY);
    }
  });
});
