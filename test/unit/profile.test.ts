import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  formatProfile,
  notePeakMemory,
  Profiler,
  type Span,
} from "../../src/shared/profile.js";
import {
  appendProfileStepSummary,
  recordValidationProfile,
  resetValidationOutputs,
  VALIDATION_PROFILE_FILENAME,
  type RecordedProfile,
} from "../../src/submission-validation/outputs.js";

const temporary: string[] = [];

afterEach(() => {
  delete process.env.GITHUB_STEP_SUMMARY;
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-profile-"));
  temporary.push(directory);
  return directory;
}

function child(span: Span, name: string): Span {
  const found = span.children.find((candidate) => candidate.name === name);
  expect(found, `span ${name}`).toBeDefined();
  return found!;
}

describe("pipeline profiler", () => {
  it("nests spans opened inside a running span", async () => {
    const profiler = new Profiler();
    await profiler.span("compile concepts", async () => {
      await profiler.span("container compile-concepts", () => undefined, { container: true });
    });

    const root = profiler.snapshot();
    expect(root.children.map((span) => span.name)).toEqual(["compile concepts"]);
    const inner = child(child(root, "compile concepts"), "container compile-concepts");
    expect(inner.container).toBe(true);
  });

  it("attributes concurrent children to their own parent", async () => {
    // The pipeline fetches source and Archive together and materializes four
    // dependency captures at a time; a stack-based profiler would misparent
    // whichever child opened last.
    const profiler = new Profiler();
    const release: Array<() => void> = [];
    const gate = (): Promise<void> => new Promise<void>((resolve) => release.push(resolve));

    const left = profiler.span("source", async () => {
      await profiler.span("container fetch-source", gate);
    });
    const right = profiler.span("archive", async () => {
      await profiler.span("container fetch-archive", gate);
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const resolve of release) resolve();
    await Promise.all([left, right]);

    const root = profiler.snapshot();
    expect(child(root, "source").children.map((span) => span.name)).toEqual(["container fetch-source"]);
    expect(child(root, "archive").children.map((span) => span.name)).toEqual(["container fetch-archive"]);
  });

  it("keeps the timings of a span that threw", async () => {
    const profiler = new Profiler();
    await expect(
      profiler.span("replay proofs", () => {
        throw new Error("kernel replay failed");
      }),
    ).rejects.toThrow("kernel replay failed");

    const root = profiler.snapshot();
    expect(root.children.map((span) => span.name)).toEqual(["replay proofs"]);
    expect(root.ms).toBeGreaterThanOrEqual(0);
  });

  it("renders shares, an unaccounted line, and the container summary", () => {
    const root: Span = {
      name: "total",
      ms: 100_000,
      children: [
        {
          name: "compile proofs",
          ms: 80_000,
          children: [{ name: "container compile-proofs", ms: 60_000, children: [], container: true }],
        },
        { name: "container runtime-manifest", ms: 2_000, children: [], container: true },
      ],
    };

    const text = formatProfile(root);
    expect(text).toContain("total");
    expect(text).toContain("100%");
    expect(text).toContain("compile proofs");
    // 80s of compile with a 60s container inside leaves 20s unaccounted.
    expect(text).toContain("(other)");
    expect(text).toContain("containers: 2 runs");
    expect(text).toContain("shortest run (startup floor)");
  });

  it("omits the container summary when nothing ran in a container", () => {
    const text = formatProfile({ name: "total", ms: 5, children: [] });
    expect(text).not.toContain("containers:");
    expect(text).not.toContain("(other)");
    expect(text).not.toContain("peak");
  });

  it("attributes peak-memory observations to the open span, keeping the maximum", async () => {
    const profiler = new Profiler();
    await profiler.span("replay proofs", async () => {
      notePeakMemory(512);
      await profiler.span("container replay-proofs", () => {
        notePeakMemory(2048);
        notePeakMemory(1024); // lower observation never shrinks the peak
        notePeakMemory(Number.NaN); // and junk is dropped
        notePeakMemory(-5);
      }, { container: true });
    });

    const outer = child(profiler.snapshot(), "replay proofs");
    expect(outer.peakMemoryBytes).toBe(512);
    expect(child(outer, "container replay-proofs").peakMemoryBytes).toBe(2048);
  });

  it("drops peak-memory observations made outside every span", () => {
    const profiler = new Profiler();
    notePeakMemory(4096);
    expect(profiler.snapshot().peakMemoryBytes).toBeUndefined();
  });

  it("formats bytes in human units", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(10 * 1024)).toBe("10KiB");
    expect(formatBytes(300 * 2 ** 20)).toBe("300MiB");
    expect(formatBytes(10.78 * 2 ** 30)).toBe("10.78GiB");
  });

  it("renders per-span peaks and the heaviest-span summary line", () => {
    const root: Span = {
      name: "total",
      ms: 100_000,
      children: [
        {
          name: "replay proofs",
          ms: 80_000,
          children: [
            {
              name: "container replay-proofs",
              ms: 79_500,
              children: [],
              container: true,
              peakMemoryBytes: Math.round(10.78 * 2 ** 30),
            },
          ],
        },
        { name: "compile concepts", ms: 20_000, children: [], peakMemoryBytes: 300 * 2 ** 20 },
      ],
    };

    const text = formatProfile(root);
    expect(text).toContain("peak 10.78GiB");
    expect(text).toContain("peak 300MiB");
    expect(text).toContain("peak memory (heaviest span)");
    expect(text).toContain("10.78GiB");
  });
});

