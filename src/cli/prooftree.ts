import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublishedCapture } from "../submission-validation/artifact-schema.js";
import type { PublishedCapture } from "../submission-validation/contracts.js";
import {
  environmentOfPins,
  type ArchiveEnvironment,
} from "../submission-validation/environments.js";
import { leanFacts } from "../submission-validation/lean-facts.js";
import { lakeBinary, lakePathEnv, leanBinary } from "../submission-validation/host/leanenv.js";
import { mathlibUrl } from "../submission-validation/pins.js";
import { expandRecordedBuildOutput } from "../submission-validation/recorded-shape.js";
import { isObject, normalizeSubmissionId } from "../shared/validation.js";
import { laxHome } from "./auth.js";
import { materializeCapture } from "./capture-cache.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";

const MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024;
const COMPOSER_TIMEOUT_MS = 15 * 60_000;
const BACKGROUND_AXIOMS = new Set(leanFacts().backgroundAxioms);

export interface NetworkProof {
  id: string;
  submissionId: string;
  path: string;
  conclusion: string;
  assumptions: string[];
}

interface ArchiveSubmission {
  id: string;
  state: "draft" | "registered";
  statements: string[];
  conceptPaths: string[];
  proofs: NetworkProof[];
  requiredByConcepts: string[];
  requiredByProofs: string[];
  capture: PublishedCapture;
  /** The environment its capture was built in, by the capture's own pins.
   * Undefined when no admitted environment has them — a record from before an
   * entry was written, or one this CLI is too old to know. */
  environment?: ArchiveEnvironment;
}

export interface SelectedProof extends NetworkProof {
  selection: "grounded" | "fallback";
}

export interface ProofTreeSelection {
  roots: string[];
  order: SelectedProof[];
  unresolved: string[];
}

interface KernelTheoremResult {
  statement: string;
  proof: string;
  generated: string;
  axioms: string[];
  clean: boolean;
}

interface KernelReport {
  moduleName: string;
  outputOlean: string;
  theorems: KernelTheoremResult[];
}

interface KernelReportExpectation {
  moduleName: string;
  outputOlean: string;
  entries: Array<{
    statement: string;
    proof: string;
    generated: string;
  }>;
}

export interface GenerateProofTreeOptions {
  output?: string;
}

/**
 * Select a proof forest. A least-fixed-point pass records the order in which
 * every provable statement becomes grounded, and each statement's witness is
 * then its first proof whose assumptions all became grounded strictly earlier.
 * Traversal uses those witnesses preferentially; only an unprovable statement
 * falls back to a proof of its own, with cycles broken into unresolved leaves.
 */
