// Peak-memory measurement plumbing: the /proc/<pid>/status parsing behind
// the host process-tree sampler, the /proc/<pid>/cgroup parsing behind the
// container cgroup monitor, and — on Linux — a live proof that a host child
// spawned under a profiler span leaves its peak RSS on that span.

import os from "node:os";
import { describe, expect, it } from "vitest";
import { Profiler } from "../../src/shared/profile.js";
import { parseProcStatus, run } from "../../src/submission-validation/host/proc.js";
import { cgroupMemoryPeakPath } from "../../src/submission-validation/sandbox/container.js";

describe("proc status parsing", () => {
  it("pulls PPid, VmRSS, and VmHWM out of a status blob, in bytes", () => {
    const status = [
      "Name:\tlean",
      "Umask:\t0022",
      "State:\tR (running)",
      "PPid:\t4211",
      "VmPeak:\t 6291456 kB",
      "VmHWM:\t 5872025 kB",
      "VmRSS:\t 5651261 kB",
      "Threads:\t3",
    ].join("\n");
    expect(parseProcStatus(status)).toEqual({
      ppid: 4211,
      vmRssBytes: 5651261 * 1024,
      vmHwmBytes: 5872025 * 1024,
    });
  });

  it("yields absent fields for a kernel thread without Vm lines", () => {
    expect(parseProcStatus("Name:\tkthreadd\nPPid:\t0\nThreads:\t1\n")).toEqual({ ppid: 0 });
  });
});

describe("container cgroup resolution", () => {
  it("maps the unified-hierarchy line to the cgroup's memory.peak file", () => {
    // A real /proc/<pid>/cgroup from a rootful systemd-driver host; the v1
    // net_cls line is noise the parser must skip.
    const procCgroup = "1:net_cls:/\n0::/system.slice/docker-638f7bec6237.scope\n";
    expect(cgroupMemoryPeakPath(procCgroup)).toBe(
      "/sys/fs/cgroup/system.slice/docker-638f7bec6237.scope/memory.peak",
    );
  });

  it("resolves cgroupfs-driver paths the same way", () => {
    expect(cgroupMemoryPeakPath("0::/docker/638f7bec6237\n")).toBe(
      "/sys/fs/cgroup/docker/638f7bec6237/memory.peak",
    );
  });

  it("yields undefined on a cgroup-v1-only host", () => {
    expect(cgroupMemoryPeakPath("12:memory:/docker/638f\n1:name=systemd:/docker/638f\n")).toBe(
      undefined,
    );
  });
});

describe("host child peak sampling", () => {
  it.runIf(process.platform === "linux")(
    "records the child tree's peak RSS on the open span",
    async () => {
      const profiler = new Profiler();
      // Hold ~64 MiB of touched pages long enough for the 250 ms sampler to
      // see them; VmHWM floors the reading, so one late sample suffices.
      const result = await profiler.span("compile concepts", () =>
        run(
          process.execPath,
          ["-e", "Buffer.alloc(64 << 20, 1); setTimeout(() => {}, 900);"],
          os.tmpdir(),
        ));
      expect(result.code).toBe(0);
      const span = profiler.snapshot().children[0]!;
      expect(span.peakMemoryBytes).toBeGreaterThan(32 * 1024 * 1024);
    },
    15_000,
  );

  it.runIf(process.platform === "linux")("leaves no peak on a spanless run", async () => {
    const profiler = new Profiler();
    await run(process.execPath, ["-e", "setTimeout(() => {}, 400);"], os.tmpdir());
    expect(profiler.snapshot().peakMemoryBytes).toBeUndefined();
  });
});
