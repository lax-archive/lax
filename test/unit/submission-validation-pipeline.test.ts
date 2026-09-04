// The trusted pipeline's preparation order and its gate mode
// (ValidationOptions.stopAfter), driven through the standard fake-runner seam.
// Nothing here reaches a container: what is under test is that fetch, static
// validation, and dependency resolution run — and can fail the submission —
// *before* the runtime is verified. That order is what lets the validate job
// gate a submission ahead of its multi-GB cache restore and host provisioning.
//
// The file's second concern is who owns an outcome once the phases do run.
// The report keeps a verdict on the submission (violations) apart from the
// archive failing to reach one (`failure`), and the paper phase — the one
// phase with a container of its own, joined long after it started — has to
// land on the right side of that line for both kinds of trouble.

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { StaticPaper, ValidationReport } from "../../src/submission-validation/contracts.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";
import { validationExitCode } from "../../src/submission-validation/failures.js";
import { writeValidationOutputs } from "../../src/submission-validation/outputs.js";
import { runPaperPhase, type PaperPhaseResult } from "../../src/submission-validation/paper/phase.js";
import { validateSubmission } from "../../src/submission-validation/pipeline.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import { PAPER_IMAGE } from "../../src/submission-validation/pins.js";
import {
  emptyArchive,
  freshLaxHome,
  gitInitCommit,
  makeHostSubmission,
  makePaperSubmission,
  tmpDir,
} from "../support/host.js";
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
    expect(report.violations).toEqual([]);
    expect(report.failure).toEqual({
      kind: "infrastructure",
      retryable: false,
      phase: "provision",
      rule: "runtime",
      message: expect.stringContaining("docker is unavailable"),
    });
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
    expect(report.failure).toBeUndefined();
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
    expect(gated.failure).toBeUndefined();
    expect(full.failure).toBeUndefined();
    // Neither run pays for the runtime once the submission is already refused.
    expect(gateRunner.calls).toEqual([]);
    expect(fullRunner.calls).toEqual([]);
  });

  it("waits for a declared paper while keeping a runtime failure distinct from content findings", async () => {
    // The paper needs no Lean, so its container work overlaps the Lean chain
    // from right after resolution; whatever the Lean side does, the job
    // directory outlives the compile. An operational Lean failure remains the
    // sole outcome because the submission did not receive a complete verdict.
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
    expect(report.violations).toEqual([]);
    expect(report.failure).toEqual({
      kind: "infrastructure",
      retryable: false,
      phase: "provision",
      rule: "runtime",
      message: expect.stringContaining("docker is unavailable"),
    });
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
    expect(concepts.report.violations).toEqual([]);
    expect(concepts.report.failure).toMatchObject({ kind: "infrastructure", phase: "provision" });
  });
});

/** Validate a fixture through the trusted entry point, then put the report
 * through the writer the validate job publishes it with. That writer refuses
 * a report that both refuses the submission and reports the archive's own
 * failure — the separation the paper's outcome has to respect — so every run
 * below also proves its report is one the job could publish. */