export function selectProofTree(
  roots: string[],
  statements: Iterable<string>,
  proofs: NetworkProof[],
): ProofTreeSelection {
  const statementSet = new Set(statements);
  const grouped = new Map<string, NetworkProof[]>();
  for (const proof of proofs) {
    if (!statementSet.has(proof.conclusion)) continue;
    const values = grouped.get(proof.conclusion) ?? [];
    values.push(proof);
    grouped.set(proof.conclusion, values);
  }
  // The archive arrives in the order the database directory happened to be
  // read, which is a property of the filesystem rather than of the records, so
  // every pass below walks conclusions and candidates in sorted order instead.
  // Statement and proof ids are unique across the whole Archive, which makes
  // that a total order and the selection a function of the records alone: the
  // same database picks the same proofs on every machine and every run, and a
  // report naming an unresolved leaf can be reproduced by whoever reads it.
  for (const values of grouped.values()) values.sort((a, b) => a.id.localeCompare(b.id));
  const byConclusion = new Map([...grouped].sort(([left], [right]) => left.localeCompare(right)));

  // A proof reaches `ready` only once every one of its assumptions is already
  // grounded, so the rank recorded here — a statement's position in the
  // grounding order — is strictly greater than the rank of every assumption of
  // the proof that grounded it.
  const groundedRank = new Map<string, number>();
  const remainingAssumptions = new Map<NetworkProof, number>();
  const proofsByAssumption = new Map<string, NetworkProof[]>();
  const ready: NetworkProof[] = [];
  for (const candidates of byConclusion.values()) {
    for (const proof of candidates) {
      const assumptions = [...new Set(proof.assumptions)];
      remainingAssumptions.set(proof, assumptions.length);
      if (assumptions.length === 0) ready.push(proof);
      for (const assumption of assumptions) {
        const dependents = proofsByAssumption.get(assumption) ?? [];
        dependents.push(proof);
        proofsByAssumption.set(assumption, dependents);
      }
    }
  }
  for (let index = 0; index < ready.length; index += 1) {
    const proof = ready[index]!;
    if (groundedRank.has(proof.conclusion)) continue;
    groundedRank.set(proof.conclusion, groundedRank.size);
    for (const dependent of proofsByAssumption.get(proof.conclusion) ?? []) {
      const remaining = remainingAssumptions.get(dependent);
      if (remaining === undefined || remaining === 0) continue;
      remainingAssumptions.set(dependent, remaining - 1);
      if (remaining === 1) ready.push(dependent);
    }
  }

  // Select only after reaching the fixed point. Otherwise a statement visited
  // early can see just one eligible proof even though more proofs become
  // grounded later in the same pass. Eligibility is then restricted to the
  // proofs whose assumptions all became grounded strictly before the
  // conclusion did: two statements that prove each other are both grounded as
  // soon as either one is on its own, and taking the other's proof as a
  // witness would build a witness cycle that the traversal below could only
  // report as an unresolved leaf. Rank strictly decreases along every witness
  // edge, so the witness relation is acyclic by construction and a grounded
  // statement is never unresolved. The proof that grounded a statement always
  // satisfies the restriction, so it never costs a statement its witness.
  const groundedWitness = new Map<string, NetworkProof>();
  for (const [statement, rank] of groundedRank) {
    const witness = (byConclusion.get(statement) ?? []).find((candidate) =>
      candidate.assumptions.every((assumption) => {
        const assumptionRank = groundedRank.get(assumption);
        return assumptionRank !== undefined && assumptionRank < rank;
      }));
    groundedWitness.set(statement, witness!);
  }

  const selected = new Map<string, SelectedProof>();
  const unresolved = new Set<string>();
  const order: SelectedProof[] = [];
  const active = new Set<string>();
  type VisitFrame =
    | { stage: "enter"; statement: string }
    | { stage: "exit"; statement: string; proof: SelectedProof };
  const visit = (root: string): void => {
    const stack: VisitFrame[] = [{ stage: "enter", statement: root }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.stage === "exit") {
        active.delete(frame.statement);
        order.push(frame.proof);
        continue;
      }
      const { statement } = frame;
      if (unresolved.has(statement)) continue;
      if (active.has(statement)) {
        unresolved.add(statement);
        continue;
      }
      if (selected.has(statement)) continue;
      const groundedProof = groundedWitness.get(statement);
      const candidates = byConclusion.get(statement) ?? [];
      const proof = groundedProof ?? candidates[0];
      if (proof === undefined) {
        unresolved.add(statement);
        continue;
      }
      const chosen: SelectedProof = {
        ...proof,
        selection: groundedProof === undefined ? "fallback" : "grounded",
      };
      selected.set(statement, chosen);
      active.add(statement);
      stack.push({ stage: "exit", statement, proof: chosen });
      for (let index = proof.assumptions.length - 1; index >= 0; index -= 1) {
        stack.push({ stage: "enter", statement: proof.assumptions[index]! });
      }
    }
  };
  for (const root of [...new Set(roots)].sort()) visit(root);
  return { roots: [...new Set(roots)].sort(), order, unresolved: [...unresolved].sort() };
}

