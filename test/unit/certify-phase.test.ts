// The trusted Certify phase through the fake-runner seam (certify/phase.ts):
// the judge self-test first (certify/self-test.ts: a build, one export step,
// three judge runs, a confinement probe — each wrong answer an
// infrastructure failure, never a violation), then
// the four-container sequence (the Challenge's build and export, the proof
// package's export, then the judge), the mounts — the proof capture absent
// from A1/A2, only the concept closure's subtrees under A1's `/deps`, A2 over
// a read-only build tree and B over lib trees alone, each with `/out` its
// only writable mount, nothing writable in the
// judge but `/out`, no capture and no path a hostile build could have written
// to — the plans the in-container tool reads, and the exit codes: 0
// certifies and seals the bundle, the exit-1 shapes are `certify`
// violations, exit 2, 3 and the container boundary are failures.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/submission-validation/certify/bundle.js";
import { certifyInContainer, type CertifyPhaseInput } from "../../src/submission-validation/certify/phase.js";
import { CERTIFY_PATHS } from "../../src/submission-validation/certify/project.js";
import type { ProbeReport } from "../../src/submission-validation/certify/self-test.js";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { JUDGE_TOOLS, SELF_TEST_PROBES, type InspectorReport, type ProofEntry, type ResolvedDependency } from "../../src/submission-validation/contracts.js";
import type { ArchiveEnvironment } from "../../src/submission-validation/environments.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import { cleanupTemporary, temporary, writeFile } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const ENVIRONMENT: ArchiveEnvironment = {
  id: "v4.35.0",
  specVersion: 2,
  leanToolchain: "leanprover/lean4:v4.35.0",
  admittedAt: "2026-10-03",
  inspector: "inspector",
  libraries: [
    { name: "mathlib", url: () => "https://github.com/leanprover-community/mathlib4", commit: "a".repeat(40), required: true },
    { name: "LaxCore", url: () => "https://github.com/lax-archive/lax-core", commit: "b".repeat(40), required: true },
  ],
  mathlibCommit: "a".repeat(40),
};

const PROOFS: ProofEntry[] = [
  {
    id: "Lax1Proofs.euclid",
    path: "proofs/Lax1Proofs/Basic.lean",
    levelParams: [],
    telescope: {
      hypotheses: [{ statement: "Lax7.Primes.ExistsPrimeDivisor", levels: [] }],
      conclusion: { statement: "Lax1.Infinite.InfinitelyManyPrimes", levels: [] },
    },
    conclusion: "Lax1.Infinite.InfinitelyManyPrimes",
    assumptions: ["Lax7.Primes.ExistsPrimeDivisor"],
    description: "",
  },
];

const DEPENDENCY: ResolvedDependency = {
  packageName: "Lax7",
  submissionId: "lax-7",
  kind: "concepts",
  source: { repository: "https://github.com/alice/primes", commit: "7".repeat(40), folder: "." },
  state: "registered",
  statements: ["Lax7.Primes.ExistsPrimeDivisor"],
  requiredPackages: [],
};

/** The inspector's report over a built Challenge that states exactly the
 * record's edges — what container A leaves in `/out` beside the export. */
function challengeReportFor(proofs: ProofEntry[]): InspectorReport {
  return {
    modules: [{ name: "Challenge", imports: ["Lax1", "Lax7"], moduleDocs: [], declCount: proofs.length, globalSyntax: [] }],
    declarations: proofs.map((proof) => ({
      name: proof.id,
      kind: "theorem",
      module: "Challenge",
      axioms: ["sorryAx"],
      usedConstants: [],
      userName: proof.id,
      origin: { kind: "authored" },
      laxStatement: false,
      isProp: false,
      levelParams: [...(proof.levelParams ?? [])],
      telescope: {
        hypotheses: proof.telescope!.hypotheses.map((hypothesis) => ({
          const: hypothesis.statement,
          levels: hypothesis.levels.map((level) => ["param", level] as const),
        })),
        conclusion: {
          const: proof.telescope!.conclusion.statement,
          levels: proof.telescope!.conclusion.levels.map((level) => ["param", level] as const),
        },
      },
    })),
  };
}

interface Scenario {
  challenge?: ContainerResult;
  challengeExport?: ContainerResult;
  solutionExport?: ContainerResult;
  judge?: ContainerResult;
  /** What A's inspector reported over the built Challenge; the record's own
   * edges unless said otherwise, or no report at all. */
  challengeReport?: InspectorReport | "missing";
  /** A1 behaves like a hostile concept-package initializer that outlives
   * the build: it leaves a marker in every writable mount, and the harness
   * then checks that no later container can reach any of them writable. */
  hostileChallenge?: boolean;
  /** The judge self-test's runs, each overridable: the build, the export
   * step, the three judge runs, the probe; `probes` overrides what the
   * probe tool reports; `exportWithoutTheorem` makes the Solution export
   * one the host cannot forge. */
  selfTest?: {
    build?: ContainerResult;
    export?: ContainerResult;
    accept?: ContainerResult;
    mismatch?: ContainerResult;
    kernel?: ContainerResult;
    probe?: ContainerResult;
    probes?: Partial<ProbeReport>;
    exportWithoutTheorem?: boolean;
  };
  /** The judge run rewrites a toolchain binary, as a compromised runner
   * would: the digests taken before must then refuse the certificate. */
  toolChangesUnderJudge?: boolean;
}

/** The labels of the self-test's six runs, in order. */
const SELF_TEST_LABELS = [
  "certify-self-test-build",
  "certify-self-test-export",
  "certify-self-test-judge-comparator-accepts",
  "certify-self-test-judge-comparator-rejects-mismatch",
  "certify-self-test-judge-kernel-rejects-forged",
  "certify-self-test-probe",
];
const RECORD_LABELS = ["certify-challenge-build", "certify-challenge-export", "certify-solution-export", "certify-judge"];

