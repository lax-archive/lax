// Certify on the host, behind local `lax build` in a spec-2 environment
// (axiomfree-plan.md, "Decisions taken while drafting the spec": no sandbox,
// informational, never reused by `lax submit`). The same generator and the
// same three steps as the trusted containers — `lake build Challenge` plus
// the toolchain's `leanexport`, the same for `Solution`, then `lake
// comparator --challenge-from-export … --solution-from-export …
// --inadvisably-no-sandbox` over the two exports — over the local workspace:
// the generated project requires the submission's own packages, the
// dependencies lake built from source, and (nonstrict) the siblings built
// in place as path requires that are symlinks under the project
// (`packages/<Name>`), so the project is self-contained by name; a sandboxed
// rerun would need the links materialised, which `lax certify` (stage 4) is
// for.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import { infrastructureFailure, resourceLimitFailure } from "../failures.js";
import { hostLeanEnv, lakeBinary, lakePathEnv, packageLibDir, toolchainBinDir } from "../host/leanenv.js";
import { run } from "../host/proc.js";
import { seedOverrides } from "../host/warmstore.js";
import { dependencySubDir } from "../phases/provision.js";
import { sealBundle } from "./bundle.js";
import { nameViolation, type CertifyResult } from "./phase.js";
import {
  CHALLENGE_MODULE,
  SOLUTION_MODULE,
  kernelsOf,
  localPackagePath,
  planCertificate,
  projectLibDir,
  solutionProjectFiles,
  writeRunProject,
  type CertifyPlan,
  type CertifyRecord,
} from "./project.js";
import { interpretComparatorRun } from "./verdict.js";

export interface HostCertifyInput {
  record: CertifyRecord;
  jobDir: string;
  submissionRoot: string;
  warmWs: string;
  limits: ValidationLimits;
  echo: boolean;
  /** The lib dirs of the dependencies the proofs build materialised, and of
   * the siblings a nonstrict build built in place (host/pipeline.ts). */
  dependencyLibs: string[];
  phase: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
}

