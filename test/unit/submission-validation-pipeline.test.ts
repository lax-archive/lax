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
import { emptyArchive, gitInitCommit, makeHostSubmission } from "../support/host.js";
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
});