/** A Solution export the way lean4export writes it, reduced to what the
 * forgery reads: the name table and the theorem record. */
const SELF_TEST_EXPORT = [
  '{"in":1,"str":{"pre":0,"str":"Cert"}}',
  '{"in":2,"str":{"pre":1,"str":"selfTest"}}',
  '{"thm":{"all":[2],"levelParams":[],"name":2,"type":1,"value":5}}',
  "",
].join("\n");
const MISMATCH_OUTPUT = "error: Challenge and solution theorem statement do not match: 'Cert.selfTest'\n";
const KERNEL_OUTPUT = "Running Lean default kernel on solution\nerror: Lean default exited with 1\nLean default kernel rejected the solution\n";

function harness(scenario: Scenario = {}): {
  input: CertifyPhaseInput;
  invocations: ContainerInvocation[];
  jobDir: string;
  planted: string[];
} {
  const jobDir = temporary("lax-certify-job-");
  const captureRoot = path.join(jobDir, "capture");
  writeFile(captureRoot, "concepts/package/lakefile.toml", 'name = "Lax1"\n');
  writeFile(captureRoot, "concepts/package/Lax1.lean", "import Lax1.Infinite\n");
  writeFile(captureRoot, "concepts/lib/Lax1.olean", "olean");
  writeFile(captureRoot, "concepts/ir/Lax1.c", "c");
  writeFile(captureRoot, "proofs/package/lakefile.toml", 'name = "Lax1Proofs"\n');
  writeFile(captureRoot, "proofs/package/Lax1Proofs.lean", "import Lax1Proofs.Basic\n");
  writeFile(captureRoot, "proofs/lib/Lax1Proofs.olean", "olean");
  // the materialised dependency capture carries both subtrees, as every
  // capture does — lax-7 is required as a concept package, so its proofs
  // must be mounted nowhere
  const dependencyRoot = path.join(jobDir, "dependencies");
  writeFile(dependencyRoot, "lax-7/concepts/package/lakefile.toml", 'name = "Lax7"\n');
  writeFile(dependencyRoot, "lax-7/concepts/lib/Lax7.olean", "olean");
  writeFile(dependencyRoot, "lax-7/concepts/ir/Lax7.c", "c");
  writeFile(dependencyRoot, "lax-7/proofs/package/lakefile.toml", 'name = "Lax7Proofs"\n');
  writeFile(dependencyRoot, "lax-7/proofs/lib/Lax7Proofs.olean", "olean");
  const warmWs = temporary("lax-certify-warm-");
  fs.writeFileSync(
    path.join(warmWs, "lake-manifest.json"),
    JSON.stringify({ version: "1.2.0", packagesDir: ".lake/packages", packages: [
      { name: "mathlib", type: "git", inherited: false, url: "x", rev: "a".repeat(40), inputRev: "a".repeat(40), scope: "", manifestFile: "lake-manifest.json", configFile: "lakefile.toml" },
      { name: "LaxCore", type: "git", inherited: false, url: "y", rev: "b".repeat(40), inputRev: "b".repeat(40), scope: "", manifestFile: "lake-manifest.json", configFile: "lakefile.toml" },
    ] }),
  );
  // the host toolchain the runner mounts: one fake binary per judge tool
  const toolchainDir = temporary("lax-certify-toolchain-");
  fs.mkdirSync(path.join(toolchainDir, "bin"), { recursive: true });
  for (const tool of JUDGE_TOOLS) fs.writeFileSync(path.join(toolchainDir, "bin", tool), `#!/bin/sh\necho ${tool}\n`, { mode: 0o755 });
  const invocations: ContainerInvocation[] = [];
  const planted: string[] = [];
  const selfTest = scenario.selfTest ?? {};
  const runner: ValidationRunner = {
    async run(invocation) {
      invocations.push(invocation);
      const out = invocation.mounts?.find((mount) => mount.target === CERTIFY_PATHS.out)?.source;
      if (invocation.label === "certify-self-test-build") {
        if (out !== undefined) throw new Error("the self-test build has an /out mount");
        return selfTest.build ?? { code: 0, output: "", timedOut: false };
      }
      if (invocation.label === "certify-self-test-export") {
        if (out === undefined) throw new Error("no /out mount");
        const result = selfTest.export ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) {
          fs.writeFileSync(path.join(out, "challenge.export"), SELF_TEST_EXPORT.replace('"value":5', '"value":7'));
          fs.writeFileSync(path.join(out, "solution.export"), selfTest.exportWithoutTheorem === true ? '{"in":1,"str":{"pre":0,"str":"Cert"}}\n' : SELF_TEST_EXPORT);
          fs.writeFileSync(path.join(out, "mismatch.export"), SELF_TEST_EXPORT.replace('"type":1', '"type":3'));
        }
        return result;
      }
      if (invocation.label === "certify-self-test-judge-comparator-accepts") return selfTest.accept ?? { code: 0, output: "Your solution is okay!\n", timedOut: false };
      if (invocation.label === "certify-self-test-judge-comparator-rejects-mismatch") return selfTest.mismatch ?? { code: 1, output: MISMATCH_OUTPUT, timedOut: false };
      if (invocation.label === "certify-self-test-judge-kernel-rejects-forged") return selfTest.kernel ?? { code: 1, output: KERNEL_OUTPUT, timedOut: false };
      if (invocation.label === "certify-self-test-probe") {
        if (out === undefined) throw new Error("no /out mount");
        const result = selfTest.probe ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) {
          const report: ProbeReport = {
            canaryInvisible: true,
            networkAbsent: true,
            leancheckerResolves: "/opt/lax/toolchain/bin/leanchecker",
            projectReadOnly: true,
            toolchainReadOnly: true,
            ...selfTest.probes,
          };
          fs.writeFileSync(path.join(out, "probes.json"), `${JSON.stringify(report)}\n`);
        }
        return result;
      }
      const plant = (): void => {
        for (const mount of invocation.mounts ?? []) {
          if (mount.writable !== true) continue;
          const which = path.join(mount.source, "which");
          fs.writeFileSync(which, "#!/bin/sh\necho /bin/true\n", { mode: 0o755 });
          planted.push(fs.realpathSync(which));
        }
      };
      if (invocation.label === "certify-challenge-build") {
        if (out !== undefined) throw new Error("a build step has an /out mount");
        if (scenario.hostileChallenge === true) plant();
        return scenario.challenge ?? { code: 0, output: "", timedOut: false };
      }
      if (invocation.label === "certify-challenge-export") {
        if (out === undefined) throw new Error("no /out mount");
        const result = scenario.challengeExport ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) {
          fs.writeFileSync(path.join(out, "challenge.export"), '{"meta":{}}\n');
          if (scenario.challengeReport !== "missing")
            fs.writeFileSync(path.join(out, "challenge-report.json"), `${JSON.stringify(scenario.challengeReport ?? challengeReportFor(PROOFS))}\n`);
        }
        return result;
      }
      if (invocation.label === "certify-solution-export") {
        if (out === undefined) throw new Error("no /out mount");
        const result = scenario.solutionExport ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) fs.writeFileSync(path.join(out, "solution.export"), '{"meta":{"solution":true}}\n');
        return result;
      }
      if (invocation.label === "certify-judge") {
        if (scenario.toolChangesUnderJudge === true) fs.writeFileSync(path.join(toolchainDir, "bin", "leanchecker"), "#!/bin/sh\necho tampered\n", { mode: 0o755 });
        return scenario.judge ?? { code: 0, output: "Your solution is okay!\n", timedOut: false };
      }
      throw new Error(`unexpected invocation ${invocation.label}`);
    },
    async verifyRuntime() {},
    async verifyImage() {},
  };
  return {
    jobDir,
    invocations,
    planted,
    input: {
      record: {
        proofs: PROOFS,
        ownConcepts: "Lax1",
        ownProofs: "Lax1Proofs",
        source: { repository: "https://github.com/alice/infinite", commit: "1".repeat(40), folder: "." },
        environment: ENVIRONMENT,
        resolution: { concepts: [], proofs: [DEPENDENCY], all: [DEPENDENCY] },
        warmPackages: JSON.parse(fs.readFileSync(path.join(warmWs, "lake-manifest.json"), "utf8")).packages,
      },
      jobDir,
      captureRoot,
      dependencyRoot,
      warmWs,
      toolchainDir,
      runner,
      limits: DEFAULT_LIMITS,
      phase: async (_name, operation) => operation(),
    },
  };
}

