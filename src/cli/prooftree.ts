import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublishedCapture } from "../submission-validation/artifact-schema.js";
import type { PublishedCapture } from "../submission-validation/contracts.js";
import { isObject, normalizeSubmissionId } from "../shared/validation.js";
import { laxHome } from "./auth.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import lock from "../submission-validation/runtime/validation-runtime.lock.json" with { type: "json" };

const MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
const COMPOSER_TIMEOUT_MS = 15 * 60_000;
const BACKGROUND_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

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
  capture: ArchiveCapture;
}

interface ArchiveCapture extends Omit<PublishedCapture, "downloadUrl"> {
  downloadUrl?: string;
  registryBlob?: string;
}

export interface SelectedProof extends NetworkProof {
  selection: "grounded" | "random";
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
 * Select a proof forest. A least-fixed-point pass records one randomly chosen
 * grounded witness for every provable statement. Traversal uses those
 * witnesses preferentially; only an unprovable statement falls back to a
 * random proof, with cycles broken into unresolved leaves.
 */
export function selectProofTree(
  roots: string[],
  statements: Iterable<string>,
  proofs: NetworkProof[],
  choose: (length: number) => number = randomInt,
): ProofTreeSelection {
  const statementSet = new Set(statements);
  const byConclusion = new Map<string, NetworkProof[]>();
  for (const proof of proofs) {
    if (!statementSet.has(proof.conclusion)) continue;
    const values = byConclusion.get(proof.conclusion) ?? [];
    values.push(proof);
    byConclusion.set(proof.conclusion, values);
  }
  for (const values of byConclusion.values()) values.sort((a, b) => a.id.localeCompare(b.id));

  const grounded = new Set<string>();
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
    if (grounded.has(proof.conclusion)) continue;
    grounded.add(proof.conclusion);
    for (const dependent of proofsByAssumption.get(proof.conclusion) ?? []) {
      const remaining = remainingAssumptions.get(dependent);
      if (remaining === undefined || remaining === 0) continue;
      remainingAssumptions.set(dependent, remaining - 1);
      if (remaining === 1) ready.push(dependent);
    }
  }

  // Select only after reaching the fixed point. Otherwise a statement visited
  // early can see just one eligible proof even though more proofs become
  // grounded later in the same pass.
  const groundedWitness = new Map<string, NetworkProof>();
  for (const statement of [...grounded].sort()) {
    const eligible = (byConclusion.get(statement) ?? [])
      .filter((proof) => proof.assumptions.every((assumption) => grounded.has(assumption)));
    groundedWitness.set(statement, eligible[boundedChoice(eligible.length, choose)]!);
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
      const proof = groundedProof ??
        (candidates.length === 0 ? undefined : candidates[boundedChoice(candidates.length, choose)]);
      if (proof === undefined) {
        unresolved.add(statement);
        continue;
      }
      const chosen: SelectedProof = {
        ...proof,
        selection: groundedProof === undefined ? "random" : "grounded",
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
    throw new Error(`local lax-database checkout is missing at ${database}; run \`lax update-db\``);
  }
  const refresh = tryRefreshDatabase();
  if (refresh === "failed") {
    console.warn("lax generate-prooftree: database refresh failed; using the existing checkout");
  }
  const archive = loadArchive(database);
  const target = archive.get(submissionId);
  if (target === undefined) throw new Error(`${submissionId} has no draft or registered Archive content`);
  if (target.statements.length === 0) throw new Error(`${submissionId} declares no statements`);

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
    captureRoots.set(id, await materializeCapture(id, submission.capture));
  }

  const proofModules = [...new Set(selection.order.map((proof) => moduleFromProofPath(proof.path)))].sort();
  const conceptModules = [...new Set(captureIds.flatMap((id) =>
    archive.get(id)?.conceptPaths.map(moduleFromConceptPath) ?? [],
  ))].sort();
  const capturedLeanPaths = [...captureRoots.values()].flatMap((root) =>
    [path.join(root, "concepts", "lib"), path.join(root, "proofs", "lib")]
      .filter((directory) => fs.existsSync(directory)),
  );
  const mathlibLeanPath = ensureMathlibEnvironment();
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

function boundedChoice(length: number, choose: (length: number) => number): number {
  if (length <= 0) throw new Error("cannot choose from an empty proof set");
  const value = choose(length);
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    throw new Error(`proof chooser returned ${value} for ${length} candidates`);
  }
  return value;
}

