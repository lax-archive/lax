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
// `selectProofTree` picks (certify/compose.ts). The bundle's files — a
// record's or a proof's five, a relative certificate's six, the two shapes
// differing by its `Solution.lean`; `lean-toolchain` among them — land in a
// folder; the command prints the `lake comparator` line a reader runs there
// by hand, or with --run checks the certificate itself (cli/certify-run.ts):
// in a fresh scratch project, from the records' verified captures and the
// environment's warm workspace, the Challenge and the solution module
// built and exported under bubblewrap, the Challenge held to the theorems
// the bundle states with the per-environment inspector, and the comparator
// handed both exports. `--inadvisably-no-sandbox` is for lax's own build
// and is not offered here, because this run is the reader's trustworthy
// rerun. Without the inspector it says the Challenge's meaning was not
// checked instead of "certified". The folder's own `.lake` — a by-hand
// run's — is never read: no host tool runs in a tree a sandbox could write.
//
// Needs the local archive copy, and for regeneration and for --run the
// environment's warm workspace (its locked manifest is the bundle's
// `lake-manifest.json`); --run also needs the registry for captures not yet
// cached. It needs no authentication. Spec-1 records have no certificate:
// refused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import { parsePublishedCapture } from "../submission-validation/artifact-schema.js";
import { isObject, normalizeSubmissionId } from "../shared/validation.js";
import { ArchiveSnapshot } from "../submission-validation/archive/snapshot.js";
import { readBundle, sealBundle } from "../submission-validation/certify/bundle.js";
import { CompositionError, composeRelativeCertificate, type StatementRef } from "../submission-validation/certify/compose.js";
import {
  BUNDLE_FILES,
  RECORD_BUNDLE_FILES,
  bundleMembers,
  challengeText,
  certifiedProof,
  comparatorConfigText,
  conceptPackagesOf,
  edgeTheorem,
  lakefileText,
  leanToolchainText,
  manifestDependencies,
  orderedProofs,
  relativeCertificateFiles,
  type Bundle,
  type CertificateTheorem,
  type CertifiedProof,
  type CertifyPackage,
  type RecordBundle,
} from "../submission-validation/certify/generate.js";
import { kernelsOf } from "../submission-validation/certify/project.js";
import type { ComparatorVerdict } from "../submission-validation/certify/verdict.js";
import { submissionIdForPackage, type ArchiveSourceRecord, type ProofEntry, type PublishedCapture } from "../submission-validation/contracts.js";
import { librariesOf, type ArchiveEnvironment } from "../submission-validation/environments.js";
import { toolchainBinDir } from "../submission-validation/host/leanenv.js";
import { manifestText, readWarmManifestPackages, warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { expandRecordedBuildOutput } from "../submission-validation/recorded-shape.js";
import { materializeCapture } from "./capture-cache.js";
import {
  buildSolutionInSandbox,
  holdChallengeInSandbox,
  judgeExports,
  prepareRunProject,
  readBundleManifest,
  type ChallengeHold,
  type RecordPackageSource,
} from "./certify-run.js";
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
  /** The record's published capture, whose sources --run builds. */
  capture?: PublishedCapture;
  certificate?: {
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
 * write of a bundle, and the build tree a by-hand `lake comparator` left
 * (never read by lax). */
const REUSABLE_ENTRIES = new Set<string>([...BUNDLE_FILES, ".lake"]);

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
  if (options.run === true) {
    steps.add("sources", "Taking the packages from the archive");
    steps.add("hold", "Holding the Challenge to the edges");
    steps.add("run", "Judging the solution module");
  }

  let verdict: ComparatorVerdict | undefined;
  let hold: ChallengeHold | undefined;
  let directory: string;
  try {
    const prepared =
      options.fetch === true
        ? await fetchStoredBundle(target.record, environment)
        : target.kind === "statement"
          ? composeCertificate(target.record, target.statement, options.relativeTo ?? [], records, environment)
          : regenerateBundle(target, records, environment);
    steps.settle("bundle", { label: prepared.settled, detail: prepared.detail });
    for (const note of prepared.notes) notes.add(...note);

    directory = certificateFolder(options.out ?? `certificate-${targetInput}`);
    const members = bundleMembers(prepared.files);
    // a reused folder may hold the other shape's Solution.lean: gone, so the
    // folder is exactly this bundle
    for (const name of BUNDLE_FILES)
      if (!members.some((member) => member.name === name)) fs.rmSync(path.join(directory, name), { force: true });
    for (const { name, content } of members) fs.writeFileSync(path.join(directory, name), content, { mode: 0o644 });
    steps.settle("write", { label: `Wrote ${ui.tilde(directory)}`, detail: `${members.length} files` });

    if (options.run === true) {
      requireRunTools(environment);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lax-certify-"));
      try {
        const sources = await recordSources(prepared.files["lake-manifest.json"], records, (id) => steps.detail("sources", `downloading ${id}'s capture`));
        const project = prepareRunProject({ scratch, environment, files: prepared.files, sources });
        steps.settle("sources", {
          label: "Packages from the archive",
          detail: `${ui.plural(sources.size, "record package")} from verified captures, built from source · libraries from the ${environment.id} workspace`,
        });
        const run = { project, environment, theorems: prepared.theorems, scratch, echo: ui.isVerbose() };
        hold = await holdChallengeInSandbox({ ...run, onDetail: (text) => steps.detail("hold", text) });
        if (hold.kind === "held") {
          steps.settle("hold", {
            label: "Challenge states the edges",
            detail: `${ui.plural(prepared.theorems.length, "theorem")} read by the ${environment.id} inspector`,
          });
        } else if (hold.kind === "unchecked") {
          steps.settle("hold", { status: "warn", label: "Challenge meaning not checked", detail: "no inspector" });
          notes.add(
            "The Challenge's theorems were not read back against the edges the bundle states, so a global",
            "macro in a concept package could have changed what they say before the comparator judged them:",
            `${hold.reason}`,
          );
        } else {
          verdict = hold.verdict;
          steps.settle("hold", { status: "fail", label: verdict.kind === "violation" ? "Refused" : "Could not run" });
          steps.settle("run", { hidden: true });
        }
        if (hold.kind !== "refused") {
          const solution = await buildSolutionInSandbox({ ...run, onDetail: (text) => steps.detail("run", text) }, solutionModuleOf(prepared.files));
          if (solution.kind === "refused") {
            verdict = solution.verdict;
          } else {
            steps.detail("run", "lake comparator");
            const ran = await judgeExports({
              scratch,
              environment,
              files: prepared.files,
              challengeExport: hold.challengeExport,
              solutionExport: solution.solutionExport,
              paranoid: options.paranoid === true,
              echo: ui.isVerbose(),
            });
            verdict = ran.verdict;
            if (verdict.kind === "certified") {
              steps.settle("run", {
                label: hold.kind === "held" ? "Certified" : "Comparator accepted",
                detail:
                  // the kernels the transcript says accepted, not the flag's promise
                  `${environment.leanToolchain} · kernels: ${(ran.kernels.length > 0 ? ran.kernels : kernelsOf(options.paranoid === true ? "paranoid" : "lean", environment)).join(", ")}` +
                  " · against the two exports built above",
              });
            }
          }
          if (verdict.kind !== "certified") steps.settle("run", { status: "fail", label: verdict.kind === "violation" ? "Refused" : "Could not run" });
        }
      } finally {
        removeScratch(scratch);
      }
    }
  } finally {
    steps.finish();
  }

  const command = `lake comparator --config comparator.json${options.paranoid === true ? " --paranoid" : ""}`;
  if (verdict === undefined) {
    ui.blank();
    ui.faint(`In ${ui.tilde(directory)}, with elan and git on PATH (the bundle's lean-toolchain names ${environment.leanToolchain}):`);
    ui.verdict(command);
    ui.faint(`or ${ui.cmd(`lax certify ${[targetInput, ...(options.relativeTo ?? []).flatMap((id) => ["--relative-to", id])].join(" ")} --run`)}`);
    ui.faint("the bare comparator clones the records' packages from their authors' repositories and does not check what");
    ui.faint("the Challenge means; --run builds them from the archive's captures and holds the Challenge to the statements");
    notes.print();
    ui.done();
    return 0;
  }
  if (verdict.kind === "certified") {
    ui.verdict(
      hold?.kind === "held"
        ? `${label} is certified: ${command} accepted it, against a Challenge that states the edges.`
        : `${label}: comparator accepted; Challenge meaning not checked.`,
    );
    notes.print();
    ui.done();
    return 0;
  }
  if (verdict.kind === "violation") {
    const group = groupFindings([{ phase: "certify", rule: verdict.rule, message: verdict.message, intent: verdict.intent }], "error")!;
    ui.problem(group.headline, group.body);
  } else {
    ui.problem(
      hold?.kind === "refused" ? "the Challenge could not be held to the edges" : "the certificate could not be judged",
      verdict.failure.message.split("\n"),
    );
  }
  notes.print();
  ui.done();
  return 1;
}

interface PreparedBundle {
  files: Bundle;
  /** What the Challenge states: the theorems the bundle was generated from,
   * which --run holds the built Challenge to. */
  theorems: CertificateTheorem[];
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
  const bundle = stored !== undefined && isObject(stored.bundle) ? stored.bundle : undefined;
  const certificate =
    stored !== undefined &&
    bundle !== undefined &&
    typeof bundle.digest === "string" &&
    typeof stored.challenge === "string"
      ? {
          digest: bundle.digest,
          ...(typeof bundle.registryBlob === "string" ? { registryBlob: bundle.registryBlob } : {}),
          challenge: stored.challenge,
        }
      : undefined;
  let capture: PublishedCapture | undefined;
  try {
    capture = parsePublishedCapture(output.capture);
  } catch {
    capture = undefined; // read leniently: only --run needs it, and says so
  }
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
    ...(capture === undefined ? {} : { capture }),
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
  const files: RecordBundle = {
    "Challenge.lean": challengeText(proofs),
    "comparator.json": comparatorConfigText(proofs),
    "lakefile.toml": lakefileText(
      librariesOf(environment),
      [own.concepts, ...referenced.map((name) => gitSource(name, records)), own.proofs],
      "record",
    ),
    "lake-manifest.json": manifestText(
      warm,
      manifestDependencies([own.concepts, own.proofs, ...closure.map((name) => gitSource(name, records))]),
    ),
    "lean-toolchain": leanToolchainText(environment),
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
    theorems: proofs.map(edgeTheorem),
    settled: target.kind === "record" ? "Regenerated the bundle" : "Generated the edge's bundle",
    detail,
    notes,
  };
}

async function fetchStoredBundle(record: IndexedRecord, environment: ArchiveEnvironment): Promise<PreparedBundle> {
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
  if (names.length !== RECORD_BUNDLE_FILES.length || RECORD_BUNDLE_FILES.some((name) => !members.has(name)))
    throw new Error(`the fetched bundle holds ${names.join(", ") || "nothing"}, not a record's five certificate files`);
  const files = Object.fromEntries(RECORD_BUNDLE_FILES.map((name) => [name, members.get(name)!])) as RecordBundle;
  if (files["Challenge.lean"] !== stored.challenge)
    throw new Error(`the fetched bundle's Challenge.lean is not the one ${record.id}'s record stores — the archive's record is inconsistent; report it`);
  if (files["lean-toolchain"] !== leanToolchainText(environment))
    throw new Error(`the fetched bundle's lean-toolchain is not ${environment.id}'s ${environment.leanToolchain} — the archive's record is inconsistent; report it`);
  return {
    files,
    // the fetched Challenge is the record's stored one, which the publisher
    // held to the record's own proofs
    theorems: orderedProofs(record.proofs.map(certifiedProof)).map(edgeTheorem),
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
      "lakefile.toml": lakefileText(librariesOf(environment), packages.map((name) => gitSource(name, records)), "relative"),
      "lake-manifest.json": manifestText(warm, manifestDependencies(closure.map((name) => gitSource(name, records)))),
      "lean-toolchain": leanToolchainText(environment),
    },
    theorems: [composed.theorem],
    settled: "Composed the certificate",
    detail: `${composed.theorem.name} · ${ui.plural(composed.proofsUsed.length, "proof")} applied: ${composed.proofsUsed.join(", ")}`,
    notes: [],
  };
}