export async function generateProofTree(
  submissionInput: string,
  options: GenerateProofTreeOptions = {},
): Promise<number> {
  const submissionId = normalizeSubmissionId(submissionInput);
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) {
    throw new Error(`local lax-database checkout is missing at ${database}; run \`lax sync\``);
  }
  const refresh = tryRefreshDatabase();
  if (refresh === "failed") {
    console.warn("lax generate-prooftree: database refresh failed; using the existing checkout");
  }
  const archive = loadArchive(database);
  const target = archive.get(submissionId);
  if (target === undefined) throw new Error(`${submissionId} has no draft or registered Archive content`);
  if (target.statements.length === 0) throw new Error(`${submissionId} declares no statements`);
  // A proof tree is composed inside one environment: its modules are loaded
  // into a single Lean process, and an olean built by one toolchain cannot be
  // read by another. The target's environment is the tree's.
  const environment = target.environment;
  if (environment === undefined) {
    throw new Error(
      `${submissionId} was built in ${describeEnvironment(target.capture)}; ` +
        "update lax if the environment is newer than this CLI",
    );
  }

  const allStatements = [...archive.values()].flatMap((submission) => submission.statements);
  const allProofs = [...archive.values()].flatMap((submission) => submission.proofs);
  const selection = selectProofTree(target.statements, allStatements, allProofs);
  if (selection.order.length === 0) {
    throw new Error(`${submissionId} has no proof candidate for any of its statements`);
  }

  const outputDirectory = path.resolve(options.output ?? `prooftree-${submissionId}`);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const numericId = submissionId.slice("lax-".length);
  const moduleName = `Lax${numericId}ProofTree`;
  const outputOlean = path.join(outputDirectory, `${moduleName}.olean`);
  const kernelReportFile = path.join(outputDirectory, "kernel-report.json");
  const requestFile = path.join(outputDirectory, "compose-request.json");
  const finalReportFile = path.join(outputDirectory, "proof-tree.json");
  for (const filename of [kernelReportFile, requestFile, finalReportFile]) {
    fs.rmSync(filename, { force: true });
  }

  const captureIds = captureClosure(archive, selection.order.map((proof) => proof.submissionId));
  console.log(
    `lax generate-prooftree: selected ${selection.order.length} proofs across ` +
      `${new Set(selection.order.map((proof) => proof.submissionId)).size} submissions`,
  );
  const captureRoots = new Map<string, string>();
  for (const id of captureIds) {
    const submission = archive.get(id);
    if (submission === undefined) throw new Error(`selected proof dependency ${id} is unavailable`);
    if (submission.environment?.id !== environment.id) {
      throw new Error(
        `${id} is in ${describeEnvironment(submission.capture)} but ${submissionId} is in ` +
          `${environment.id}; a proof tree cannot span two environments`,
      );
    }
    captureRoots.set(id, await materializeCapture(id, submission.capture, () => console.log(`lax generate-prooftree: downloading ${id} capture`)));
  }

  const proofModules = [...new Set(selection.order.map((proof) => moduleFromProofPath(proof.path)))].sort();
  const conceptModules = [...new Set(captureIds.flatMap((id) =>
    archive.get(id)?.conceptPaths.map(moduleFromConceptPath) ?? [],
  ))].sort();
  const capturedLeanPaths = [...captureRoots.values()].flatMap((root) =>
    [path.join(root, "concepts", "lib"), path.join(root, "proofs", "lib")]
      .filter((directory) => fs.existsSync(directory)),
  );
  const mathlibLeanPath = ensureMathlibEnvironment(environment);
  const leanPath = [...capturedLeanPaths, mathlibLeanPath].filter(Boolean).join(path.delimiter);
  const composer = composerSource();
  const verifier = verifierSource();
  const staging = fs.mkdtempSync(path.join(outputDirectory, ".run-"));
  const stagedOlean = path.join(staging, `${moduleName}.olean`);
  const stagedKernelReport = path.join(staging, "kernel-report.json");
  const stagedRequest = path.join(staging, "compose-request.json");
  const entries = selection.order.map((proof) => ({
    statement: proof.conclusion,
    proof: proof.id,
    generated: `${moduleName}.${proof.conclusion}`,
    assumptions: proof.assumptions,
  }));
  let kernelReport: KernelReport;
  try {
    fs.writeFileSync(stagedRequest, `${JSON.stringify({
      moduleName,
      outputOlean: stagedOlean,
      outputReport: stagedKernelReport,
      conceptModules,
      entries,
    }, null, 2)}\n`);
    console.log(`lax generate-prooftree: kernel-checking ${entries.length} generated theorems`);
    runLean(
      environment,
      ["--run", composer, stagedRequest, ...proofModules],
      staging,
      leanPath,
    );
    const verificationLeanPath = [
      staging,
      ...[...captureRoots.values()].map((root) => path.join(root, "concepts", "lib")),
      mathlibLeanPath,
    ].join(path.delimiter);
    console.log("lax generate-prooftree: verifying the standalone generated module");
    runLean(
      environment,
      ["--run", verifier, stagedRequest, moduleName],
      staging,
      verificationLeanPath,
    );
    kernelReport = readKernelReport(stagedKernelReport, {
      moduleName,
      outputOlean: stagedOlean,
      entries,
    });
    fs.renameSync(stagedOlean, outputOlean);
    fs.writeFileSync(kernelReportFile, `${JSON.stringify({
      ...kernelReport,
      outputOlean,
    }, null, 2)}\n`);
    fs.writeFileSync(requestFile, `${JSON.stringify({
      moduleName,
      outputOlean,
      outputReport: kernelReportFile,
      conceptModules,
      entries,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const auditByStatement = new Map(kernelReport.theorems.map((theorem) => [theorem.statement, theorem]));
  const rootAudits = selection.roots.map((root) => auditByStatement.get(root));
  const clean = selection.unresolved.length === 0 &&
    rootAudits.every((audit) => audit !== undefined && audit.clean);
  const finalReport = {
    version: 1,
    submissionId,
    moduleName,
    outputOlean,
    roots: selection.roots,
    unresolved: selection.unresolved,
    selectedProofs: selection.order.map((proof) => ({
      statement: proof.conclusion,
      proof: proof.id,
      assumptions: proof.assumptions,
      submissionId: proof.submissionId,
      selection: proof.selection,
    })),
    theorems: kernelReport.theorems,
    clean,
  };
  fs.writeFileSync(finalReportFile, `${JSON.stringify(finalReport, null, 2)}\n`);

  for (const root of selection.roots) {
    const audit = auditByStatement.get(root);
    if (audit === undefined) console.log(`  open  ${root} — no generated theorem`);
    else {
      const axioms = audit.axioms.length === 0 ? "no axioms" : audit.axioms.join(", ");
      console.log(`  ${audit.clean ? "clean" : "open "}  ${root} — ${axioms}`);
    }
  }
  if (selection.unresolved.length > 0) {
    console.warn(`unresolved statement leaves: ${selection.unresolved.join(", ")}`);
  }
  console.log(`Generated module: ${outputOlean}`);
  console.log(`Proof-tree report: ${finalReportFile}`);
  return clean ? 0 : 1;
}

function loadArchive(directory: string): Map<string, ArchiveSubmission> {
  const result = new Map<string, ArchiveSubmission>();
  const statementOwners = new Map<string, string>();
  const proofOwners = new Map<string, string>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^lax-[1-9][0-9]*$/u.test(entry.name)) continue;
    const record = readObject(path.join(directory, entry.name, "record.json"));
    if (record.id !== entry.name || (record.state !== "draft" && record.state !== "registered")) continue;
    const stored = readObject(path.join(directory, entry.name, "build-output.json"));
    if (stored.id !== entry.name) throw new Error(`${entry.name}/build-output.json has the wrong id`);
    // a spec-2 record stores no conclusion, assumptions, or capture pins
    // (recorded-shape.ts); read both shapes as the full one
    const output = expandRecordedBuildOutput(stored, entry.name);
    const capture = parsePublishedCapture(output.capture);
    const environment = captureEnvironment(capture);
    const concepts = objectArray(output.concepts, `${entry.name} concepts`);
    const conceptPaths: string[] = [];
    const statements: string[] = [];
    for (const concept of concepts) {
      conceptPaths.push(requiredString(concept.path, `${entry.name} concept path`));
      for (const statement of objectArray(concept.statements, `${entry.name} concept statements`)) {
        statements.push(requiredString(statement.id, `${entry.name} statement id`));
      }
    }
    const proofs = objectArray(output.proofs, `${entry.name} proofs`).map((proof): NetworkProof => ({
      id: requiredString(proof.id, `${entry.name} proof id`),
      submissionId: entry.name,
      path: requiredString(proof.path, `${entry.name} proof path`),
      conclusion: requiredString(proof.conclusion, `${entry.name} proof conclusion`),
      assumptions: stringArray(proof.assumptions, `${entry.name} proof assumptions`),
    }));
    for (const statement of statements) {
      const previous = statementOwners.get(statement);
      if (previous !== undefined) throw new Error(`statement ${statement} occurs in both ${previous} and ${entry.name}`);
      statementOwners.set(statement, entry.name);
    }
    for (const proof of proofs) {
      const previous = proofOwners.get(proof.id);
      if (previous !== undefined) throw new Error(`proof ${proof.id} occurs in both ${previous} and ${entry.name}`);
      proofOwners.set(proof.id, entry.name);
    }
    result.set(entry.name, {
      id: entry.name,
      state: record.state,
      statements: [...new Set(statements)].sort(),
      conceptPaths: [...new Set(conceptPaths)].sort(),
      proofs,
      requiredByConcepts: stringArray(output.requiredByConcepts, `${entry.name} requiredByConcepts`),
      requiredByProofs: stringArray(output.requiredByProofs, `${entry.name} requiredByProofs`),
      capture,
      ...(environment === undefined ? {} : { environment }),
    });
  }
  return result;
}

function captureClosure(
  archive: Map<string, ArchiveSubmission>,
  initial: string[],
): string[] {
  const pending = [...new Set(initial)].sort();
  const found = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]!;
    if (found.has(id)) continue;
    const submission = archive.get(id);
    if (submission === undefined) throw new Error(`capture dependency ${id} is unavailable`);
    found.add(id);
    for (const packageName of [...submission.requiredByConcepts, ...submission.requiredByProofs]) {
      const dependencyId = submissionIdFromPackage(packageName);
      if (dependencyId !== undefined && !found.has(dependencyId)) pending.push(dependencyId);
    }
  }
  return [...found].sort(compareSubmissionIds);
}

function submissionIdFromPackage(packageName: string): string | undefined {
  const match = /^Lax([1-9][0-9]*)(?:Proofs)?$/u.exec(packageName);
  return match === null ? undefined : `lax-${match[1]}`;
}

function compareSubmissionIds(left: string, right: string): number {
  return Number(left.slice("lax-".length)) - Number(right.slice("lax-".length));
}

/** The environment a record's capture belongs to, by its recorded pins. The
 * archive holds several; which ones this composer may load together is the
 * target submission's environment, decided in generateProofTree. */
function captureEnvironment(capture: PublishedCapture): ArchiveEnvironment | undefined {
  if (capture.leanToolchain === undefined || capture.mathlibCommit === undefined) return undefined;
  return environmentOfPins(capture.leanToolchain, capture.mathlibCommit);
}

/** Describe a record's environment for a message: its id, or its raw pins when
 * no admitted entry has them. */
function describeEnvironment(capture: PublishedCapture): string {
  return (
    captureEnvironment(capture)?.id ??
    `an environment unknown to this CLI (${capture.leanToolchain} / ${capture.mathlibCommit})`
  );
}

/** The composer's own mathlib workspace, one per environment: the toolchain
 * and the commit both decide what its LEAN_PATH means, so the directory is
 * keyed like the warm store rather than by the commit alone. Every binary is
 * resolved through the environment's toolchain, never through PATH. */
function ensureMathlibEnvironment(environment: ArchiveEnvironment): string {
  const lean = leanBinary(environment);
  const lake = lakeBinary(environment);
  const version = execFileSync(lean, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!version.includes(`version ${environment.id.slice(1)}`)) {
    throw new Error(
      `generate-prooftree requires Lean ${environment.id} for this submission; found ${version.trim()}`,
    );
  }
  const runtime = path.join(
    laxHome(),
    "prooftree-runtime",
    `${environment.id}-${environment.mathlibCommit.slice(0, 12)}`,
  );
  const marker = path.join(runtime, ".ready");
  const mathlib = path.join(runtime, ...leanFacts(environment).lakePackagesDir, "mathlib");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lakefile = [
    'name = "LaxProofTreeRuntime"',
    'defaultTargets = ["LaxProofTreeRuntime"]',
    "",
    "[[require]]",
    'name = "mathlib"',
    `git = "${mathlibUrl()}"`,
    `rev = "${environment.mathlibCommit}"`,
    "",
    "[[lean_lib]]",
    'name = "LaxProofTreeRuntime"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(runtime, "lakefile.toml"), lakefile);
  fs.writeFileSync(path.join(runtime, "lean-toolchain"), `${environment.leanToolchain}\n`);
  fs.writeFileSync(path.join(runtime, "LaxProofTreeRuntime.lean"), "import Mathlib\n");
  let ready = false;
  try {
    ready = fs.readFileSync(marker, "utf8").trim() === environment.mathlibCommit &&
      execFileSync("git", ["-C", mathlib, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === environment.mathlibCommit;
  } catch {
    ready = false;
  }
  if (!ready) {
    console.log("lax generate-prooftree: preparing the pinned Mathlib cache (first run only)");
    const lakeEnv = { ...process.env, PATH: lakePathEnv(environment) };
    execFileSync(lake, ["update"], { cwd: runtime, stdio: "inherit", env: lakeEnv });
    execFileSync(lake, ["exe", "cache", "get"], { cwd: runtime, stdio: "inherit", env: lakeEnv });
    const actual = execFileSync("git", ["-C", mathlib, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (actual !== environment.mathlibCommit)
      throw new Error("the proof-tree Mathlib checkout has the wrong commit");
    fs.writeFileSync(marker, `${environment.mathlibCommit}\n`);
  }
  return execFileSync(lake, ["env", "printenv", "LEAN_PATH"], {
    cwd: runtime,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: lakePathEnv(environment) },
  }).trim();
}

function composerSource(): string {
  const filename = path.join(packageRoot(), "assets", "prooftree", "Main.lean");
  if (!fs.existsSync(filename)) throw new Error(`proof-tree composer is missing at ${filename}`);
  return filename;
}

function verifierSource(): string {
  const filename = path.join(packageRoot(), "assets", "prooftree", "Verify.lean");
  if (!fs.existsSync(filename)) throw new Error(`proof-tree verifier is missing at ${filename}`);
  return filename;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function runLean(
  environment: ArchiveEnvironment,
  args: string[],
  cwd: string,
  leanPath: string,
): void {
  execFileSync(leanBinary(environment), args, {
    cwd,
    stdio: "inherit",
    env: {
      PATH: lakePathEnv(environment),
      HOME: process.env.HOME,
      ELAN_TOOLCHAIN: environment.leanToolchain,
      LEAN_PATH: leanPath,
    },
    timeout: COMPOSER_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function moduleFromProofPath(value: string): string {
  if (!value.startsWith("proofs/") || !value.endsWith(".lean")) {
    throw new Error(`proof path is not inside proofs/: ${value}`);
  }
  return value.slice("proofs/".length, -".lean".length).split("/").join(".");
}

function moduleFromConceptPath(value: string): string {
  if (!value.startsWith("concepts/") || !value.endsWith(".lean")) {
    throw new Error(`concept path is not inside concepts/: ${value}`);
  }
  return value.slice("concepts/".length, -".lean".length).split("/").join(".");
}

function readKernelReport(
  filename: string,
  expected: KernelReportExpectation,
): KernelReport {
  const value = readObject(filename);
  const theorems = objectArray(value.theorems, "kernel theorem results").map((theorem): KernelTheoremResult => ({
    statement: requiredString(theorem.statement, "kernel theorem statement"),
    proof: requiredString(theorem.proof, "kernel theorem proof"),
    generated: requiredString(theorem.generated, "kernel generated theorem"),
    axioms: stringArray(theorem.axioms, "kernel theorem axioms"),
    clean: requiredBoolean(theorem.clean, "kernel theorem clean"),
  }));
  const report = {
    moduleName: requiredString(value.moduleName, "kernel moduleName"),
    outputOlean: requiredString(value.outputOlean, "kernel outputOlean"),
    theorems,
  };
  if (report.moduleName !== expected.moduleName) {
    throw new Error(`kernel report names module ${report.moduleName}; expected ${expected.moduleName}`);
  }
  if (path.resolve(report.outputOlean) !== path.resolve(expected.outputOlean)) {
    throw new Error("kernel report names the wrong output module");
  }
  if (report.theorems.length !== expected.entries.length) {
    throw new Error("kernel report does not contain exactly the requested theorems");
  }
  for (let index = 0; index < expected.entries.length; index += 1) {
    const actual = report.theorems[index]!;
    const entry = expected.entries[index]!;
    if (
      actual.statement !== entry.statement ||
      actual.proof !== entry.proof ||
      actual.generated !== entry.generated
    ) {
      throw new Error(`kernel report theorem ${index + 1} does not match the compose request`);
    }
    if (actual.clean !== isBackgroundOnly(actual.axioms)) {
      throw new Error(`kernel report clean flag disagrees with the axioms for ${actual.statement}`);
    }
  }
  return report;
}

function readObject(filename: string): Record<string, unknown> {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`${filename} is not a bounded file`);
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  if (!isObject(value)) throw new Error(`${filename} must contain a JSON object`);
  return value;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isObject)) throw new Error(`${label} must be an array of objects`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...new Set(value)].sort();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function isBackgroundOnly(axioms: string[]): boolean {
  return axioms.every((axiom) => BACKGROUND_AXIOMS.has(axiom));
}