describe("recorded validation profile", () => {
  it("appends each stage and survives a corrupt or missing file", () => {
    const outputDir = scratch();
    const filename = path.join(outputDir, VALIDATION_PROFILE_FILENAME);

    recordValidationProfile(outputDir, "compile", { name: "total", ms: 12.6, children: [] });
    recordValidationProfile(outputDir, "inspect", { name: "total", ms: 7, children: [] });
    const profile = JSON.parse(fs.readFileSync(filename, "utf8")) as RecordedProfile;
    expect(profile.profileVersion).toBe(1);
    expect(profile.stages.map((stage) => stage.stage)).toEqual(["compile", "inspect"]);
    expect(profile.stages[0]!.totalMs).toBe(13);

    fs.writeFileSync(filename, "not json");
    recordValidationProfile(outputDir, "replay", { name: "total", ms: 1, children: [] });
    const rebuilt = JSON.parse(fs.readFileSync(filename, "utf8")) as RecordedProfile;
    expect(rebuilt.stages.map((stage) => stage.stage)).toEqual(["replay"]);
  });

  it("is cleared with the other validation outputs", () => {
    const outputDir = scratch();
    recordValidationProfile(outputDir, "compile", { name: "total", ms: 1, children: [] });
    resetValidationOutputs(outputDir);
    expect(fs.existsSync(path.join(outputDir, VALIDATION_PROFILE_FILENAME))).toBe(false);
  });

  it("never throws when the profile cannot be written", () => {
    expect(() =>
      recordValidationProfile("/proc/lax-nonexistent", "compile", { name: "total", ms: 1, children: [] }),
    ).not.toThrow();
  });

  it("writes the step summary only when the workflow provides one", () => {
    const outputDir = scratch();
    const summary = path.join(outputDir, "summary.md");
    appendProfileStepSummary("compile", { name: "total", ms: 1, children: [] });
    expect(fs.existsSync(summary)).toBe(false);

    process.env.GITHUB_STEP_SUMMARY = summary;
    appendProfileStepSummary("compile", { name: "total", ms: 1, children: [] });
    const text = fs.readFileSync(summary, "utf8");
    expect(text).toContain("lax validation profile — compile");
    expect(text).toContain("== profile ==");
  });
});