// ── the folder, and the run ──────────────────────────────────────────────

/**
 * The source tree of every record package the bundle's manifest lists:
 * the record's published capture, verified (cli/capture-cache.ts), at the
 * package's own root inside it — and the commit the record names, which the
 * capture must be of and the manifest must pin (cli/certify-run.ts
 * prepareRunProject). A package of no record is the environment's, and is
 * left to the warm workspace.
 */
async function recordSources(
  manifest: string,
  records: Map<string, IndexedRecord>,
  announce: (id: string) => void,
): Promise<Map<string, RecordPackageSource>> {
  const sources = new Map<string, RecordPackageSource>();
  const roots = new Map<string, string>();
  for (const entry of readBundleManifest(manifest)) {
    if (submissionIdForPackage(entry.name) === undefined) continue;
    const record = recordOfPackage(entry.name, records);
    const capture = record.capture;
    if (capture === undefined || capture.registryBlob === undefined)
      throw new Error(`${record.id}'s record carries no published capture to take ${entry.name}'s sources from — the archive's record is inconsistent; report it`);
    if (capture.sourceCommit !== record.source.commit)
      throw new Error(`${record.id}'s capture is of ${capture.sourceCommit}, its record of ${record.source.commit} — the archive's record is inconsistent; report it`);
    let root = roots.get(record.id);
    if (root === undefined) {
      try {
        root = await materializeCapture(record.id, capture, () => announce(record.id));
      } catch (error) {
        throw new Error(`could not take ${record.id}'s capture ${capture.digest.slice(0, 12)} from the registry: ${(error as Error).message}`);
      }
      roots.set(record.id, root);
    }
    const dir = path.join(root, entry.name.endsWith("Proofs") ? "proofs" : "concepts", "package");
    if (!fs.existsSync(dir)) throw new Error(`${record.id}'s capture holds no ${entry.name} package`);
    sources.set(entry.name, { dir, rev: record.source.commit });
  }
  return sources;
}