function loadArchive(directory: string): Map<string, ArchiveSubmission> {
  const result = new Map<string, ArchiveSubmission>();
  const statementOwners = new Map<string, string>();
  const proofOwners = new Map<string, string>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^lax-[1-9][0-9]*$/u.test(entry.name)) continue;
    const record = readObject(path.join(directory, entry.name, "record.json"));
    if (record.id !== entry.name || (record.state !== "draft" && record.state !== "registered")) continue;
    const output = readObject(path.join(directory, entry.name, "build-output.json"));
    if (output.id !== entry.name) throw new Error(`${entry.name}/build-output.json has the wrong id`);
    const capture = parseArchiveCapture(output.capture);
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

function parseArchiveCapture(value: unknown): ArchiveCapture {
  if (!isObject(value)) throw new Error("published capture must be an object");
  if (typeof value.downloadUrl === "string") return requirePinnedCapture(parsePublishedCapture(value));
  if (typeof value.registryBlob !== "string") {
    throw new Error("published capture has neither downloadUrl nor registryBlob");
  }
  const registryBlob = value.registryBlob;
  const compatibilityValue: Record<string, unknown> = {
    ...value,
    downloadUrl: "https://github.com/lax-archive/capture.tar",
  };
  delete compatibilityValue.registryBlob;
  const parsed = parsePublishedCapture(compatibilityValue);
  const match = /^ghcr\.io\/[a-z0-9._/-]+@sha256:([0-9a-f]{64})$/u.exec(registryBlob);
  if (match === null || match[1] !== parsed.digest) {
    throw new Error("published capture registryBlob does not match its digest");
  }
  const { downloadUrl: _compatibilityUrl, ...base } = parsed;
  return requirePinnedCapture({ ...base, registryBlob });
}

function requirePinnedCapture(capture: ArchiveCapture): ArchiveCapture {
  if (
    capture.leanToolchain !== lock.leanToolchain ||
    capture.mathlibCommit !== lock.mathlibCommit
  ) {
    throw new Error(
      `capture runtime ${capture.leanToolchain} / ${capture.mathlibCommit} does not match ` +
      `the single pinned runtime ${lock.leanToolchain} / ${lock.mathlibCommit}`,
    );
  }
  return capture;
}

async function materializeCapture(id: string, capture: ArchiveCapture): Promise<string> {
  const parent = path.join(laxHome(), "prooftree-captures", id);
  const target = path.join(parent, capture.digest);
  if (fs.existsSync(target)) {
    verifyCapture(target, capture);
    return target;
  }
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, `${capture.digest}.tmp-`));
  const archive = path.join(staging, "capture.tar");
  const extracted = path.join(staging, "content");
  try {
    console.log(`lax generate-prooftree: downloading ${id} capture`);
    if (capture.downloadUrl !== undefined) await downloadCapture(capture.downloadUrl, archive);
    else if (capture.registryBlob !== undefined) await downloadRegistryBlob(capture.registryBlob, archive);
    else throw new Error(`${id} capture has no download location`);
    if (sha256File(archive) !== capture.digest) throw new Error(`${id} capture archive digest mismatch`);
    extractCapture(archive, extracted);
    verifyCapture(extracted, capture);
    fs.renameSync(extracted, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function downloadCapture(rawUrl: string, destination: string): Promise<void> {
  const allowedHosts = new Set([
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ]);
  const initial = new URL(rawUrl);
  if (initial.protocol !== "https:" || !allowedHosts.has(initial.hostname) || initial.username || initial.password) {
    throw new Error("capture URL is not an allowed public HTTPS location");
  }
  const response = await fetch(initial, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  const final = new URL(response.url);
  if (!response.ok || response.body === null) throw new Error(`capture download failed with HTTP ${response.status}`);
  if (final.protocol !== "https:" || !allowedHosts.has(final.hostname) || final.username || final.password) {
    throw new Error("capture redirect leaves the allowed public HTTPS locations");
  }
  await writeResponse(response, destination);
}

async function downloadRegistryBlob(reference: string, destination: string): Promise<void> {
  const match = /^ghcr\.io\/([a-z0-9._/-]+)@sha256:([0-9a-f]{64})$/u.exec(reference);
  if (match === null) throw new Error("capture registryBlob is not a canonical GHCR digest reference");
  const repository = match[1]!;
  const digest = match[2]!;
  const scope = `repository:${repository}:pull`;
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!tokenResponse.ok) throw new Error(`GHCR token request failed with HTTP ${tokenResponse.status}`);
  const tokenValue = await tokenResponse.json() as { token?: unknown };
  if (typeof tokenValue.token !== "string" || tokenValue.token === "") {
    throw new Error("GHCR token response is malformed");
  }
  const response = await fetch(
    `https://ghcr.io/v2/${repository}/blobs/sha256:${digest}`,
    {
      redirect: "follow",
      headers: { authorization: `Bearer ${tokenValue.token}` },
      signal: AbortSignal.timeout(10 * 60_000),
    },
  );
  if (!response.ok || response.body === null) throw new Error(`GHCR blob download failed with HTTP ${response.status}`);
  const final = new URL(response.url);
  if (
    final.protocol !== "https:" ||
    !["ghcr.io", "pkg-containers.githubusercontent.com"].includes(final.hostname) ||
    final.username ||
    final.password
  ) throw new Error("GHCR blob redirect leaves the allowed public HTTPS locations");
  await writeResponse(response, destination);
}

async function writeResponse(response: Response, destination: string): Promise<void> {
  if (response.body === null) throw new Error("capture response has no body");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_CAPTURE_BYTES) throw new Error("capture exceeds 2 GiB");
  const reader = response.body.getReader();
  const handle = fs.openSync(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) throw new Error("capture exceeds 2 GiB");
      fs.writeSync(handle, value);
    }
  } finally {
    fs.closeSync(handle);
  }
}

