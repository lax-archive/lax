// `lax certify <target>`: a rerunnable certificate from the local archive copy
// (axiomfree-plan.md, "CLI, authoring, website"; the draft spec's "CLI" and
// "Relative certificates").
//
// Three targets, one bundle shape. A record id regenerates the record's own
// bundle from what `build-output.json` stores — the proofs' telescopes, the
// environment row, the dependency records' source triples — and holds the
// regenerated `Challenge.lean` to the record's stored one byte for byte; or,
// with --fetch, pulls the stored bundle by its digest instead. A proof id is
// the bundle restricted to that one edge. A statement id is a *relative*
// certificate: the implied edge `{--relative-to statements} → statement`,
// discharged by the archive's proofs composed along the witness forest
// `selectProofTree` picks (certify/compose.ts). The five files plus a
// `lean-toolchain` land in a folder; the command prints the `lake comparator`
// line a reader runs there, or runs it with --run — sandboxed, as the tool
// is: `--inadvisably-no-sandbox` is for lax's own build and is not offered
// here, because this run is the author's trustworthy rerun.
//
// Needs the local archive copy, and for regeneration the environment's warm
// workspace (its locked manifest is the bundle's `lake-manifest.json`); it
// needs no authentication. Spec-1 records have no certificate: refused.

import fs from "node:fs";
import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import { isObject, normalizeSubmissionId } from "../shared/validation.js";
import { ArchiveSnapshot } from "../submission-validation/archive/snapshot.js";
import { readBundle, sealBundle } from "../submission-validation/certify/bundle.js";
import { CompositionError, composeRelativeCertificate, type StatementRef } from "../submission-validation/certify/compose.js";
import {
  BUNDLE_FILES,
  challengeText,
  certifiedProof,
  comparatorConfigText,
  conceptPackagesOf,
  lakefileText,
  manifestDependencies,
  orderedProofs,
  relativeCertificateFiles,
  solutionText,
  type BundleFile,
  type CertifiedProof,
  type CertifyPackage,
} from "../submission-validation/certify/generate.js";
import { kernelsOf } from "../submission-validation/certify/project.js";
import { interpretComparatorRun, type ComparatorVerdict } from "../submission-validation/certify/verdict.js";
import { submissionIdForPackage, type ArchiveSourceRecord, type ProofEntry } from "../submission-validation/contracts.js";
import { librariesOf, type ArchiveEnvironment } from "../submission-validation/environments.js";
import { lakeBinary, lakePathEnv, toolchainBinDir } from "../submission-validation/host/leanenv.js";
import { run } from "../submission-validation/host/proc.js";
import { manifestText, readWarmManifestPackages, warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { expandRecordedBuildOutput } from "../submission-validation/recorded-shape.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { toolVersion } from "./doctor.js";
import { groupFindings } from "./findings.js";
import { ensureCachedPaperBlob } from "./papers-cache.js";
import { selectProofTree, type NetworkProof } from "./prooftree.js";
import * as ui from "./ui.js";

export interface CertifyOptions {
  /** Statements assumed by a relative certificate (statement targets only). */
  relativeTo?: string[];
  /** The folder the bundle is written to; `certificate-<target>` under the
   * current directory when absent. */
  out?: string;
  /** Pull the record's stored bundle by digest instead of regenerating it. */
  fetch?: boolean;
  /** Run `lake comparator` over the written bundle. */
  run?: boolean;
  /** With --run: the toolchain's bundled external kernels too. */
  paranoid?: boolean;
}

/** Everything one draft or registered record contributes, read leniently
 * from the local copy (both specs; a spec-1 record is refused later, once
 * it is known to be the target or on the path). */
interface IndexedRecord {
  id: string;
  source: SourceLocation;
  environment?: ArchiveEnvironment;
  environmentId?: string;
  conceptsPackage: string;
  proofsPackage: string;
  statements: Map<string, StatementRef>;
  proofs: ProofEntry[];
  requiredByConcepts: string[];
  requiredByProofs: string[];
  certificate?: {
    toolchain: string;
    digest: string;
    registryBlob?: string;
    challenge: string;
  };
}

type Target =
  | { kind: "record"; record: IndexedRecord }
  | { kind: "proof"; record: IndexedRecord; proof: ProofEntry }
  | { kind: "statement"; record: IndexedRecord; statement: StatementRef };

/** The folder entries a certificate folder may already hold: a previous
 * write of the same bundle and the comparator's build tree. */
const REUSABLE_ENTRIES = new Set<string>([...BUNDLE_FILES, "lean-toolchain", ".lake"]);

export async function certify(targetInput: string, options: CertifyOptions = {}): Promise<number> {
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) {
    throw new Error(
      `there is no local copy of the archive at ${ui.tilde(database)} — run ${ui.cmd("lax sync")} first`,
    );
  }
  if (tryRefreshDatabase() === "failed") ui.verbose("the archive could not be refreshed; certifying from the existing copy");
  if (options.fetch === true && options.relativeTo !== undefined)
    throw new Error("--fetch pulls a record's stored bundle; a relative certificate is always composed here");

  const records = indexArchive(new ArchiveSnapshot(fs.realpathSync(database), "local"));
  const target = resolveTarget(targetInput, records);
  const environment = target.record.environment;
  if (environment === undefined) {
    throw new Error(
      `${target.record.id} was built in ${target.record.environmentId ?? "an unknown environment"}, which this CLI does not know — update lax`,
    );
  }
  if (environment.specVersion !== 2) {
    throw new Error(
      `certificates exist for spec-2 environments only; ${target.record.id} is in ${environment.id} (spec 1)`,
    );
  }
  if (options.relativeTo !== undefined && target.kind !== "statement")
    throw new Error("--relative-to applies to a statement target; a record or a proof is certified as recorded");
  if (options.fetch === true && target.kind !== "record")
    throw new Error("--fetch pulls a record's stored bundle; name the record (lax-N) to fetch it");

  const label = describeTarget(target, options.relativeTo ?? []);
  ui.title(`Certificate for ${label}`);
  const notes = new ui.Notes();
  const steps = new ui.Steps();
  steps.add("bundle", options.fetch === true ? "Fetching the bundle" : target.kind === "statement" ? "Composing the certificate" : "Regenerating the bundle");
  steps.add("write", "Writing the bundle");
  if (options.run === true) steps.add("run", "Running lake comparator");

  let verdict: ComparatorVerdict | undefined;
  let directory: string;
  try {
    const prepared =
      options.fetch === true
        ? await fetchStoredBundle(target.record)
        : target.kind === "statement"
          ? composeCertificate(target.record, target.statement, options.relativeTo ?? [], records, environment)
          : regenerateBundle(target, records, environment);
    steps.settle("bundle", { label: prepared.settled, detail: prepared.detail });
    for (const note of prepared.notes) notes.add(...note);

    directory = certificateFolder(options.out ?? `certificate-${targetInput}`);
    for (const name of BUNDLE_FILES) fs.writeFileSync(path.join(directory, name), prepared.files[name], { mode: 0o644 });
    fs.writeFileSync(path.join(directory, "lean-toolchain"), `${prepared.toolchain}\n`, { mode: 0o644 });
    steps.settle("write", { label: `Wrote ${ui.tilde(directory)}`, detail: "5 files + lean-toolchain" });

    if (options.run === true) {
      verdict = await runComparator(directory, environment, options.paranoid === true);
      if (verdict.kind === "certified") {
        steps.settle("run", {
          label: "Certified",
          detail: `${environment.leanToolchain} · kernels: ${kernelsOf(options.paranoid === true ? "paranoid" : "lean", environment).join(", ")}`,
        });
      } else {
        steps.settle("run", { status: "fail", label: verdict.kind === "violation" ? "Refused" : "Could not run" });
      }
    }
  } finally {
    steps.finish();
  }

  const command = `lake comparator --config comparator.json${options.paranoid === true ? " --paranoid" : ""}`;
  if (verdict === undefined) {
    ui.blank();
    ui.faint(`In ${ui.tilde(directory)}, with the ${environment.id} toolchain and git on PATH:`);
    ui.verdict(command);
    ui.faint(`or ${ui.cmd(`lax certify ${[targetInput, ...(options.relativeTo ?? []).flatMap((id) => ["--relative-to", id])].join(" ")} --run`)}`);
    notes.print();
    ui.done();
    return 0;
  }
  if (verdict.kind === "certified") {
    ui.verdict(`${label} is certified: ${command} accepted the Solution.`);
    notes.print();
    ui.done();
    return 0;
  }
  if (verdict.kind === "violation") {
    const group = groupFindings([{ phase: "certify", rule: verdict.rule, message: verdict.message }], "error")!;
    ui.problem(group.headline, group.body);
  } else {
    ui.problem("`lake comparator` did not run to a verdict", verdict.failure.message.split("\n"));
  }
  notes.print();
  ui.done();
  return 1;
}

