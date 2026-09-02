// The trusted pipeline's preparation order and its gate mode
// (ValidationOptions.stopAfter), driven through the standard fake-runner seam.
// Nothing here reaches a container: what is under test is that fetch, static
// validation, and dependency resolution run — and can fail the submission —
// *before* the runtime is verified. That order is what lets the validate job
// gate a submission ahead of its multi-GB cache restore and host provisioning.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ValidationReport } from "../../src/submission-validation/contracts.js";
import { validateSubmission } from "../../src/submission-validation/pipeline.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import { PAPER_IMAGE } from "../../src/submission-validation/pins.js";
import { emptyArchive, gitInitCommit, makeHostSubmission, makePaperSubmission } from "../support/host.js";
import { cleanupTemporary, request, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

interface RecordingRunner extends ValidationRunner {
  /** What the pipeline asked of the runtime, in order. A gate asks nothing. */
  calls: string[];
}

function recordingRunner(runtimeFailure?: string): RecordingRunner {
  const calls: string[] = [];
  return {
    calls,
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      calls.push(invocation.label);
      throw new Error(`unexpected container invocation ${invocation.label}`);
    },
    async verifyRuntime(): Promise<void> {
      calls.push("verify-runtime");
      if (runtimeFailure !== undefined) throw new Error(runtimeFailure);
    },
    async verifyImage(image): Promise<void> {
      calls.push(`verify-image ${image.image}`);
    },
  };
}

/** A committed submission built against the active pins, validated in place:
 * `local` stands in for the fetch the trusted job does by pinned commit, and
 * static validation reads the git tree it would have checked out. */
async function validate(
  files: Record<string, string>,
  options: { runner: RecordingRunner; gate?: boolean; phases?: string[] },
): Promise<ValidationReport> {
  const root = makeHostSubmission("lax-1", files, temporary("lax-pipeline-"));
  gitInitCommit(root);
  const jobDir = path.join(temporary("lax-pipeline-job-"), "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  return validateSubmission(request("lax-1"), jobDir, {
    local: {
      fetched: { repositoryRoot: root, submissionRoot: root },
      archive: emptyArchive(),
    },
    runner: options.runner,
    ...(options.gate === true ? { stopAfter: "resolution" as const } : {}),
    onPhase: (event) => {
      if (event.state === "start") options.phases?.push(event.name);
    },
  });
}

describe("trusted validation pipeline preparation", () => {
  it("verifies the runtime only after fetch, static validation, and resolution", async () => {
    const runner = recordingRunner("docker is unavailable");
    const phases: string[] = [];
    const report = await validate({}, { runner, phases });

    expect(phases).toEqual(["static validation", "dependency resolution", "validation runtime"]);
    expect(report.ok).toBe(false);
    // The runtime is provisioning, not source handling: by the time it is
    // checked the submission's own bytes have already passed every phase.
    expect(report.violations).toEqual([
      { phase: "provision", rule: "runtime", message: expect.stringContaining("docker is unavailable") },
    ]);
    expect(runner.calls).toEqual(["verify-runtime"]);
  });

  it("passes the gate without asking anything of the runtime", async () => {
    const runner = recordingRunner();
    const phases: string[] = [];
    const report = await validate({}, { runner, gate: true, phases });

    expect(phases).toEqual(["static validation", "dependency resolution"]);
    expect(runner.calls).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    // A passing gate is not evidence of a validation: nothing compiled, so
    // there is no build output or capture for a publisher to read.
    expect(report.buildOutput).toBeUndefined();
    expect(report.capture).toBeUndefined();
  });

  it("reports a static violation identically with and without the gate", async () => {
    const broken = { "manifest.yaml": 'specVersion: "1"\nid: lax-1\n' };
    const gateRunner = recordingRunner();
    const fullRunner = recordingRunner();
    const gated = await validate(broken, { runner: gateRunner, gate: true });
    const full = await validate(broken, { runner: fullRunner });

    expect(gated.ok).toBe(false);
    expect([...new Set(gated.violations.map((violation) => violation.phase))]).toEqual(["static"]);
    expect(gated.violations.map((violation) => violation.message).join("\n"))
      .toContain("manifest.yaml: missing key `title`");
    expect(gated.violations).toEqual(full.violations);
    // Neither run pays for the runtime once the submission is already refused.
    expect(gateRunner.calls).toEqual([]);
    expect(fullRunner.calls).toEqual([]);
  });

  it("starts a declared paper before the runtime is verified and joins its findings into a runtime failure", async () => {
    // The paper needs no Lean, so its container work overlaps the Lean chain
    // from right after resolution; whatever the Lean side does, the report
    // carries both findings and the job directory outlives the compile.
    const root = makePaperSubmission("lax-1");
    const commit = gitInitCommit(root);
    const jobDir = path.join(temporary("lax-pipeline-job-"), "work");
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const runner = recordingRunner("docker is unavailable");
    const phases: string[] = [];
    const base = request("lax-1");
    const report = await validateSubmission({ ...base, source: { ...base.source, commit } }, jobDir, {
      local: { fetched: { repositoryRoot: root, submissionRoot: root }, archive: emptyArchive() },
      runner,
      onPhase: (event) => {
        if (event.state === "start") phases.push(event.name);
      },
    });

    expect(phases).toEqual(["static validation", "dependency resolution", "paper", "validation runtime"]);
    // The TeX image is asked for by its own pin, never through the Lean
    // runtime, and before its container starts; the Lean runtime check runs
    // concurrently, so its position among the three is not fixed.
    expect([...runner.calls].sort()).toEqual([`verify-image ${PAPER_IMAGE}`, "paper-compile", "verify-runtime"].sort());
    expect(runner.calls.indexOf(`verify-image ${PAPER_IMAGE}`)).toBeLessThan(runner.calls.indexOf("paper-compile"));
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      { phase: "provision", rule: "runtime", message: expect.stringContaining("docker is unavailable") },
      { phase: "paper", rule: "runtime", message: expect.stringContaining("unexpected container invocation paper-compile") },
    ]);
    // The compile copy was made in the job directory, rewritten, never in the author's tree.
    expect(fs.readFileSync(path.join(jobDir, "paper", "src", "main.tex"), "latin1")).toContain("\\laxmark{");
    expect(fs.readFileSync(path.join(root, "paper", "main.tex"), "utf8")).toContain("% lax begin");
  });

  it("leaves the paper alone in the gate and when the scope is not both", async () => {
    const root = makePaperSubmission("lax-1");
    const commit = gitInitCommit(root);
    const base = request("lax-1");
    const validateWith = async (options: { gate?: boolean; scope?: "concepts" }) => {
      const runner = recordingRunner("docker is unavailable");
      const jobDir = path.join(temporary("lax-pipeline-job-"), "work");
      fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      const report = await validateSubmission({ ...base, source: { ...base.source, commit } }, jobDir, {
        local: { fetched: { repositoryRoot: root, submissionRoot: root }, archive: emptyArchive() },
        runner,
        ...(options.gate === true ? { stopAfter: "resolution" as const } : {}),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      });
      return { report, runner };
    };
    const gated = await validateWith({ gate: true });
    expect(gated.report.ok).toBe(true);
    expect(gated.runner.calls).toEqual([]);
    const concepts = await validateWith({ scope: "concepts" });
    expect(concepts.runner.calls).toEqual(["verify-runtime"]);
    expect(concepts.report.violations.map((violation) => violation.phase)).toEqual(["provision"]);
  });
});