function extractCapture(archive: string, destination: string): void {
  const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const line of listing.split("\n").filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") throw new Error("capture contains a link or special entry");
  }
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const entry of names.split("\n").filter(Boolean)) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
    if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../") || entry.includes("\\")) {
      throw new Error("capture contains an escaping path");
    }
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
}

function verifyCapture(root: string, capture: ArchiveCapture): void {
  const expected = new Map(capture.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("cached capture contains a symlink");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        const relative = path.relative(root, filename).split(path.sep).join("/");
        const specification = expected.get(relative);
        if (specification === undefined) throw new Error(`cached capture has unexpected file ${relative}`);
        const stat = fs.statSync(filename);
        if (stat.size !== specification.bytes || sha256File(filename) !== specification.sha256) {
          throw new Error(`cached capture file failed verification: ${relative}`);
        }
        seen.add(relative);
      } else throw new Error("cached capture contains a special entry");
    }
  };
  walk(root);
  if (seen.size !== expected.size) throw new Error("cached capture is missing declared files");
}

function ensureMathlibEnvironment(): string {
  const version = execFileSync("lean", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!version.includes(`version ${lock.leanVersion.slice(1)}`)) {
    throw new Error(`generate-prooftree requires Lean ${lock.leanVersion}; found ${version.trim()}`);
  }
  const runtime = path.join(laxHome(), "prooftree-runtime", lock.mathlibCommit);
  const marker = path.join(runtime, ".ready");
  const mathlib = path.join(runtime, ".lake", "packages", "mathlib");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lakefile = [
    'name = "LaxProofTreeRuntime"',
    'defaultTargets = ["LaxProofTreeRuntime"]',
    "",
    "[[require]]",
    'name = "mathlib"',
    `git = "${lock.mathlibRepository}"`,
    `rev = "${lock.mathlibCommit}"`,
    "",
    "[[lean_lib]]",
    'name = "LaxProofTreeRuntime"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(runtime, "lakefile.toml"), lakefile);
  fs.writeFileSync(path.join(runtime, "lean-toolchain"), `${lock.leanToolchain}\n`);
  fs.writeFileSync(path.join(runtime, "LaxProofTreeRuntime.lean"), "import Mathlib\n");
  let ready = false;
  try {
    ready = fs.readFileSync(marker, "utf8").trim() === lock.mathlibCommit &&
      execFileSync("git", ["-C", mathlib, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === lock.mathlibCommit;
  } catch {
    ready = false;
  }
  if (!ready) {
    console.log("lax generate-prooftree: preparing the pinned Mathlib cache (first run only)");
    execFileSync("lake", ["update"], { cwd: runtime, stdio: "inherit" });
    execFileSync("lake", ["exe", "cache", "get"], { cwd: runtime, stdio: "inherit" });
    const actual = execFileSync("git", ["-C", mathlib, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (actual !== lock.mathlibCommit) throw new Error("the proof-tree Mathlib checkout has the wrong commit");
    fs.writeFileSync(marker, `${lock.mathlibCommit}\n`);
  }
  return execFileSync("lake", ["env", "printenv", "LEAN_PATH"], {
    cwd: runtime,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

function runLean(args: string[], cwd: string, leanPath: string): void {
  execFileSync("lean", args, {
    cwd,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME,
      ELAN_TOOLCHAIN: lock.leanToolchain,
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

function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

export function isBackgroundOnly(axioms: string[]): boolean {
  return axioms.every((axiom) => BACKGROUND_AXIOMS.has(axiom));
}