/** The record's four runs, after the self-test's six. */
const recordRuns = (invocations: ContainerInvocation[]) => invocations.slice(SELF_TEST_LABELS.length);

const mountsOf = (invocation: ContainerInvocation) => invocation.mounts ?? [];
const writableTargets = (invocation: ContainerInvocation) =>
  mountsOf(invocation).filter((mount) => mount.writable === true).map((mount) => mount.target).sort();

/** Every regular file under a mount source (a file source is itself). */
function filesUnder(source: string): string[] {
  const stat = fs.statSync(source);
  if (stat.isFile()) return [fs.realpathSync(source)];
  const result: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) result.push(fs.realpathSync(filename));
    }
  };
  walk(source);
  return result;
}

describe("the trusted Certify phase", () => {
  it("holds the Challenge to the telescope: a theorem that elaborated to something else is a translation violation before B runs", async () => {
    // the namespace review's E1: a global `macro_rules` for `theorem` in a
    // concept package turned `Cert.p : … := sorry` into `Cert.p : True`
    const rewritten = challengeReportFor(PROOFS);
    rewritten.declarations[0]!.telescope = { hypotheses: [], conclusion: { const: "True", levels: [] } };
    const { input, invocations } = harness({ challengeReport: rewritten });
    const result = await certifyInContainer(input);
    expect(result).toMatchObject({ kind: "violation", rule: "challenge-mismatch", intent: "translation" });
    expect((result as { message: string }).message).toContain("theorem Lax1Proofs.euclid states the edge {Lax7.Primes.ExistsPrimeDivisor} → Lax1.Infinite.InfinitelyManyPrimes in the record but elaborated to {} → True");
    expect(invocations.map((invocation) => invocation.label)).toEqual([...SELF_TEST_LABELS, "certify-challenge-build", "certify-challenge-export"]);
  });

  it("treats a missing or unreadable Challenge report as the archive's failure", async () => {
    const missing = harness({ challengeReport: "missing" });
    await expect(certifyInContainer(missing.input)).rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("Challenge inspection report was not produced") });
    const broken = harness({ challengeReport: { modules: [], declarations: [] } });
    // parses, but states no theorem: a mismatch, not a failure — the report
    // is the inspector's and the Challenge is what it read
    expect(await certifyInContainer(broken.input)).toMatchObject({ kind: "violation", rule: "challenge-mismatch" });
  });

  it("runs nothing for a record without proofs", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, record: { ...input.record, proofs: [] } });
    expect(result).toEqual({ kind: "nothing" });
    expect(invocations).toEqual([]);
  });

  it("builds the Challenge without the proof package, exports it over a read-only build tree and the proof package over its capture, then judges both exports in a clean container", async () => {
    const { input, invocations, jobDir } = harness();
    const result = await certifyInContainer(input);
    expect(invocations.map((invocation) => invocation.label)).toEqual([...SELF_TEST_LABELS, ...RECORD_LABELS]);
    const [build, challenge, solution, judge] =
      recordRuns(invocations) as [ContainerInvocation, ContainerInvocation, ContainerInvocation, ContainerInvocation];

    // A1: the concept capture, the concept closure's subtrees, the Challenge
    // half of the project read-only with a writable `.lake`, the plan
    // read-only — no `/out`, and nothing of any proof package anywhere.
    const targetsA = mountsOf(build).map((mount) => mount.target);
    expect(targetsA.sort()).toEqual([
      `${CERTIFY_PATHS.project}`,
      `${CERTIFY_PATHS.project}/.lake`,
      CERTIFY_PATHS.plan,
      `${CERTIFY_PATHS.own}/concepts/ir`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.own}/concepts/package`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/ir`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/package`,
    ].sort());
    expect(targetsA.some((target) => target.includes("proofs"))).toBe(false);
    expect(writableTargets(build)).toEqual([`${CERTIFY_PATHS.project}/.lake`]);
    for (const mount of mountsOf(build)) {
      expect(mount.source.includes("/capture/proofs"), mount.source).toBe(false);
      expect(mount.source.includes("/proofs/"), mount.source).toBe(false);
      // and no file of the dependency's proof subtree is reachable through any mount
      for (const file of filesUnder(mount.source)) expect(file.includes("/lax-7/proofs/"), file).toBe(false);
    }
    expect(build.runtime).toBeUndefined();
    expect(build.env).toEqual({ LEAN_NUM_THREADS: String(DEFAULT_LIMITS.leanThreads) });
    expect(build.args).toEqual(["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.plan}/plan.json`]);
    const planDirA = mountsOf(build).find((mount) => mount.target === CERTIFY_PATHS.plan)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(planDirA, "plan.json"), "utf8"))).toEqual({ tool: "build", project: CERTIFY_PATHS.project, module: "Challenge" });
    const projectA = mountsOf(build).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
    expect(fs.readdirSync(projectA).sort()).toEqual([".lake", "Challenge.lean", "lake-manifest.json", "lakefile.toml"]);
    const lakefileA = fs.readFileSync(path.join(projectA, "lakefile.toml"), "utf8");
    expect(lakefileA).not.toContain("Lax1Proofs");
    expect(lakefileA).toContain('name = "Lax7"');
    expect(lakefileA).toContain('defaultTargets = ["Challenge"]');
    const manifestA = JSON.parse(fs.readFileSync(path.join(projectA, "lake-manifest.json"), "utf8")) as { packages: Array<{ name: string; type: string; dir?: string }> };
    expect(manifestA.packages.map((pkg) => [pkg.name, pkg.type, pkg.dir])).toEqual([
      ["Lax1", "path", `${CERTIFY_PATHS.own}/concepts/package`],
      ["Lax7", "path", `${CERTIFY_PATHS.deps}/lax-7/concepts/package`],
      ["mathlib", "git", undefined],
      ["LaxCore", "git", undefined],
    ]);
    const lakeA = mountsOf(build).find((mount) => mount.target === `${CERTIFY_PATHS.project}/.lake`)!.source;
    const overrides = JSON.parse(fs.readFileSync(path.join(lakeA, "package-overrides.json"), "utf8")) as { packages: Array<{ name: string; dir: string }> };
    expect(overrides.packages.map((pkg) => pkg.dir)).toEqual(["/opt/lax/warm/.lake/packages/mathlib", "/opt/lax/warm/.lake/packages/LaxCore"]);
    // the staged own package carries the capture's build links, and the
    // capture root itself was never written to
    const stagedA = mountsOf(build).find((mount) => mount.target === `${CERTIFY_PATHS.own}/concepts/package`)!.source;
    expect(fs.readlinkSync(path.join(stagedA, ".lake", "build", "lib", "lean"))).toBe(`${CERTIFY_PATHS.own}/concepts/lib`);
    expect(fs.readlinkSync(path.join(stagedA, ".lake", "build", "ir"))).toBe(`${CERTIFY_PATHS.own}/concepts/ir`);
    expect(fs.existsSync(path.join(jobDir, "capture", "concepts", "package", ".lake"))).toBe(false);

    // A2: the same project and the *same* `.lake`, both read-only, the lib
    // dirs alone, `/out` the only writable mount; no package dirs, no plan dir
    expect(mountsOf(challenge).map((mount) => mount.target).sort()).toEqual([
      `${CERTIFY_PATHS.project}`,
      `${CERTIFY_PATHS.project}/.lake`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      CERTIFY_PATHS.out,
    ].sort());
    expect(writableTargets(challenge)).toEqual([CERTIFY_PATHS.out]);
    expect(mountsOf(challenge).find((mount) => mount.target === `${CERTIFY_PATHS.project}/.lake`)!.source).toBe(lakeA);
    expect(challenge.runtime).toBeUndefined();
    expect(challenge.args).toEqual(["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`]);
    const outA = mountsOf(challenge).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const planA = JSON.parse(fs.readFileSync(path.join(outA, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(planA).toMatchObject({
      tool: "export",
      project: CERTIFY_PATHS.project,
      module: "Challenge",
      output: `${CERTIFY_PATHS.out}/challenge.export`,
      // and the inspector over the built Challenge, for the telescope check
      inspect: { report: `${CERTIFY_PATHS.out}/challenge-report.json` },
    });
    // the Challenge theorem is the proof's own name
    expect(planA.targets).toEqual(expect.arrayContaining(["Quot.sound", "Lax1Proofs.euclid", "propext", "Nat.add", "outParam"]));
    expect(fs.readFileSync(path.join(projectA, "Challenge.lean"), "utf8")).toContain("theorem Lax1Proofs.euclid\n    (h₁ : _root_.Lax7.Primes.ExistsPrimeDivisor)\n");
    expect(planA.leanPath).toEqual([
      `${CERTIFY_PATHS.project}/.lake/build/lib/lean`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      "/opt/lax/warm/.lake/packages/LaxCore/.lake/build/lib/lean",
      "/opt/lax/warm/.lake/packages/mathlib/.lake/build/lib/lean",
    ]);

    // B: no project, no build, no package dir — the lib trees of the proof
    // capture, the record's concepts and the solution closure, read-only,
    // `/out` the only writable mount; the proof package's root exported by
    // A2's rule (ultracode review C1)
    expect(mountsOf(solution).map((mount) => mount.target).sort()).toEqual([
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.own}/proofs/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      CERTIFY_PATHS.out,
    ].sort());
    expect(writableTargets(solution)).toEqual([CERTIFY_PATHS.out]);
    expect(solution.runtime).toBeUndefined();
    expect(mountsOf(solution).find((mount) => mount.target === `${CERTIFY_PATHS.own}/proofs/lib`)!.source).toBe(path.join(jobDir, "capture", "proofs", "lib"));
    const outB = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const planB = JSON.parse(fs.readFileSync(path.join(outB, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(planB).toMatchObject({ tool: "export", project: CERTIFY_PATHS.out, module: "Lax1Proofs", output: `${CERTIFY_PATHS.out}/solution.export` });
    expect(planB.inspect).toBeUndefined();
    expect(planB.targets).toEqual(planA.targets);
    expect(planB.leanPath).toEqual([
      `${CERTIFY_PATHS.own}/proofs/lib`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      "/opt/lax/warm/.lake/packages/LaxCore/.lake/build/lib/lean",
      "/opt/lax/warm/.lake/packages/mathlib/.lake/build/lib/lean",
    ]);

    // C: the judge — the bundle read-only, both exports read-only as single
    // files, the shim read-only, `/out` the only writable mount; no capture,
    // no `/deps`, no warm store (the judge runtime), no `.lake`
    expect(judge.runtime).toBe("judge");
    expect(mountsOf(judge).map((mount) => mount.target).sort()).toEqual([
      CERTIFY_PATHS.project,
      CERTIFY_PATHS.shims,
      CERTIFY_PATHS.challengeExport,
      CERTIFY_PATHS.solutionExport,
      CERTIFY_PATHS.out,
    ].sort());
    expect(writableTargets(judge)).toEqual([CERTIFY_PATHS.out]);
    for (const mount of mountsOf(judge)) {
      expect(mount.source.includes("/capture"), mount.source).toBe(false);
      expect(mount.source.includes("/dependencies"), mount.source).toBe(false);
      expect(mount.source.includes("/own"), mount.source).toBe(false);
    }
    const challengeExport = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.challengeExport)!;
    expect(challengeExport.writable).toBeUndefined();
    expect(challengeExport.source).toBe(path.join(outA, "challenge.export"));
    expect(fs.statSync(challengeExport.source).isFile()).toBe(true);
    const solutionExport = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.solutionExport)!;
    expect(solutionExport.writable).toBeUndefined();
    expect(solutionExport.source).toBe(path.join(outB, "solution.export"));
    expect(fs.statSync(solutionExport.source).isFile()).toBe(true);
    const projectC = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
    expect(fs.readdirSync(projectC).sort()).toEqual(["Challenge.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    expect(JSON.parse(fs.readFileSync(path.join(projectC, "comparator.json"), "utf8"))).toMatchObject({
      challenge_module: "Challenge",
      solution_module: "Lax1Proofs",
      theorem_names: ["Lax1Proofs.euclid"],
    });
    // the judge's project is the bundle itself: git requires, no path entries
    expect(fs.readFileSync(path.join(projectC, "lakefile.toml"), "utf8")).toContain('git = "https://github.com/alice/primes"');
    expect(fs.readFileSync(path.join(projectC, "lake-manifest.json"), "utf8")).not.toContain('"type": "path"');
    const shims = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.shims)!.source;
    expect(fs.readdirSync(shims)).toEqual(["git"]);
    expect(fs.statSync(path.join(shims, "git")).mode & 0o111).not.toBe(0);
    const outC = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(outC, "plan.json"), "utf8"))).toEqual({
      tool: "comparator",
      project: CERTIFY_PATHS.project,
      config: "comparator.json",
      challengeExport: CERTIFY_PATHS.challengeExport,
      solutionExport: CERTIFY_PATHS.solutionExport,
      shims: CERTIFY_PATHS.shims,
      paranoid: false,
    });

    // the verdict: the bundle sealed, its digest recorded, the Challenge
    // verbatim, both export digests the host's own over the files C read
    expect(result.kind).toBe("certified");
    if (result.kind !== "certified") return;
    const tar = fs.readFileSync(result.bundlePath);
    expect(createHash("sha256").update(tar).digest("hex")).toBe(result.certificate.bundle.digest);
    const members = readBundle(tar);
    expect([...members.keys()]).toEqual(["Challenge.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    expect(members.get("Challenge.lean")).toBe(result.certificate.challenge);
    expect(members.get("lakefile.toml")).toContain('git = "https://github.com/alice/primes"');
    // and the judge judged exactly the bundle's files
    for (const [name, content] of members) expect(fs.readFileSync(path.join(projectC, name), "utf8"), name).toBe(content);
    expect(result.certificate).toEqual({
      judge: {
        toolchain: ENVIRONMENT.leanToolchain,
        comparatorExitCode: 0,
        selfTest: { passed: true, probes: [...SELF_TEST_PROBES] },
        tools: Object.fromEntries(JUDGE_TOOLS.map((tool) => [tool, createHash("sha256").update(`#!/bin/sh\necho ${tool}\n`).digest("hex")])),
      },
      kernels: ["lean"],
      bundle: { formatVersion: 1, digest: result.certificate.bundle.digest },
      challengeExportSha256: createHash("sha256").update('{"meta":{}}\n').digest("hex"),
      solutionExportSha256: createHash("sha256").update('{"meta":{"solution":true}}\n').digest("hex"),
      challenge: result.certificate.challenge,
    });
    expect(result.certificate.challenge).toContain("theorem Lax1Proofs.euclid");
  });

  it("gives no later container a writable path a hostile build wrote, and the export steps no writable path but /out", async () => {
    // A1 is where candidate code runs; it plants a `which` in every
    // writable mount it is given — its `.lake`, the only one. The export
    // step mounts that `.lake` again, read-only, and B and the judge not at
    // all (fable review 2026-10-04, finding 1.1).
    const { input, invocations, planted } = harness({ hostileChallenge: true });
    const result = await certifyInContainer(input);
    expect(result.kind).toBe("certified");
    expect(planted).toHaveLength(1);
    const builds = recordRuns(invocations).filter((invocation) => invocation.label.endsWith("-build"));
    expect(builds.map((build) => build.label)).toEqual(["certify-challenge-build"]);
    const written = builds.flatMap((build) => mountsOf(build).filter((mount) => mount.writable === true).map((mount) => fs.realpathSync(mount.source)));
    expect(written).toHaveLength(1);
    for (const later of invocations.filter((invocation) => !invocation.label.endsWith("-build"))) {
      for (const mount of mountsOf(later)) {
        const source = fs.realpathSync(mount.source);
        const underWritten = written.some((directory) => source === directory || source.startsWith(`${directory}${path.sep}`));
        // a build tree reaches its own export step, read-only; nothing else
        if (underWritten) {
          expect(later.label, `${later.label} mounts ${source}`).toBe("certify-challenge-export");
          expect(mount.writable, `${later.label} mounts ${source} writable`).toBeUndefined();
        }
        // and no file the judge can see is a planted `which`
        if (later.label === "certify-judge")
          for (const file of filesUnder(mount.source)) {
            expect(planted.includes(file), file).toBe(false);
            expect(path.basename(file) === "which", file).toBe(false);
          }
      }
    }
    // the shim the judge puts first on PATH is the host's, not writable by the judge either
    const judge = invocations.at(-1)!;
    const shims = mountsOf(judge).find((mount) => mount.target === CERTIFY_PATHS.shims)!;
    expect(shims.writable).toBeUndefined();
    expect(fs.readdirSync(shims.source)).toEqual(["git"]);
  });

  it("mounts a dependency's proof subtree into B only when the solution closure needs it, never into A", async () => {
    const proofDependency: ResolvedDependency = {
      packageName: "Lax7Proofs",
      submissionId: "lax-7",
      kind: "proofs",
      source: DEPENDENCY.source,
      state: "registered",
      statements: [],
      requiredPackages: ["Lax7"],
    };
    const { input, invocations } = harness();
    const result = await certifyInContainer({
      ...input,
      record: {
        ...input.record,
        // the proof package requires lax-7's proofs too (a discouraged but legal require)
        resolution: { concepts: [], proofs: [DEPENDENCY, proofDependency], all: [DEPENDENCY, proofDependency] },
      },
    });
    expect(result.kind).toBe("certified");
    const [build, challenge, solution] = recordRuns(invocations) as [ContainerInvocation, ContainerInvocation, ContainerInvocation];
    for (const invocation of [build, challenge])
      expect(mountsOf(invocation).map((mount) => mount.target).some((target) => target.includes("proofs"))).toBe(false);
    // B reads the dependency's proof oleans, and never its package dir
    expect(mountsOf(solution).map((mount) => mount.target)).toContain(`${CERTIFY_PATHS.deps}/lax-7/proofs/lib`);
    expect(mountsOf(solution).map((mount) => mount.target).some((target) => target.endsWith("/package"))).toBe(false);
  });

  it("proves the judge first: the self-test's six runs precede the record's, through the judge runtime, with the record's mount discipline", async () => {
    const { input, invocations, jobDir } = harness();
    const result = await certifyInContainer(input);
    expect(result.kind).toBe("certified");
    const [build, exported, accept, mismatch, kernel, probe] = invocations.slice(0, 6) as ContainerInvocation[];
    for (const invocation of invocations.slice(0, 6)) {
      expect(invocation!.runtime).toBe("judge");
      expect(invocation!.args).toEqual(["node", "/opt/lax/bin/run-certify.mjs", expect.stringMatching(/plan\.json$/u)]);
      // nothing of the record is mounted into the self-test: no capture, no deps, no warm store
      for (const mount of mountsOf(invocation!)) {
        expect(mount.source.startsWith(path.join(jobDir, "certify", "self-test")), mount.source).toBe(true);
        expect(mount.target.startsWith(CERTIFY_PATHS.deps), mount.target).toBe(false);
      }
    }
    // S1 like A1: the project read-only, `.lake` the one writable mount, the plan read-only, no `/out`
    expect(writableTargets(build!)).toEqual([`${CERTIFY_PATHS.project}/.lake`]);
    expect(mountsOf(build!).map((mount) => mount.target).sort()).toEqual([`${CERTIFY_PATHS.project}`, `${CERTIFY_PATHS.project}/.lake`, CERTIFY_PATHS.plan].sort());
    const planDir = mountsOf(build!).find((mount) => mount.target === CERTIFY_PATHS.plan)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(planDir, "plan.json"), "utf8"))).toEqual({ tool: "build", project: CERTIFY_PATHS.project, module: "LaxSelfTest" });
    const projectDir = mountsOf(build!).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
    expect(fs.readdirSync(projectDir).sort()).toEqual([".lake", "SelfChallenge.lean", "SelfMismatch.lean", "SelfSolution.lean", "lake-manifest.json", "lakefile.toml"]);
    expect(fs.readFileSync(path.join(projectDir, "SelfChallenge.lean"), "utf8")).toBe("theorem Cert.selfTest : True := sorry\n");
    // S2 like A2: the same `.lake` read-only, `/out` the only writable mount, three exports in one plan
    expect(writableTargets(exported!)).toEqual([CERTIFY_PATHS.out]);
    expect(mountsOf(exported!).find((mount) => mount.target === `${CERTIFY_PATHS.project}/.lake`)!.source)
      .toBe(mountsOf(build!).find((mount) => mount.target === `${CERTIFY_PATHS.project}/.lake`)!.source);
    const outDir = mountsOf(exported!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const exportPlan = JSON.parse(fs.readFileSync(path.join(outDir, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(exportPlan).toMatchObject({ tool: "export", leanPath: [`${CERTIFY_PATHS.project}/.lake/build/lib/lean`] });
    expect((exportPlan.exports as Array<{ module: string }>).map((entry) => entry.module)).toEqual(["SelfChallenge", "SelfSolution", "SelfMismatch"]);
    // composed as the record's are: the Quot four, the theorem, the background three, the primitives
    expect((exportPlan.targets as string[]).slice(0, 8)).toEqual(["Quot", "Quot.mk", "Quot.lift", "Quot.ind", "Cert.selfTest", "propext", "Classical.choice", "Quot.sound"]);
    expect((exportPlan.targets as string[]).slice(8)).toContain("Nat.add");
    // the forgery: the host set the theorem's value to its type
    expect(fs.readFileSync(path.join(outDir, "forged.export"), "utf8")).toContain('"type":1,"value":1');
    // S3–S5 like C: each export a single read-only file, nothing writable but `/out`, the shim first
    for (const [run, solution] of [[accept, "solution.export"], [mismatch, "mismatch.export"], [kernel, "forged.export"]] as const) {
      expect(writableTargets(run!)).toEqual([CERTIFY_PATHS.out]);
      expect(mountsOf(run!).find((mount) => mount.target === CERTIFY_PATHS.solutionExport)!.source).toBe(path.join(outDir, solution));
      expect(fs.statSync(mountsOf(run!).find((mount) => mount.target === CERTIFY_PATHS.challengeExport)!.source).isFile()).toBe(true);
      const judgeOut = mountsOf(run!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
      expect(JSON.parse(fs.readFileSync(path.join(judgeOut, "plan.json"), "utf8"))).toMatchObject({ tool: "comparator", config: "comparator.json", paranoid: false });
      const judgeProject = mountsOf(run!).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
      expect(JSON.parse(fs.readFileSync(path.join(judgeProject, "comparator.json"), "utf8"))).toMatchObject({ challenge_module: "SelfChallenge", solution_module: "SelfSolution", theorem_names: ["Cert.selfTest"] });
    }
    // S6: the probe reads the judge's project and shim read-only and writes its report to `/out`
    expect(writableTargets(probe!)).toEqual([CERTIFY_PATHS.out]);
    const probeOut = mountsOf(probe!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const probePlan = JSON.parse(fs.readFileSync(path.join(probeOut, "plan.json"), "utf8")) as { tool: string; absent: string[]; leanchecker: string };
    expect(probePlan.tool).toBe("probe");
    expect(probePlan.leanchecker).toBe("/opt/lax/toolchain/bin/leanchecker");
    // the canaries were written for the probe and removed after it
    expect(probePlan.absent).toHaveLength(2);
    for (const canary of probePlan.absent) expect(fs.existsSync(canary), canary).toBe(false);
    expect((result as { certificate: { judge: { selfTest: unknown } } }).certificate.judge.selfTest).toEqual({ passed: true, probes: [...SELF_TEST_PROBES] });
  });

  it("makes every wrong self-test answer an infrastructure failure naming the probe, never a violation, and runs nothing of the record", async () => {
    const cases: Array<[string, Scenario, string]> = [
      ["build", { selfTest: { build: { code: 1, output: "error: boom\n", timedOut: false } } }, "did not build"],
      ["export", { selfTest: { export: { code: 1, output: "leanexport: no\n", timedOut: false } } }, "exports were not produced"],
      ["forgery", { selfTest: { exportWithoutTheorem: true } }, "forged-export probe cannot be prepared"],
      ["accept", { selfTest: { accept: { code: 1, output: MISMATCH_OUTPUT, timedOut: false } } }, "probe comparator-accepts failed"],
      ["mismatch", { selfTest: { mismatch: { code: 0, output: "Your solution is okay!\n", timedOut: false } } }, "probe comparator-rejects-mismatch failed"],
      ["kernel", { selfTest: { kernel: { code: 0, output: "Your solution is okay!\n", timedOut: false } } }, "probe kernel-rejects-forged failed"],
      ["kernel crash", { selfTest: { kernel: { code: 1, output: "Running Lean default kernel on solution\nerror: Lean default exited with 134\nLean default kernel rejected the solution\n", timedOut: false } } }, "probe kernel-rejects-forged failed"],
      ["probe tool", { selfTest: { probe: { code: 2, output: "", timedOut: false } } }, "confinement probe did not run"],
      ["canary", { selfTest: { probes: { canaryInvisible: false } } }, "probe canary-invisible failed"],
      ["network", { selfTest: { probes: { networkAbsent: false } } }, "probe network-absent failed"],
      ["which", { selfTest: { probes: { leancheckerResolves: "/tmp/leanchecker" } } }, "probe leanchecker-resolves failed"],
      ["project", { selfTest: { probes: { projectReadOnly: false } } }, "probe project-read-only failed"],
      ["toolchain", { selfTest: { probes: { toolchainReadOnly: false } } }, "probe toolchain-read-only failed"],
      ["signal", { selfTest: { accept: { code: 3, output: "comparator: lake terminated by SIGKILL\n", timedOut: false } } }, "terminated by a signal"],
    ];
    for (const [name, scenario, message] of cases) {
      const { input, invocations } = harness(scenario);
      await expect(certifyInContainer(input), name).rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining(message) });
      expect(invocations.map((invocation) => invocation.label).some((label) => RECORD_LABELS.includes(label)), name).toBe(false);
    }
  });

  it("refuses a certificate when a judge binary changed under the judge, and when one is missing", async () => {
    const { input } = harness({ toolChangesUnderJudge: true });
    await expect(certifyInContainer(input)).rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("judge tool leanchecker changed") });
    const missing = harness();
    fs.rmSync(path.join(missing.input.toolchainDir, "bin", "nanoda_bin"));
    await expect(certifyInContainer(missing.input)).rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("judge tool nanoda_bin is not installed") });
    expect(missing.invocations).toEqual([]);
  });

  it("runs the paranoid kernel set when the environment's setting says so", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, limits: { ...DEFAULT_LIMITS, certificationKernels: "paranoid" } });
    const outC = mountsOf(recordRuns(invocations)[3]!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(outC, "plan.json"), "utf8"))).toMatchObject({ paranoid: true });
    expect(result.kind === "certified" && result.certificate.kernels).toEqual(["lean", "leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"]);
  });

  it("turns the comparator's exit-1 shapes into certify violations and stops before any bundle", async () => {
    for (const [output, rule] of [
      ["error: Challenge and solution theorem statement do not match: 'Lax1Proofs.euclid'", "statement-mismatch"],
      ["error: Illegal axiom detected: 'sorryAx'", "illegal-axiom"],
      ["error: Const does not match between challenge and target 'Lax7.Primes.ExistsPrimeDivisor'", "constant-mismatch"],
      ["error: Challenge and solution constant kind don't match: 'Lax1Proofs.euclid'", "not-a-theorem"],
      ["Lean default kernel rejected the solution\nerror: Lean default exited with 1", "kernel-rejected"],
    ] as const) {
      const { input, invocations, jobDir } = harness({ judge: { code: 1, output: `${output}\n`, timedOut: false } });
      const result = await certifyInContainer(input);
      expect(result, output).toMatchObject({ kind: "violation", rule, intent: "judge" });
      expect(recordRuns(invocations)).toHaveLength(4);
      expect(fs.existsSync(path.join(jobDir, "certify", "certificate.tar"))).toBe(false);
    }
  });

  it("reports a Challenge that did not build as a lax bug, and never exports it or runs B", async () => {
    const { input, invocations } = harness({
      challenge: { code: 1, output: "error: Challenge.lean:4:0: unknown constant 'Lax7.Primes.ExistsPrimeDivisor'\n", timedOut: false },
    });
    const result = await certifyInContainer(input);
    expect(result).toMatchObject({ kind: "violation", rule: "challenge-build", intent: "translation", message: expect.stringContaining("lax bug") });
    // conditional: a concept package of the record's own closure can be the cause (decision 8)
    expect((result as { message: string }).message).toContain("if every concept package the record requires builds cleanly");
    expect(invocations.map((invocation) => invocation.label)).toEqual([...SELF_TEST_LABELS, "certify-challenge-build"]);
  });

  it("treats an exporter or inspector that refused a built module, and any tool killed by a signal, as the archive's failure", async () => {
    await expect(certifyInContainer(harness({ challengeExport: { code: 1, output: "leanexport: cannot decode target\n", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("exporting the certificate Challenge failed") });
    // the proof package's export refused: its oleans compiled and were
    // inspected, so the exporter is the archive's — never a violation
    await expect(certifyInContainer(harness({ solutionExport: { code: 1, output: "leanexport: unknown module\n", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("exporting the proof package Lax1Proofs failed") });
    // 3 is the tool script's "terminated by a signal" — never a verdict
    for (const step of ["challenge", "challengeExport", "solutionExport", "judge"] as const) {
      await expect(certifyInContainer(harness({ [step]: { code: 3, output: "build: lean terminated by SIGSEGV\n", timedOut: false } }).input))
        .rejects.toMatchObject({ kind: "infrastructure" });
    }
  });

  it("refuses a name outside the archive's grammar as a certify violation, before any container runs", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({
      ...input,
      record: {
        ...input.record,
        proofs: [{ ...PROOFS[0]!, id: "Lax1Proofs.«x»", telescope: PROOFS[0]!.telescope }],
      },
    });
    expect(result).toMatchObject({ kind: "violation", rule: "name", intent: "translation", message: expect.stringContaining('"Lax1Proofs.«x»"') });
    expect(invocations).toEqual([]);
  });

  it("refuses an export B left as a symlink", async () => {
    const { input } = harness();
    const runner = input.runner;
    input.runner = {
      ...runner,
      async run(invocation) {
        const result = await runner.run(invocation);
        if (invocation.label === "certify-solution-export") {
          const out = invocation.mounts!.find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
          fs.rmSync(path.join(out, "solution.export"));
          fs.symlinkSync("/etc/passwd", path.join(out, "solution.export"));
        }
        return result;
      },
    };
    await expect(certifyInContainer(input)).rejects.toMatchObject({ kind: "infrastructure", message: expect.stringContaining("not a regular file") });
  });

  it("treats exit 2 and the container boundary as the archive's failure, never a verdict", async () => {
    await expect(certifyInContainer(harness({
      judge: { code: 2, output: "error: `lake comparator` needs `git` on PATH to build inside the sandbox\n", timedOut: false },
    }).input)).rejects.toMatchObject({ name: "PipelineFailure", kind: "infrastructure", message: expect.stringContaining("needs `git`") });
    await expect(certifyInContainer(harness({ judge: { code: 137, output: "", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ solutionExport: { code: 137, output: "", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 124, output: "", timedOut: true } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 125, output: "docker: daemon down", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "infrastructure" });
  });
});