/** The bundle's solution module, from its `comparator.json`: a record's
 * proof package root, or a relative certificate's `Solution`. */
function solutionModuleOf(files: Bundle): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(files["comparator.json"]);
  } catch {
    throw new Error("the bundle's comparator.json is not JSON");
  }
  const module = isObject(parsed) ? parsed.solution_module : undefined;
  if (typeof module !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(module))
    throw new Error(`the bundle's comparator.json names no solution module lax can build: ${JSON.stringify(module)}`);
  return module;
}

/** Remove a run's scratch folder. A build inside it may have left a
 * directory unwritable; reopen directories (never through a link) and try
 * again, and say so rather than fail the verdict when that is not enough. */
function removeScratch(scratch: string): void {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
    return;
  } catch {
    // reopened below
  }
  const reopen = (directory: string): void => {
    try {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink()) reopen(path.join(directory, entry.name));
    } catch {
      // best effort
    }
  };
  reopen(scratch);
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    ui.verbose(`could not remove ${scratch}: ${(error as Error).message}`);
  }
}

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

/** What --run needs before anything runs: the environment's toolchain, and
 * bubblewrap on PATH — every build and export runs under it
 * (cli/certify-run.ts), and so do the comparator's kernels. git is not
 * needed: nothing is cloned, and the comparator's probe for it finds a
 * refusing shim. Checked first so the refusal names the tool rather than
 * quoting a sandbox's failure. */
function requireRunTools(environment: ArchiveEnvironment): void {
  if (!fs.existsSync(path.join(toolchainBinDir(environment), "lake")))
    throw new Error(`the ${environment.id} toolchain is not installed — run ${ui.cmd(`lax doctor --env ${environment.id}`)}`);
  if (toolVersion("bwrap") === undefined)
    throw new Error(
      "lax certify --run needs a tool it cannot find:\n" +
        "bwrap — every build, export and kernel of the run is confined by bubblewrap, which is what makes the rerun trustworthy; install bubblewrap",
    );
}