async function runPipeline(root: string, runner: ValidationRunner): Promise<ValidationReport> {
  const commit = gitInitCommit(root);
  const jobDir = path.join(temporary("lax-pipeline-job-"), "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const base = request("lax-1");
  const report = await validateSubmission({ ...base, source: { ...base.source, commit } }, jobDir, {
    local: { fetched: { repositoryRoot: root, submissionRoot: root }, archive: emptyArchive() },
    runner,
  });
  writeValidationOutputs(temporary("lax-pipeline-outputs-"), report);
  return report;
}

/**
 * The paper's own outcome beside a Lean verdict: the Lean chain is driven to
 * a *content* violation (the fake runner refuses the author's concepts the
 * way `lake build` would), so the report is a verdict on the submission and
 * whatever happened to the paper has to find its own place in it. What the
 * paper's container does is the variable.
 */
async function validatePaper(paper: {
  compile?: ContainerResult;
  imageError?: string;
}): Promise<ValidationReport> {
  const runner: ValidationRunner = {
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      if (invocation.label === "paper-compile")
        return paper.compile ?? { code: 0, output: "", timedOut: false };
      if (invocation.label === "compile-concepts")
        return {
          code: 1,
          output: "Lax1/Zero.lean:9:0: error: unknown identifier 'nope'",
          timedOut: false,
        };
      throw new Error(`unexpected container invocation ${invocation.label}`);
    },
    async verifyRuntime(): Promise<void> {},
    async verifyImage(): Promise<void> {
      // What ContainerRunner.verifyImage throws when `docker pull` of the
      // multi-gigabyte TeX image fails; nothing about it is the author's.
      if (paper.imageError !== undefined) throw new Error(paper.imageError);
    },
  };
  return runPipeline(makePaperSubmission("lax-1"), runner);
}

/**
 * A paper beside a Lean chain with nothing wrong with it, which is where the
 * archive's own paper trouble has no verdict to hide behind. The fake
 * container leaves behind what the real one would — the oleans `lake build`
 * writes into the workspace mount, the report the inspector writes to its
 * output mount — so provisioning, capture, Replay, Inspect and judgment are
 * the real code and really do reach a verdict. The submission's Lean packages
 * are the scaffold's empty defaults on purpose: a concept would have to be
 * described a second time in the stand-in's report to survive judgment, and
 * it is the paper that is under test here.
 */
async function validatePaperWithCleanLean(paper: {
  compile?: ContainerResult;
  imageError?: string;
}): Promise<{ report: ValidationReport; calls: string[] }> {
  const root = makeHostSubmission(
    "lax-1",
    { "paper/main.tex": "\\documentclass{article}\n\\begin{document}\nNothing to mark.\n\\end{document}\n" },
    undefined,
    { manifestExtra: "paper:\n  folder: paper\n  main: main.tex\n" },
  );
  const rootModule = (kind: "concepts" | "proofs"): string =>
    kind === "concepts"
      ? packageNameForSubmission("lax-1")
      : `${packageNameForSubmission("lax-1")}Proofs`;
  const mountedAt = (invocation: ContainerInvocation, target: string): string => {
    const mount = invocation.mounts?.find((candidate) => candidate.target === target);
    if (mount === undefined) throw new Error(`${invocation.label} has no ${target} mount`);
    return mount.source;
  };
  const calls: string[] = [];
  const runner: ValidationRunner = {
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      calls.push(invocation.label);
      const done: ContainerResult = { code: 0, output: "", timedOut: false };
      if (invocation.label === "paper-compile") return paper.compile ?? done;
      for (const kind of ["concepts", "proofs"] as const) {
        if (invocation.label === `compile-${kind}`) {
          // `lake build` leaves the package's artifacts in the writable
          // `.lake` mount and the capture step reads them back off the host,
          // so the stand-in leaves the one olean of this empty package
          // exactly where lake would have put it.
          const library = path.join(mountedAt(invocation, `/source/${kind}/.lake`), "build", "lib", "lean");
          fs.mkdirSync(library, { recursive: true });
          fs.writeFileSync(path.join(library, `${rootModule(kind)}.olean`), "olean");
          return done;
        }
        if (invocation.label === `inspect-${kind}`) {
          // The inspector reports on exactly the modules its plan names —
          // here the empty package root and nothing else — and writes the
          // report into its output mount for the host to read back.
          const out = mountedAt(invocation, "/out");
          const plan = JSON.parse(fs.readFileSync(path.join(out, "plan.json"), "utf8")) as { args: string[] };
          const modules = plan.args
            .slice(1)
            .map((name) => ({ name, imports: [], moduleDocs: [], declCount: 0 }));
          fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ modules, declarations: [] }));
          return done;
        }
      }
      if (invocation.label.startsWith("replay-")) return done;
      throw new Error(`unexpected container invocation ${invocation.label}`);
    },
    async verifyRuntime(): Promise<void> {},
    async verifyImage(): Promise<void> {
      if (paper.imageError !== undefined) throw new Error(paper.imageError);
    },
  };
  return { report: await runPipeline(root, runner), calls };
}