interface PreparedBundle {
  files: Record<BundleFile, string>;
  toolchain: string;
  settled: string;
  detail: string;
  notes: Array<[string, ...string[]]>;
}

// ── the archive, as this command reads it ────────────────────────────────

function indexArchive(archive: ArchiveSnapshot): Map<string, IndexedRecord> {
  const records = new Map<string, IndexedRecord>();
  for (const record of archive.all()) {
    if ((record.state !== "draft" && record.state !== "registered") || record.source === undefined) continue;
    records.set(record.id, indexRecord(record, archive));
  }
  return records;
}

function indexRecord(record: ArchiveSourceRecord, archive: ArchiveSnapshot): IndexedRecord {
  const output = expandRecordedBuildOutput(record.buildOutput ?? {}, record.id);
  const concepts = Array.isArray(output.concepts) ? output.concepts : [];
  const statements = new Map<string, StatementRef>();
  for (const concept of concepts) {
    if (!isObject(concept) || !Array.isArray(concept.statements)) continue;
    for (const statement of concept.statements) {
      if (!isObject(statement) || typeof statement.id !== "string") continue;
      statements.set(statement.id, { id: statement.id, levelParams: stringList(statement.levelParams) });
    }
  }
  const proofs = (Array.isArray(output.proofs) ? output.proofs : []).filter(isObject) as unknown as ProofEntry[];
  const stored = isObject(output.certificate) ? output.certificate : undefined;
  const judge = stored !== undefined && isObject(stored.judge) ? stored.judge : undefined;
  const bundle = stored !== undefined && isObject(stored.bundle) ? stored.bundle : undefined;
  const certificate =
    stored !== undefined &&
    judge !== undefined &&
    bundle !== undefined &&
    typeof judge.toolchain === "string" &&
    typeof bundle.digest === "string" &&
    typeof stored.challenge === "string"
      ? {
          toolchain: judge.toolchain,
          digest: bundle.digest,
          ...(typeof bundle.registryBlob === "string" ? { registryBlob: bundle.registryBlob } : {}),
          challenge: stored.challenge,
        }
      : undefined;
  const number = record.id.slice("lax-".length);
  const environment = archive.environmentOf(record);
  return {
    id: record.id,
    source: record.source!,
    ...(environment === undefined ? {} : { environment }),
    ...(archive.environmentIdOf(record) === undefined ? {} : { environmentId: archive.environmentIdOf(record)! }),
    conceptsPackage: `Lax${number}`,
    proofsPackage: `Lax${number}Proofs`,
    statements,
    proofs,
    requiredByConcepts: stringList(output.requiredByConcepts),
    requiredByProofs: stringList(output.requiredByProofs),
    ...(certificate === undefined ? {} : { certificate }),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function resolveTarget(input: string, records: Map<string, IndexedRecord>): Target {
  if (/^(?:lax-|Lax)[0-9]+$/u.test(input)) {
    const id = normalizeSubmissionId(input);
    const record = records.get(id);
    if (record === undefined) throw new Error(`${id} has no draft or registered record in the local archive copy`);
    return { kind: "record", record };
  }
  for (const record of records.values()) {
    const proof = record.proofs.find((candidate) => candidate.id === input);
    if (proof !== undefined) return { kind: "proof", record, proof };
  }
  for (const record of records.values()) {
    const statement = record.statements.get(input);
    if (statement !== undefined) return { kind: "statement", record, statement };
  }
  throw new Error(
    `${input} is neither a record id (lax-N), a proof id, nor a statement id in the local archive copy — ` +
      `run ${ui.cmd("lax sync")} if the record is newer than the copy`,
  );
}

function describeTarget(target: Target, relativeTo: readonly string[]): string {
  switch (target.kind) {
    case "record":
      return target.record.id;
    case "proof":
      return target.proof.id;
    case "statement":
      return relativeTo.length === 0 ? target.statement.id : `${target.statement.id} relative to ${relativeTo.join(", ")}`;
  }
}

/** The record a package belongs to, by the package-name rule. */
function recordOfPackage(name: string, records: Map<string, IndexedRecord>): IndexedRecord {
  const id = submissionIdForPackage(name);
  const record = id === undefined ? undefined : records.get(id);
  if (record === undefined) throw new Error(`the package ${name} belongs to no draft or registered record in the local archive copy`);
  return record;
}

function gitSource(name: string, records: Map<string, IndexedRecord>): CertifyPackage {
  const record = recordOfPackage(name, records);
  const kind = name.endsWith("Proofs") ? "proofs" : "concepts";
  return {
    name,
    source: {
      git: record.source.repository,
      rev: record.source.commit,
      subDir: record.source.folder === "." ? kind : path.posix.join(record.source.folder, kind),
    },
  };
}

/** Every package reachable from `start` through the records' requires — a
 * proof package reaching its own concept package — sorted by name: the
 * closure a bundle's manifest lists (certify/project.ts closure). */
function packageClosure(start: readonly string[], records: Map<string, IndexedRecord>): string[] {
  const found = new Set<string>();
  const visit = (name: string): void => {
    if (found.has(name) || submissionIdForPackage(name) === undefined) return;
    found.add(name);
    const record = recordOfPackage(name, records);
    const proofs = name.endsWith("Proofs");
    for (const required of proofs ? record.requiredByProofs : record.requiredByConcepts) visit(required);
    if (proofs) visit(record.conceptsPackage);
  };
  start.forEach(visit);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function warmPackagesOf(environment: ArchiveEnvironment): Record<string, unknown>[] {
  const ws = warmDir(environment);
  if (!warmReady(ws)) {
    throw new Error(
      `the ${environment.id} workspace is not on this machine, and the bundle's lake-manifest.json is written from its ` +
        `locked manifest — run ${ui.cmd(`lax doctor --env ${environment.id}`)} first, or pass --fetch for the archive's stored bundle`,
    );
  }
  return readWarmManifestPackages(ws);
}

// ── a record's bundle, or one edge of it ─────────────────────────────────

function regenerateBundle(
  target: Target & { kind: "record" | "proof" },
  records: Map<string, IndexedRecord>,
  environment: ArchiveEnvironment,
): PreparedBundle {
  const { record } = target;
  if (record.proofs.length === 0) throw new Error(`${record.id} has no proofs, so the archive certified nothing for it: there is no bundle`);
  const all = orderedProofs(record.proofs.map(certifiedProof));
  const proofs = target.kind === "proof" ? all.filter((proof) => proof.id === target.proof.id) : all;
  const referenced = conceptPackagesOf(proofs).filter((name) => name !== record.conceptsPackage);
  for (const name of referenced) {
    if (!record.requiredByProofs.includes(name))
      throw new Error(`${record.id}'s proofs name statements of ${name}, which its proof package does not require — the archive's record is inconsistent; report it`);
  }
  const warm = warmPackagesOf(environment);
  const own = {
    concepts: gitSource(record.conceptsPackage, records),
    proofs: gitSource(record.proofsPackage, records),
  };
  const closure = packageClosure([...record.requiredByProofs, ...record.requiredByConcepts], records);
  const files: Record<BundleFile, string> = {
    "Challenge.lean": challengeText(proofs),
    "Solution.lean": solutionText(proofs),
    "comparator.json": comparatorConfigText(proofs),
    "lakefile.toml": lakefileText(
      librariesOf(environment),
      [own.concepts, ...referenced.map((name) => gitSource(name, records)), own.proofs],
      "bundle",
    ),
    "lake-manifest.json": manifestText(
      warm,
      manifestDependencies([own.concepts, own.proofs, ...closure.map((name) => gitSource(name, records))]),
    ),
  };
  const notes: PreparedBundle["notes"] = [];
  let detail = `${ui.plural(proofs.length, "edge")}`;
  if (target.kind === "record") {
    const stored = record.certificate;
    if (stored === undefined)
      throw new Error(`${record.id} has proofs but its record carries no certificate — the archive's record is inconsistent; report it`);
    if (stored.challenge !== files["Challenge.lean"]) {
      throw new Error(
        `the Challenge.lean regenerated from ${record.id}'s telescopes differs from the one its record stores — ` +
          "the archive's record is inconsistent; report it (lax -v prints both)" +
          (ui.isVerbose() ? `\n--- stored ---\n${stored.challenge}--- regenerated ---\n${files["Challenge.lean"]}` : ""),
      );
    }
    const sealed = sealBundle(files);
    if (sealed.digest === stored.digest) detail += ` · bundle ${stored.digest.slice(0, 12)}, the archive's`;
    else {
      detail += ` · bundle ${sealed.digest.slice(0, 12)}`;
      notes.push([
        `The regenerated bundle's digest is not the archive's (${stored.digest.slice(0, 12)}).`,
        "The Challenge is identical; the manifest or the lakefile differ, which a workspace built from",
        `another pin set explains. ${ui.cmd(`lax certify ${record.id} --fetch`)} writes the stored bundle itself.`,
      ]);
    }
  } else {
    detail += ` of ${record.id}`;
  }
  return {
    files,
    toolchain: record.certificate?.toolchain ?? environment.leanToolchain,
    settled: target.kind === "record" ? "Regenerated the bundle" : "Generated the edge's bundle",
    detail,
    notes,
  };
}

async function fetchStoredBundle(record: IndexedRecord): Promise<PreparedBundle> {
  const stored = record.certificate;
  if (stored === undefined) throw new Error(`${record.id} carries no certificate: nothing to fetch`);
  if (stored.registryBlob === undefined) throw new Error(`${record.id}'s certificate names no registry blob: nothing to fetch`);
  const file = await ensureCachedPaperBlob("certificate", stored.digest, stored.registryBlob);
  if (file === undefined) {
    throw new Error(
      `could not fetch ${record.id}'s bundle ${stored.digest.slice(0, 12)} from the registry, or its bytes did not hash to the ` +
        "recorded digest (lax -v says which); the regenerated bundle needs no fetch",
    );
  }
  const members = readBundle(fs.readFileSync(file));
  const names = [...members.keys()];
  if (names.length !== BUNDLE_FILES.length || BUNDLE_FILES.some((name) => !members.has(name)))
    throw new Error(`the fetched bundle holds ${names.join(", ") || "nothing"}, not the five certificate files`);
  const files = Object.fromEntries(BUNDLE_FILES.map((name) => [name, members.get(name)!])) as Record<BundleFile, string>;
  if (files["Challenge.lean"] !== stored.challenge)
    throw new Error(`the fetched bundle's Challenge.lean is not the one ${record.id}'s record stores — the archive's record is inconsistent; report it`);
  return {
    files,
    toolchain: stored.toolchain,
    settled: "Fetched the bundle",
    detail: `digest ${stored.digest.slice(0, 12)} verified`,
    notes: [],
  };
}

// ── a relative certificate ───────────────────────────────────────────────

function composeCertificate(
  record: IndexedRecord,
  statement: StatementRef,
  relativeTo: readonly string[],
  records: Map<string, IndexedRecord>,
  environment: ArchiveEnvironment,
): PreparedBundle {
  // the island: every record of the statement's environment (the proof
  // network never crosses environments)
  const island = [...records.values()].filter((candidate) => candidate.environment?.id === environment.id);
  const statements = new Map<string, StatementRef>();
  for (const member of island) for (const [id, ref] of member.statements) statements.set(id, ref);
  const given = [...new Set(relativeTo)].map((id) => {
    const ref = statements.get(id);
    if (ref === undefined) throw new Error(`${id} is not a statement of a ${environment.id} record in the local archive copy`);
    return ref;
  });
  const certified = new Map<string, CertifiedProof>();
  const network: NetworkProof[] = [];
  const givenIds = new Set(given.map((ref) => ref.id));
  for (const member of island) {
    for (const entry of member.proofs) {
      let proof: CertifiedProof;
      try {
        proof = certifiedProof(entry);
      } catch {
        continue; // a spec-1 shaped entry on a spec-2 island: not a proof this certificate can apply
      }
      certified.set(proof.id, proof);
      // a given statement is a hypothesis, never proven: its proofs are left out
      if (givenIds.has(proof.telescope.conclusion.statement)) continue;
      network.push({
        id: proof.id,
        submissionId: member.id,
        path: entry.path,
        conclusion: proof.telescope.conclusion.statement,
        assumptions: [...new Set(proof.telescope.hypotheses.map((hypothesis) => hypothesis.statement))].sort(),
      });
    }
  }
  for (const ref of given) {
    if (ref.id === statement.id) throw new Error(`${statement.id} is among the given statements; nothing is left to prove`);
    network.push({ id: `given:${ref.id}`, submissionId: "given", path: "", conclusion: ref.id, assumptions: [] });
  }
  const selection = selectProofTree([statement.id], statements.keys(), network);
  const witness = new Map<string, string>();
  for (const selected of selection.order) {
    if (selected.submissionId === "given") continue;
    witness.set(selected.conclusion, selected.id);
  }
  if (selection.unresolved.length > 0 || !witness.has(statement.id)) {
    const open = selection.unresolved.filter((id) => id !== statement.id);
    throw new Error(
      `${statement.id} is not proven${given.length === 0 ? "" : ` relative to ${given.map((ref) => ref.id).join(", ")}`} ` +
        `by the ${environment.id} proof network: ` +
        (open.length === 0 ? "no proof of it has every hypothesis proven" : `left open or cyclic: ${open.join(", ")}`) +
        ` (${ui.cmd(`lax generate-prooftree ${record.id}`)} reports the same leaves)`,
    );
  }
  let composed;
  try {
    composed = composeRelativeCertificate({ target: statement, given, proofs: certified, witness });
  } catch (error) {
    if (error instanceof CompositionError) throw new Error(`cannot compose the certificate: ${error.message}`);
    throw error;
  }
  const warm = warmPackagesOf(environment);
  const packages = [...composed.conceptPackages, ...composed.proofPackages];
  const closure = packageClosure(packages, records);
  const content = relativeCertificateFiles({
    theorem: composed.theorem,
    body: composed.body,
    conceptPackages: composed.conceptPackages,
    proofPackages: composed.proofPackages,
  });
  return {
    files: {
      ...content,
      "lakefile.toml": lakefileText(librariesOf(environment), packages.map((name) => gitSource(name, records)), "bundle"),
      "lake-manifest.json": manifestText(warm, manifestDependencies(closure.map((name) => gitSource(name, records)))),
    },
    toolchain: environment.leanToolchain,
    settled: "Composed the certificate",
    detail: `${composed.theorem.name} · ${ui.plural(composed.proofsUsed.length, "proof")} applied: ${composed.proofsUsed.join(", ")}`,
    notes: [],
  };
}

// ── the folder, and the comparator ───────────────────────────────────────

function certificateFolder(folder: string): string {
  const root = path.resolve(folder);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
    const foreign = fs.readdirSync(root).filter((entry) => !REUSABLE_ENTRIES.has(entry));
    if (foreign.length > 0)
      throw new Error(`folder ${root} holds ${foreign.join(", ")}; a certificate folder holds the bundle and its build tree alone — choose another --out`);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  return root;
}

/**
 * `lake comparator --config comparator.json [--paranoid]` in the folder, with
 * the environment's own lake and its bin dir first on PATH. The tool
 * sandboxes the build with bubblewrap and needs git on PATH to resolve the
 * bundle's git requires inside it; both are checked first so the refusal
 * names the tool rather than quoting the comparator's exit 2.
 */
async function runComparator(directory: string, environment: ArchiveEnvironment, paranoid: boolean): Promise<ComparatorVerdict> {
  if (!fs.existsSync(path.join(toolchainBinDir(environment), "lake")))
    throw new Error(`the ${environment.id} toolchain is not installed — run ${ui.cmd(`lax doctor --env ${environment.id}`)}`);
  const missing: string[] = [];
  if (toolVersion("git") === undefined) missing.push("git — `lake comparator` resolves the bundle's git requires inside its sandbox and needs git on PATH");
  if (toolVersion("bwrap") === undefined)
    missing.push("bwrap — `lake comparator` builds inside a bubblewrap sandbox, which is what makes the rerun trustworthy; install bubblewrap");
  if (missing.length > 0) throw new Error(`lax certify --run needs ${missing.length === 1 ? "a tool" : "tools"} it cannot find:\n${missing.join("\n")}`);
  const result = await run(
    lakeBinary(environment),
    ["comparator", "--config", "comparator.json", ...(paranoid ? ["--paranoid"] : [])],
    directory,
    { echo: ui.isVerbose(), env: { PATH: lakePathEnv(environment) }, maxOutputBytes: 16 * 1024 * 1024 },
  );
  if (/unknown (?:sub)?command/iu.test(result.output) && /comparator/u.test(result.output))
    throw new Error(`the toolchain ${environment.leanToolchain} has no \`lake comparator\`: ${result.output.trim()}`);
  return interpretComparatorRun(result);
}
