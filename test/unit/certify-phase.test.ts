// The trusted Certify phase through the fake-runner seam (certify/phase.ts):
// the two-container sequence, the mounts — the proof capture absent from A,
// the Challenge export read-only in B, the project read-only except its
// `.lake` — the plans the in-container tool reads, and the exit codes: 0
// certifies and seals the bundle, the exit-1 shapes are `certify`
// violations, exit 2 and the container boundary are failures.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/submission-validation/certify/bundle.js";
import { certifyInContainer, type CertifyPhaseInput } from "../../src/submission-validation/certify/phase.js";
import { CERTIFY_PATHS } from "../../src/submission-validation/certify/project.js";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { ProofEntry, ResolvedDependency } from "../../src/submission-validation/contracts.js";
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
      hypotheses: [{ statement: "Lax7.Primes.ExistsPrimeDivisor", levels: [], binder: "default" }],
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

interface Scenario {
  challenge?: ContainerResult;
  solution?: ContainerResult;
}

function harness(scenario: Scenario = {}): { input: CertifyPhaseInput; invocations: ContainerInvocation[]; jobDir: string } {
  const jobDir = temporary("lax-certify-job-");
  const captureRoot = path.join(jobDir, "capture");
  writeFile(captureRoot, "concepts/package/lakefile.toml", 'name = "Lax1"\n');
  writeFile(captureRoot, "concepts/package/Lax1.lean", "import Lax1.Infinite\n");
  writeFile(captureRoot, "concepts/lib/Lax1.olean", "olean");
  writeFile(captureRoot, "concepts/ir/Lax1.c", "c");
  writeFile(captureRoot, "proofs/package/lakefile.toml", 'name = "Lax1Proofs"\n');
  writeFile(captureRoot, "proofs/package/Lax1Proofs.lean", "import Lax1Proofs.Basic\n");
  writeFile(captureRoot, "proofs/lib/Lax1Proofs.olean", "olean");
  const dependencyRoot = path.join(jobDir, "dependencies");
  writeFile(dependencyRoot, "lax-7/concepts/package/lakefile.toml", 'name = "Lax7"\n');
  const warmWs = temporary("lax-certify-warm-");
  fs.writeFileSync(
    path.join(warmWs, "lake-manifest.json"),
    JSON.stringify({ version: "1.2.0", packagesDir: ".lake/packages", packages: [
      { name: "mathlib", type: "git", inherited: false, url: "x", rev: "a".repeat(40), inputRev: "a".repeat(40), scope: "", manifestFile: "lake-manifest.json", configFile: "lakefile.toml" },
      { name: "LaxCore", type: "git", inherited: false, url: "y", rev: "b".repeat(40), inputRev: "b".repeat(40), scope: "", manifestFile: "lake-manifest.json", configFile: "lakefile.toml" },
    ] }),
  );
  const invocations: ContainerInvocation[] = [];
  const runner: ValidationRunner = {
    async run(invocation) {
      invocations.push(invocation);
      const out = invocation.mounts?.find((mount) => mount.target === CERTIFY_PATHS.out)?.source;
      if (out === undefined) throw new Error("no /out mount");
      if (invocation.label === "certify-challenge") {
        const result = scenario.challenge ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) fs.writeFileSync(path.join(out, "challenge.export"), '{"meta":{}}\n');
        return result;
      }
      if (invocation.label === "certify-solution") return scenario.solution ?? { code: 0, output: "Your solution is okay!\n", timedOut: false };
      throw new Error(`unexpected invocation ${invocation.label}`);
    },
    async verifyRuntime() {},
    async verifyImage() {},
  };
  return {
    jobDir,
    invocations,
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
      runner,
      limits: DEFAULT_LIMITS,
      phase: async (_name, operation) => operation(),
    },
  };
}

const mountsOf = (invocation: ContainerInvocation) => invocation.mounts ?? [];