describe("paper phase outcome ownership", () => {
  const previousHome = process.env.LAX_HOME;
  // Provisioning the concept workspace reads the warm store, so these runs
  // need a home linked to the shared one; the preparation tests above stop
  // before provisioning and never look.
  beforeAll(() => {
    freshLaxHome();
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env.LAX_HOME;
    else process.env.LAX_HOME = previousHome;
  });

  it("hands the pipeline a classified failure for the executor's own exit codes", async () => {
    const submissionRoot = tmpDir("lax-paper-owner-");
    fs.mkdirSync(path.join(submissionRoot, "paper"), { recursive: true });
    const paper: StaticPaper = {
      manifest: { folder: "paper", main: "main.tex", engine: "pdflatex" },
      files: ["main.tex"],
      texFiles: ["main.tex"],
      rewritten: new Map([["main.tex", "\\documentclass{article}\\begin{document}x\\end{document}\n"]]),
      marks: [],
    };
    const compiled = (result: { code: number; output: string; timedOut?: boolean }): Promise<PaperPhaseResult> =>
      runPaperPhase({
        paper,
        submissionRoot,
        jobDir: tmpDir("lax-paper-owner-job-"),
        sourceDateEpoch: 0,
        limits: DEFAULT_LIMITS,
        compile: async () => result,
      });

    // 125 is `docker run` itself: the container never started, so nothing was
    // learned about the paper — and this one reads as transient, which the
    // report is then allowed to say.
    await expect(compiled({
      code: 125,
      output: "docker: Error response from daemon: connection reset by peer",
    })).rejects.toMatchObject({ name: "PipelineFailure", kind: "infrastructure", retryable: true });

    // Every other nonzero code is the tool the phase meant to run, judging
    // the author's TeX — a finding, and the phase keeps producing it.
    const refused = await compiled({ code: 12, output: "! Undefined control sequence." });
    expect(refused.findings.violations.map((violation) => violation.rule)).toEqual(["compile"]);
  });

  it("blames the archive, not the paper, when the TeX image will not pull", async () => {
    const report = await validatePaper({
      imageError:
        "could not pull the pinned validation image: Error response from daemon: connection reset by peer",
    });

    // The Lean side gave the verdict this submission is refused on, and a
    // report carries a verdict or an operational failure, never both — so
    // the archive's own trouble stands beside it as a warning that names the
    // archive. What it must never be is a violation of the paper.
    expect(report.violations.map((violation) => violation.phase)).toEqual(["compile-concepts"]);
    expect(report.warnings).toContainEqual({
      phase: "paper",
      rule: "runtime",
      message: expect.stringContaining("could not pull the pinned validation image"),
    });
    expect(report.warnings.map((warning) => warning.message).join(" "))
      .toContain("the archive could not compile the paper this run");
    // The submission is still refused on its Lean, not on a paper nobody read.
    expect(validationExitCode(report)).toBe(2);
  });

  it("keeps the paper container's own exit codes off the author's record", async () => {
    const cases: Array<[string, ContainerResult, string]> = [
      // 127: the pinned image's PATH holds no latexmk — every paper-bearing
      // submission would be refused "on content" if this were a verdict.
      [
        "a latexmk the image does not have",
        { code: 127, output: 'exec: "latexmk": executable file not found in $PATH', timedOut: false },
        "latexmk",
      ],
      // The two enforced caps are capacity, not content — the same two the
      // Lean phases separate out at the same distance from the runner.
      ["the memory ceiling", { code: 137, output: "", timedOut: false }, "memory limit"],
      ["the compile watchdog", { code: 124, output: "This is LuaHBTeX", timedOut: true }, "did not compile within"],
    ];
    for (const [what, compile, expected] of cases) {
      const report = await validatePaper({ compile });
      expect(report.violations.map((violation) => violation.phase), what).toEqual(["compile-concepts"]);
      expect(
        report.warnings.filter((warning) => warning.phase === "paper").map((warning) => warning.message).join(" "),
        what,
      ).toContain(expected);
    }
  });

  it("still refuses the paper latexmk itself refused", async () => {
    const report = await validatePaper({
      compile: {
        code: 12,
        output: "! Undefined control sequence.\nl.7 \\laxmarkk\n{1}",
        timedOut: false,
      },
    });

    // A broken .tex is a verdict on the submission like any other: a paper
    // violation carrying the transcript, and nothing operational at all.
    expect(report.failure).toBeUndefined();
    expect(report.warnings.filter((warning) => warning.phase === "paper")).toEqual([]);
    expect(report.violations).toContainEqual({
      phase: "paper",
      rule: "compile",
      message: expect.stringContaining("the paper did not compile (latexmk exit 12)"),
    });
    expect(report.violations.map((violation) => violation.message).join(" "))
      .toContain("Undefined control sequence");
    expect(validationExitCode(report)).toBe(2);
  });

  it("reports the archive's own paper trouble as the run's failure when nothing else failed", async () => {
    // Nothing is wrong with this submission, so there is no verdict for the
    // archive's trouble to stand beside: whatever the paper phase produces is
    // the entire report, and a violation here would refuse a submission the
    // archive never managed to look at.
    const pull = await validatePaperWithCleanLean({
      imageError:
        "could not pull the pinned validation image: Error response from daemon: connection reset by peer",
    });
    expect(pull.report.violations).toEqual([]);
    expect(pull.report.failure).toMatchObject({
      kind: "infrastructure",
      // The pull is worth another attempt, and saying so is only possible
      // because this is a failure and not a finding against the author.
      retryable: true,
      phase: "paper",
      rule: "runtime",
      message: expect.stringContaining("could not pull the pinned validation image"),
    });
    // 1 is "the archive reached no verdict"; 2 would refuse the submission.
    expect(validationExitCode(pull.report)).toBe(1);
    // The whole Lean chain really did run and find nothing — and the paper's
    // container never started, so nothing was learned about the paper at all.
    expect(pull.calls).toEqual([
      "compile-concepts",
      "compile-proofs",
      "replay-concepts",
      "replay-proofs",
      "inspect-concepts",
      "inspect-proofs",
    ]);

    // The same from inside the container: a TeX image whose PATH holds no
    // latexmk would otherwise refuse every paper-bearing submission ever
    // sent, each on the content of a paper that was never compiled.
    const missing = await validatePaperWithCleanLean({
      compile: { code: 127, output: 'exec: "latexmk": executable file not found in $PATH', timedOut: false },
    });
    expect(missing.calls).toContain("paper-compile");
    expect(missing.report.violations).toEqual([]);
    expect(missing.report.failure).toMatchObject({
      kind: "infrastructure",
      // A pin that does not carry the command is not going to fix itself.
      retryable: false,
      phase: "paper",
      rule: "runtime",
      message: expect.stringContaining("latexmk"),
    });
    expect(validationExitCode(missing.report)).toBe(1);

    // The enforced caps are capacity and not content here too: a paper that
    // runs its container out of time ends the run without a verdict, the way
    // a Lean compile that hits the same cap already does.
    const capped = await validatePaperWithCleanLean({
      compile: { code: 124, output: "This is LuaHBTeX", timedOut: true },
    });
    expect(capped.report.violations).toEqual([]);
    expect(capped.report.failure).toMatchObject({
      kind: "resource-limit",
      phase: "paper",
      rule: "runtime",
      message: expect.stringContaining("did not compile within"),
    });
    expect(validationExitCode(capped.report)).toBe(1);
  });
});
