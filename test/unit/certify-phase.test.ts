// The trusted Certify phase through the fake-runner seam (certify/phase.ts):
// the three-container sequence, the mounts — the proof capture absent from
// A, only the concept closure's subtrees under A's `/deps`, nothing
// writable in the judge but `/out`, no capture and no path a hostile Solution
// build could have written to — the plans the in-container tool reads, and
// the exit codes: 0 certifies and seals the bundle, the exit-1 shapes are
// `certify` violations, exit 2 and the container boundary are failures.

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
  judge?: ContainerResult;
  /** B behaves like a hostile proof-package initializer: it plants an
   * executable `which` into every writable mount it is given. */
  hostileSolution?: boolean;
}

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
  const invocations: ContainerInvocation[] = [];
  const planted: string[] = [];
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
      if (invocation.label === "certify-solution") {
        const result = scenario.solution ?? { code: 0, output: "", timedOut: false };
        if (result.code === 0) fs.writeFileSync(path.join(out, "solution.export"), '{"meta":{"solution":true}}\n');
        if (scenario.hostileSolution === true) {
          for (const mount of invocation.mounts ?? []) {
            if (mount.writable !== true) continue;
            const which = path.join(mount.source, "which");
            fs.writeFileSync(which, "#!/bin/sh\necho /bin/true\n", { mode: 0o755 });
            planted.push(fs.realpathSync(which));
          }
        }
        return result;
      }
      if (invocation.label === "certify-judge") return scenario.judge ?? { code: 0, output: "Your solution is okay!\n", timedOut: false };
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
      runner,
      limits: DEFAULT_LIMITS,
      phase: async (_name, operation) => operation(),
    },
  };
}

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
  it("runs nothing for a record without proofs", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, record: { ...input.record, proofs: [] } });
    expect(result).toEqual({ kind: "nothing" });
    expect(invocations).toEqual([]);
  });

  it("builds the Challenge without the proof package, exports the Solution, then judges both exports in a clean container", async () => {
    const { input, invocations, jobDir } = harness();
    const result = await certifyInContainer(input);
    expect(invocations.map((invocation) => invocation.label)).toEqual(["certify-challenge", "certify-solution", "certify-judge"]);
    const [challenge, solution, judge] = invocations as [ContainerInvocation, ContainerInvocation, ContainerInvocation];

    // A: the concept capture, the concept closure's subtrees, the Challenge
    // half of the project read-only with a writable `.lake`, the out dir —
    // and nothing of any proof package anywhere.
    const targetsA = mountsOf(challenge).map((mount) => mount.target);
    expect(targetsA.sort()).toEqual([
      `${CERTIFY_PATHS.project}`,
      `${CERTIFY_PATHS.project}/.lake`,
      `${CERTIFY_PATHS.own}/concepts/ir`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.own}/concepts/package`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/ir`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/package`,
      CERTIFY_PATHS.out,
    ].sort());
    expect(targetsA.some((target) => target.includes("proofs"))).toBe(false);
    expect(writableTargets(challenge)).toEqual([`${CERTIFY_PATHS.project}/.lake`, CERTIFY_PATHS.out]);
    for (const mount of mountsOf(challenge)) {
      expect(mount.source.includes("/capture/proofs"), mount.source).toBe(false);
      expect(mount.source.includes("/proofs/"), mount.source).toBe(false);
      // and no file of the dependency's proof subtree is reachable through any mount
      for (const file of filesUnder(mount.source)) expect(file.includes("/lax-7/proofs/"), file).toBe(false);
    }
    expect(challenge.runtime).toBeUndefined();
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
    expect(planA).toMatchObject({ tool: "export", project: CERTIFY_PATHS.project, module: "Challenge", output: `${CERTIFY_PATHS.out}/challenge.export` });
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

    // B: everything A had plus the proof capture and the whole project; the
    // same export rule as A, for the Solution; no Challenge export in sight
    const targetsB = mountsOf(solution).map((mount) => mount.target);
    expect(targetsB).toEqual(expect.arrayContaining([
      `${CERTIFY_PATHS.own}/proofs/package`,
      `${CERTIFY_PATHS.own}/proofs/lib`,
      `${CERTIFY_PATHS.deps}/lax-7/concepts/package`,
    ]));
    expect(targetsB).not.toContain(CERTIFY_PATHS.challengeExport);
    expect(writableTargets(solution)).toEqual([`${CERTIFY_PATHS.project}/.lake`, CERTIFY_PATHS.out]);
    expect(solution.runtime).toBeUndefined();
    const projectB = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.project)!.source;
    expect(fs.readdirSync(projectB).sort()).toEqual([".lake", "Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    const manifestB = JSON.parse(fs.readFileSync(path.join(projectB, "lake-manifest.json"), "utf8")) as { packages: Array<{ name: string; dir?: string }> };
    expect(manifestB.packages.map((pkg) => pkg.name)).toEqual(["Lax1", "Lax1Proofs", "Lax7", "mathlib", "LaxCore"]);
    const outB = mountsOf(solution).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    const planB = JSON.parse(fs.readFileSync(path.join(outB, "plan.json"), "utf8")) as Record<string, unknown>;
    expect(planB).toMatchObject({ tool: "export", project: CERTIFY_PATHS.project, module: "Solution", output: `${CERTIFY_PATHS.out}/solution.export` });
    expect(planB.targets).toEqual(planA.targets);
    expect(planB.leanPath).toEqual([
      `${CERTIFY_PATHS.project}/.lake/build/lib/lean`,
      `${CERTIFY_PATHS.own}/concepts/lib`,
      `${CERTIFY_PATHS.own}/proofs/lib`,
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
    expect(fs.readdirSync(projectC).sort()).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
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
    expect([...members.keys()]).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
    expect(members.get("Challenge.lean")).toBe(result.certificate.challenge);
    expect(members.get("lakefile.toml")).toContain('git = "https://github.com/alice/primes"');
    // and the judge judged exactly the bundle's files
    for (const [name, content] of members) expect(fs.readFileSync(path.join(projectC, name), "utf8"), name).toBe(content);
    expect(result.certificate).toEqual({
      judge: { toolchain: ENVIRONMENT.leanToolchain, comparatorExitCode: 0 },
      kernels: ["lean"],
      bundle: { formatVersion: 1, digest: result.certificate.bundle.digest },
      challengeExportSha256: createHash("sha256").update('{"meta":{}}\n').digest("hex"),
      solutionExportSha256: createHash("sha256").update('{"meta":{"solution":true}}\n').digest("hex"),
      challenge: result.certificate.challenge,
    });
    expect(result.certificate.challenge).toContain("theorem Cert.Lax1Proofs.euclid");
  });

  it("gives the judge no path to anything a hostile Solution build wrote", async () => {
    const { input, invocations, planted } = harness({ hostileSolution: true });
    const result = await certifyInContainer(input);
    expect(result.kind).toBe("certified");
    // B planted a `which` in every writable mount it had: its `.lake` and its `/out`
    expect(planted).toHaveLength(2);
    const [solution, judge] = invocations.slice(1) as [ContainerInvocation, ContainerInvocation];
    const writableB = mountsOf(solution).filter((mount) => mount.writable === true).map((mount) => fs.realpathSync(mount.source));
    expect(writableB).toHaveLength(2);
    for (const mount of mountsOf(judge)) {
      const source = fs.realpathSync(mount.source);
      // no judge mount is, or lies under, a directory B could write to
      for (const written of writableB) {
        expect(source === written || source.startsWith(`${written}${path.sep}`), `${source} within ${written}`).toBe(
          // the one exception is the solution export itself — a single file
          // bind, so its siblings (where `which` sits) are not in the judge
          mount.target === CERTIFY_PATHS.solutionExport && source.startsWith(`${written}${path.sep}`),
        );
      }
      // and no file the judge can see is a planted `which`
      for (const file of filesUnder(mount.source)) {
        expect(planted.includes(file), file).toBe(false);
        expect(path.basename(file) === "which", file).toBe(false);
      }
    }
    // the shim the judge puts first on PATH is the host's, not writable by the judge either
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
    const [challenge, solution] = invocations as [ContainerInvocation, ContainerInvocation];
    expect(mountsOf(challenge).map((mount) => mount.target).some((target) => target.includes("proofs"))).toBe(false);
    expect(mountsOf(solution).map((mount) => mount.target)).toEqual(expect.arrayContaining([
      `${CERTIFY_PATHS.deps}/lax-7/proofs/package`,
      `${CERTIFY_PATHS.deps}/lax-7/proofs/lib`,
    ]));
  });

  it("runs the paranoid kernel set when the environment's setting says so", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({ ...input, limits: { ...DEFAULT_LIMITS, certificationKernels: "paranoid" } });
    const outC = mountsOf(invocations[2]!).find((mount) => mount.target === CERTIFY_PATHS.out)!.source;
    expect(JSON.parse(fs.readFileSync(path.join(outC, "plan.json"), "utf8"))).toMatchObject({ paranoid: true });
    expect(result.kind === "certified" && result.certificate.kernels).toEqual(["lean", "leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"]);
  });

  it("turns the comparator's exit-1 shapes into certify violations and stops before any bundle", async () => {
    for (const [output, rule] of [
      ["error: Challenge and solution theorem statement do not match: 'Cert.Lax1Proofs.euclid'", "statement-mismatch"],
      ["error: Illegal axiom detected: 'sorryAx'", "illegal-axiom"],
      ["error: Const does not match between challenge and target 'Lax7.Primes.ExistsPrimeDivisor'", "constant-mismatch"],
      ["error: Challenge and solution constant kind don't match: 'Cert.Lax1Proofs.euclid'", "not-a-theorem"],
      ["Lean default kernel rejected the solution\nerror: Lean default exited with 1", "kernel-rejected"],
    ] as const) {
      const { input, invocations, jobDir } = harness({ judge: { code: 1, output: `${output}\n`, timedOut: false } });
      const result = await certifyInContainer(input);
      expect(result, output).toMatchObject({ kind: "violation", rule });
      expect(invocations).toHaveLength(3);
      expect(fs.existsSync(path.join(jobDir, "certify", "certificate.tar"))).toBe(false);
    }
  });

  it("reports a Solution that did not build as a lax bug, from B, and never runs the judge", async () => {
    const { input, invocations } = harness({
      solution: { code: 1, output: "error: Solution.lean:5:0: unknown identifier 'Lax1Proofs.euclid'\nerror: build failed\n", timedOut: false },
    });
    const result = await certifyInContainer(input);
    expect(result).toMatchObject({ kind: "violation", rule: "solution-build", message: expect.stringContaining("unknown identifier") });
    expect(invocations.map((invocation) => invocation.label)).toEqual(["certify-challenge", "certify-solution"]);
  });

  it("reports a Challenge that did not build as a lax bug, and never runs B or the judge", async () => {
    const { input, invocations } = harness({
      challenge: { code: 1, output: "error: Challenge.lean:4:0: unknown constant 'Lax7.Primes.ExistsPrimeDivisor'\n", timedOut: false },
    });
    const result = await certifyInContainer(input);
    expect(result).toMatchObject({ kind: "violation", rule: "challenge-build", message: expect.stringContaining("lax bug") });
    expect(invocations.map((invocation) => invocation.label)).toEqual(["certify-challenge"]);
  });

  it("refuses a name the escaper cannot write as a certify violation, before any container runs", async () => {
    const { input, invocations } = harness();
    const result = await certifyInContainer({
      ...input,
      record: {
        ...input.record,
        proofs: [{ ...PROOFS[0]!, id: "Lax1Proofs._", telescope: PROOFS[0]!.telescope }],
      },
    });
    expect(result).toMatchObject({ kind: "violation", rule: "name", message: expect.stringContaining('"_"') });
    expect(invocations).toEqual([]);
  });

  it("refuses an export B left as a symlink", async () => {
    const { input } = harness({ solution: { code: 0, output: "", timedOut: false } });
    const runner = input.runner;
    input.runner = {
      ...runner,
      async run(invocation) {
        const result = await runner.run(invocation);
        if (invocation.label === "certify-solution") {
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
    await expect(certifyInContainer(harness({ solution: { code: 137, output: "", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 124, output: "", timedOut: true } }).input))
      .rejects.toMatchObject({ kind: "resource-limit" });
    await expect(certifyInContainer(harness({ challenge: { code: 125, output: "docker: daemon down", timedOut: false } }).input))
      .rejects.toMatchObject({ kind: "infrastructure" });
  });
});