describe("the trusted Certify phase", () => {
  it("runs nothing for a record without proofs", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, record: { ...input.record, proofs: [] } });
    expect(result).toEqual({ kind: "nothing" });
    expect(invocations).toEqual([]);
  });

  it("builds the Challenge without the proof package, then judges the Solution against the read-only export", async () => {
    const { input, invocations, jobDir } = harness();
    const result = await certifyInContainer(input);
    expect(invocations.map((invocation) => invocation.label)).toEqual(["certify-challenge", "certify-solution"]);
    const [challenge, solution] = invocations as [ContainerInvocation, ContainerInvocation];

    // A: the concept capture, the dependency captures, the Challenge half
    // of the project read-only with a writable `.lake`, the out dir — and
    // nothing of the proof package anywhere.
    const targetsA = mountsOf(challenge).map((mount) => mount.target);
    expect(targetsA).toEqual(expect.arrayContaining([
      CERTIFY_PATHS.project,
      `${CERTIFY_PATHS.project}/.lake`,
      `${CERTIFY_PATHS.own}/concepts/package`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.own}/concepts/ir`,
      CERTIFY_PATHS.deps,
      CERTIFY_PATHS.out,
    ]));
    expect(targetsA.some((target) => target.includes("proofs"))).toBe(false);
    expect(mountsOf(challenge).filter((mount) => mount.writable === true).map((mount) => mount.target).sort())
      .toEqual([`${CERTIFY_PATHS.project}/.lake`, CERTIFY_PATHS.out]);
    for (const mount of mountsOf(challenge)) expect(mount.source.includes("/capture/proofs"), mount.source).toBe(false);
    expect(challenge.env).toEqual({ LEAN_NUM_THREADS: String(DEFAULT_LIMITS.leanThreads) });
    expect(challenge.args).toEqual(["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`]);
    const projectA = mountsOf(challenge).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
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
    const lakeA = mountsOf(challenge).find((mount) => mount.target === `${CERTIFY_PATHS.project}/.lake`)!.source;
    const overrides = JSON.parse(fs.readFileSync(path.join(lakeA, "package-overrides.json"), "utf8")) as { packages: Array<{ name: string; dir: string }> };
    expect(overrides.packages.map((pkg) => pkg.dir)).toEqual(["/opt/lax/warm/.lake/packages/mathlib", "/opt/lax/warm/.lake/packages/LaxCore"]);
    const outA = mountsOf(challenge).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const planA = JSON.parse(fs.readFileSync(path.join(outA, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(planA).toMatchObject({ tool: "challenge", project: CERTIFY_PATHS.project, module: "Challenge", output: `${CERTIFY_PATHS.out}/challenge.export` });
    expect(planA.targets).toEqual(expect.arrayContaining(["Quot.sound", "Cert.Lax1Proofs.euclid", "propext", "Nat.add", "outParam"]));
    expect(planA.leanPath).toEqual([
      `${CERTIFY_PATHS.project}/.lake/build/lib/lean`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      "/opt/lax/warm/.lake/packages/LaxCore/.lake/build/lib/lean",
      "/opt/lax/warm/.lake/packages/mathlib/.lake/build/lib/lean",
    ]);
    // the staged own package carries the capture's build links, and the
    // capture root itself was never written to
    const stagedA = mountsOf(challenge).find((mount) => mount.target === `${CERTIFY_PATHS.own}/concepts/package`)!.source;
    expect(fs.readlinkSync(path.join(stagedA, ".lake", "build", "lib", "lean"))).toBe(`${CERTIFY_PATHS.own}/concepts/lib`);
    expect(fs.readlinkSync(path.join(stagedA, ".lake", "build", "ir"))).toBe(`${CERTIFY_PATHS.own}/concepts/ir`);
    expect(fs.existsSync(path.join(jobDir, "capture", "concepts", "package", ".lake"))).toBe(false);

    // B: everything A had plus the proof capture and the whole project, and
    // the export A wrote, read-only.
    const targetsB = mountsOf(solution).map((mount) => mount.target);
    expect(targetsB).toEqual(expect.arrayContaining([
      `${CERTIFY_PATHS.own}/proofs/package`,
      `${CERTIFY_PATHS.own}/proofs/lib`,
      CERTIFY_PATHS.challengeExport,
    ]));
    const exportMount = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.challengeExport)!;
    expect(exportMount.writable).toBeUndefined();
    expect(exportMount.source).toBe(path.join(outA, "challenge.export"));
    expect(mountsOf(solution).filter((mount) => mount.writable === true).map((mount) => mount.target).sort())
      .toEqual([`${CERTIFY_PATHS.project}/.lake`, CERTIFY_PATHS.out]);
    const projectB = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
    expect(fs.readdirSync(projectB).sort()).toEqual([".lake", "Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    const manifestB = JSON.parse(fs.readFileSync(path.join(projectB, "lake-manifest.json"), "utf8")) as { packages: Array<{ name: string; dir?: string }> };
    expect(manifestB.packages.map((pkg) => pkg.name)).toEqual(["Lax1", "Lax1Proofs", "Lax7", "mathlib", "LaxCore"]);
    const outB = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(outB, "plan.json"), "utf8"))).toEqual({
      tool: "comparator",
      project: CERTIFY_PATHS.project,
      config: "comparator.json",
      challengeExport: CERTIFY_PATHS.challengeExport,
      paranoid: false,
    });

    // the verdict: the bundle sealed, its digest recorded, the Challenge verbatim
    expect(result.kind).toBe("certified");
    if (result.kind !== "certified") return;
    const tar = fs.readFileSync(result.bundlePath);
    expect(createHash("sha256").update(tar).digest("hex")).toBe(result.certificate.bundle.digest);
    const members = readBundle(tar);
    expect([...members.keys()]).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    expect(members.get("Challenge.lean")).toBe(result.certificate.challenge);
    expect(members.get("lakefile.toml")).toContain('git = "https://github.com/alice/primes"');
    expect(result.certificate).toMatchObject({
      judge: { toolchain: ENVIRONMENT.leanToolchain, comparatorExitCode: 0 },
      kernels: ["lean"],
      bundle: { formatVersion: 1 },
      challengeExportSha256: createHash("sha256").update('{"meta":{}}\n').digest("hex"),
    });
    expect(result.certificate.challenge).toContain("theorem Cert.Lax1Proofs.euclid");
  });

  it("runs the paranoid kernel set when the environment's setting says so", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, limits: { ...DEFAULT_LIMITS, certificationKernels: "paranoid" } });
    const outB = mountsOf(invocations[1]!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(outB, "plan.json"), "utf8"))).toMatchObject({ paranoid: true });
    expect(result.kind === "certified" && result.certificate.kernels).toEqual(["lean", "leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"]);
  });

  it("turns the comparator's exit-1 shapes into certify violations and stops before any bundle", async () => {
    for (const [output, rule] of [
      ["error: Challenge and solution theorem statement do not match: 'Cert.Lax1Proofs.euclid'", "statement-mismatch"],
      ["error: Illegal axiom detected: 'sorryAx'", "illegal-axiom"],
      ["error: Const does not match between challenge and target 'Lax7.Primes.ExistsPrimeDivisor'", "constant-mismatch"],
      ["error: Challenge and solution constant kind don't match: 'Cert.Lax1Proofs.euclid'", "not-a-theorem"],
      ["error: Solution.lean:5:0: unknown identifier 'Lax1Proofs.euclid'\nerror: Child exited with 1", "solution-build"],
    ] as const) {
      const { input, invocations, jobDir } = harness({ solution: { code: 1, output: `${output}\n`, timedOut: false } });
      const result = await certifyInContainer(input);
      expect(result, output).toMatchObject({ kind: "violation", rule });
      expect(invocations).toHaveLength(2);
      expect(fs.existsSync(path.join(jobDir, "certify", "certificate.tar"))).toBe(false);
    }
  });

  it("reports a Challenge that did not build as a lax bug, and never runs the comparator", async () => {
    const { input, invocations } = harness({
      challenge: { code: 1, output: "error: Challenge.lean:4:0: unknown constant 'Lax7.Primes.ExistsPrimeDivisor'\n", timedOut: false },
    });
    const result = await certifyInContainer(input);
    expect(result).toMatchObject({ kind: "violation", rule: "challenge-build", message: expect.stringContaining("lax bug") });
    expect(invocations.map((invocation) => invocation.label)).toEqual(["certify-challenge"]);
  });

  it("treats exit 2 and the container boundary as the archive's failure, never a verdict", async () => {
    await expect(certifyInContainer(harness({
      solution: { code: 2, output: "error: `lake comparator` needs `git` on PATH to build inside the sandbox\n", timedOut: false },
    }).input)).rejects.toMatchObject({ name: "PipelineFailure", kind: "infrastructure", message: expect.stringContaining("needs `git`") });
    await expect(certifyInContainer(harness({ solution: { code: 137, output: "", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 124, output: "", timedOut: true } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 125, output: "docker: daemon down", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "infrastructure" });
  });
});