export async function certifyOnHost(input: HostCertifyInput): Promise<CertifyResult> {
  let plan: CertifyPlan | undefined;
  try {
    plan = planCertificate(input.record);
  } catch (error) {
    const violation = nameViolation(error);
    if (violation !== undefined) return violation;
    throw error;
  }
  if (plan === undefined) return { kind: "nothing" };
  const environment = input.record.environment;
  const certifyDir = path.join(input.jobDir, "certify");
  const projectDir = path.join(certifyDir, "project");
  const packagesDir = path.join(projectDir, "packages");

  // Where each package is on this machine: the own packages in the
  // submission, a dependency where the proofs build cloned and built it
  // (host/pipeline.ts dependencyLibDirs), a sibling in its own checkout.
  const locate = (name: string): string => {
    if (name === input.record.ownConcepts) return path.join(input.submissionRoot, "concepts");
    if (name === input.record.ownProofs) return path.join(input.submissionRoot, "proofs");
    const sibling = input.record.local?.packages.find((candidate) => candidate.name === name);
    if (sibling !== undefined) return sibling.dir;
    const dependency = plan.solutionClosure.find((candidate) => candidate.packageName === name);
    if (dependency === undefined) throw new Error(`the certificate requires ${name}, which this build did not resolve`);
    for (const kind of ["proofs", "concepts"] as const) {
      const clone = path.join(input.submissionRoot, kind, ".lake", "packages", name, dependencySubDir(dependency));
      if (fs.existsSync(clone)) return clone;
    }
    throw infrastructureFailure(`the dependency ${name} was not materialised by this build`);
  };
  const names = plan.manifestPackages.map((pkg) => pkg.name);
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(packagesDir, { recursive: true, mode: 0o700 });
  for (const name of names) fs.symlinkSync(fs.realpathSync(locate(name)), path.join(packagesDir, name));
  const pathSource = (name: string): { path: string } => ({ path: localPackagePath(name) });
  writeRunProject(
    projectDir,
    path.join(projectDir, ".lake"),
    solutionProjectFiles(plan, input.record, pathSource),
    { warm: input.record.warmPackages, deps: names.map((name) => ({ name, dir: localPackagePath(name) })) },
  );
  seedOverrides(input.warmWs, projectDir);

  const lake = lakeBinary(environment);
  const lakeEnv = {
    LAKE_ARTIFACT_CACHE: "false",
    LEAN_NUM_THREADS: String(input.limits.compileLeanThreads),
    PATH: lakePathEnv(environment),
  };
  /** `lake build <module>` then `leanexport <module>` over the composed path,
   * as containers A and B do (sandbox/tools/run-certify.mjs "export"). */
  const buildAndExport = async (
    module: string,
    ownLibs: string[],
    exportPath: string,
    rule: string,
    didNot: string,
  ): Promise<{ kind: "exported"; exportPath: string; sha256: string } | { kind: "violation"; rule: string; message: string }> => {
    if (input.echo) console.log(`\n== lake build ${module} (certificate) ==`);
    const build = await run(lake, ["build", module], projectDir, {
      echo: input.echo,
      env: lakeEnv,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (build.code === 124) throw resourceLimitFailure(`building the certificate ${module} exceeded its time limit`);
    if (build.code !== 0) {
      return {
        kind: "violation" as const,
        rule,
        message:
          `${didNot}, so lax's generator and classifier disagree with Lean; please report it as a lax bug, ` +
          `quoting this message. The transcript:\n${build.output.trim()}`,
      };
    }
    const leanEnv = hostLeanEnv(
      environment,
      [projectLibDir(projectDir), ...ownLibs],
      input.dependencyLibs,
      input.warmWs,
      input.limits.leanThreads,
    );
    const exported = await leanEnv.execToFile(
      path.join(toolchainBinDir(environment), "leanexport"),
      [module, "--", ...plan.exportTargets],
      projectDir,
      exportPath,
      { timeoutMs: input.limits.checkTimeoutMs },
    );
    if (exported.code === 124) throw resourceLimitFailure(`exporting the certificate ${module} exceeded its time limit`);
    if (exported.code !== 0) throw infrastructureFailure(`exporting the ${module} failed (exit ${exported.code}):\n${exported.output.trim()}`);
    const stat = fs.lstatSync(exportPath);
    if (!stat.isFile() || stat.size === 0) throw infrastructureFailure(`the ${module} export is empty`);
    return { kind: "exported" as const, exportPath, sha256: sha256File(exportPath) };
  };

  // ── the Challenge export, as container A makes it ──────────────────────
  const challenge = await input.phase("certify challenge", () =>
    buildAndExport(
      CHALLENGE_MODULE,
      [packageLibDir(path.join(input.submissionRoot, "concepts"))],
      path.join(certifyDir, "challenge.export"),
      "challenge-build",
      "the generated Challenge did not build over the concept packages — the statements lax named from the " +
        "proofs' telescopes do not elaborate the way Lean reads them",
    ));
  if (challenge.kind === "violation") return challenge;

  // ── the Solution export, as container B makes it ───────────────────────
  const solution = await input.phase("certify solution", () =>
    buildAndExport(
      SOLUTION_MODULE,
      [packageLibDir(path.join(input.submissionRoot, "concepts")), packageLibDir(path.join(input.submissionRoot, "proofs"))],
      path.join(certifyDir, "solution.export"),
      "solution-build",
      "the generated Solution did not elaborate — the certificate lax wrote from the proofs' telescopes does " +
        "not apply the proofs the way Lean reads them",
    ));
  if (solution.kind === "violation") return solution;

  // ── the comparator over both exports, as container C runs it ───────────
  const verdict = await input.phase("certify judge", async () => {
    if (input.echo) console.log("\n== lake comparator (certificate) ==");
    const result = await run(
      lake,
      [
        "comparator",
        "--config", "comparator.json",
        "--challenge-from-export", challenge.exportPath,
        "--solution-from-export", solution.exportPath,
        "--inadvisably-no-sandbox",
        ...(input.limits.certificationKernels === "paranoid" ? ["--paranoid"] : []),
      ],
      projectDir,
      {
        echo: input.echo,
        env: { ...lakeEnv, LEAN_NUM_THREADS: String(input.limits.leanThreads) },
        timeoutMs: input.limits.checkTimeoutMs,
        maxOutputBytes: input.limits.maxOutputBytes,
      },
    );
    if (result.code === 124) throw resourceLimitFailure("judging the certificate exceeded its time limit");
    // A toolchain without the comparator is a spec-1 toolchain in a spec-2
    // row — a table bug, never a verdict on the submission.
    if (/unknown (?:sub)?command/iu.test(result.output) && /comparator/u.test(result.output))
      throw infrastructureFailure(`the toolchain ${environment.leanToolchain} has no \`lake comparator\`: ${result.output.trim()}`);
    return interpretComparatorRun(result);
  });
  if (verdict.kind === "failure") throw verdict.failure;
  if (verdict.kind === "violation") return verdict;

  // The bundle of what ran here: path requires to this machine's packages,
  // so its digest is local; the archive's own run records the shareable one.
  const sealed = sealBundle({
    ...plan.bundle,
    "lakefile.toml": fs.readFileSync(path.join(projectDir, "lakefile.toml"), "utf8"),
    "lake-manifest.json": fs.readFileSync(path.join(projectDir, "lake-manifest.json"), "utf8"),
  });
  const bundlePath = path.join(certifyDir, "certificate.tar");
  fs.writeFileSync(bundlePath, sealed.tar, { mode: 0o600 });
  return {
    kind: "certified",
    bundlePath,
    certificate: {
      judge: { toolchain: environment.leanToolchain, comparatorExitCode: 0 },
      kernels: kernelsOf(input.limits.certificationKernels, environment),
      bundle: { formatVersion: 1, digest: sealed.digest },
      challengeExportSha256: challenge.sha256,
      solutionExportSha256: solution.sha256,
      challenge: plan.bundle["Challenge.lean"],
    },
  };
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
