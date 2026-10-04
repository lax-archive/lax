// The trusted publisher's reading of a certificate bundle (codex review
// 2026-10-03, finding 2): the published tar is not "some bytes with the
// recorded digest" but the regeneration, from the record's own stored data,
// of the five files `lake comparator` judged — re-sealed and held to the tar
// byte for byte, and to `certificate.bundle.digest`. Credential-free, run
// before any token is minted (workflows/submission.ts readSuccessfulArtifacts).
//
// What is regenerated from what:
//   Challenge.lean, comparator.json                 the proofs' telescopes
//   lakefile.toml                                   the environment's library pins,
//                                                   the record's own source triple,
//                                                   the dependency records' triples
//                                                   (validated against the live
//                                                   database by validateDependencies)
//   lake-manifest.json                              the same packages, plus the warm
//                                                   workspace's locked closure
//   lean-toolchain                                  the environment's toolchain
//
// The warm closure — mathlib's own transitive dependencies at the revs its
// manifest pins — is the one input the publisher does not hold: it is read
// from the provisioned warm store by the validate job, and the publish job
// has no store. So that part of the manifest is taken from the tar and held
// to its shape (git entries of bounded form, unique names disjoint from the
// record's packages, the environment's every library present at its pinned
// url and commit) rather than regenerated. TODO (TODO.md): pin the warm
// manifest per environment in the table, then regenerate it too.

import type { SourceLocation } from "../../shared/types.js";
import { isObject, ValidationError } from "../../shared/validation.js";
import type { CertificateOutput, ProofEntry, ResolvedDependency } from "../contracts.js";
import { packageNameForSubmission } from "../contracts.js";
import type { ArchiveEnvironment } from "../environments.js";
import { librariesOf } from "../environments.js";
import { readBundle, sealBundle } from "./bundle.js";
import { RECORD_BUNDLE_FILES } from "./generate.js";
import { LeanNameError } from "./lean-name.js";
import { planCertificate } from "./project.js";

export interface BundleProvenance {
  /** The record's id, which names its two packages. */
  id: string;
  proofs: readonly ProofEntry[];
  source: SourceLocation;
  environment: ArchiveEnvironment;
  /** The validation report's dependency list: the whole resolved closure. */
  dependencies: readonly ResolvedDependency[];
  certificate: Pick<CertificateOutput, "bundle" | "challenge">;
}

const MAX_WARM_ENTRIES = 1_000;
const WARM_ENTRY_KEYS = new Set(["url", "type", "subDir", "scope", "rev", "name", "manifestFile", "inputRev", "inherited", "configFile"]);
const PACKAGE_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

function refuse(message: string): never {
  throw new ValidationError(`certificate bundle: ${message}`);
}

/**
 * Where a warm closure entry may point (fable review 2026-10-04, finding
 * 1.4): `https://github.com/…`, or the scheme and host of one of the
 * environment's own library pins — for a `file://` pin (the test seams'
 * fake mathlib), the pin's own directory. A reader's `lax certify --run`
 * fetches these packages, so the bundle must not be able to send them to a
 * repository of the author's.
 */
function admittedWarmUrl(url: string, environment: ArchiveEnvironment): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" && parsed.host === "github.com") return true;
  for (const library of librariesOf(environment)) {
    let pin: URL;
    try {
      pin = new URL(library.url());
    } catch {
      continue;
    }
    if (pin.protocol !== parsed.protocol || pin.host !== parsed.host) continue;
    if (pin.protocol !== "file:") return true;
    const directory = pin.pathname.slice(0, pin.pathname.lastIndexOf("/") + 1);
    if (parsed.pathname.startsWith(directory)) return true;
  }
  return false;
}

/** The warm closure entries at the tail of a bundle's manifest, held to
 * their shape and to the environment's pins. */
function warmEntries(manifestText: string, skip: number, environment: ArchiveEnvironment, taken: ReadonlySet<string>): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    refuse("lake-manifest.json is not JSON");
  }
  if (!isObject(parsed) || !Array.isArray(parsed.packages)) refuse("lake-manifest.json has no packages");
  if (parsed.packages.length < skip || parsed.packages.length - skip > MAX_WARM_ENTRIES) refuse("lake-manifest.json has an implausible number of packages");
  const warm = parsed.packages.slice(skip);
  const names = new Set<string>();
  for (const entry of warm) {
    if (!isObject(entry)) refuse("a warm manifest entry is not an object");
    for (const key of Object.keys(entry)) if (!WARM_ENTRY_KEYS.has(key)) refuse(`a warm manifest entry carries the key ${JSON.stringify(key)}`);
    if (entry.type !== "git") refuse("a warm manifest entry is not a git entry");
    if (typeof entry.name !== "string" || !PACKAGE_NAME.test(entry.name)) refuse("a warm manifest entry has no package name");
    if (names.has(entry.name) || taken.has(entry.name)) refuse(`the warm manifest entry ${entry.name} repeats a package`);
    names.add(entry.name);
    if (typeof entry.url !== "string" || entry.url.length > 512 || !/^[a-z]+:\/\/[^\s\u0000-\u001f]+$/u.test(entry.url))
      refuse(`the warm manifest entry ${entry.name} has no plausible url`);
    if (!admittedWarmUrl(entry.url, environment))
      refuse(`the warm manifest entry ${entry.name} is not at github.com nor beside the environment's library pins: ${entry.url}`);
    if (typeof entry.rev !== "string" || !/^[0-9a-f]{40}$/u.test(entry.rev)) refuse(`the warm manifest entry ${entry.name} has no commit`);
    if (entry.inputRev !== undefined && (typeof entry.inputRev !== "string" || entry.inputRev.length > 256)) refuse(`the warm manifest entry ${entry.name} has an implausible inputRev`);
    if (entry.subDir !== undefined && entry.subDir !== null && (typeof entry.subDir !== "string" || entry.subDir.length > 256)) refuse(`the warm manifest entry ${entry.name} has an implausible subDir`);
    for (const key of ["scope", "manifestFile", "configFile"] as const)
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || (entry[key] as string).length > 256)) refuse(`the warm manifest entry ${entry.name} has an implausible ${key}`);
    if (entry.inherited !== undefined && typeof entry.inherited !== "boolean") refuse(`the warm manifest entry ${entry.name} has an implausible inherited flag`);
  }
  for (const library of librariesOf(environment)) {
    const entry = warm.find((candidate) => isObject(candidate) && candidate.name === library.name) as Record<string, unknown> | undefined;
    if (entry === undefined) refuse(`the warm manifest lacks the environment's library ${library.name}`);
    if (entry.url !== library.url() || entry.rev !== library.commit) refuse(`the warm manifest pins ${library.name} elsewhere than the environment does`);
  }
  return warm as Record<string, unknown>[];
}

/**
 * Hold a published certificate bundle to the record it belongs to: the tar
 * must be, byte for byte, the sealing of the five files the generator writes
 * for the record's proofs, packages, and environment, and its digest the
 * recorded one. Throws a ValidationError naming the first disagreement.
 */
export function verifyCertificateBundle(tar: Buffer, input: BundleProvenance): void {
  let members: Map<string, string>;
  try {
    members = readBundle(tar);
  } catch (error) {
    refuse((error as Error).message);
  }
  const names = [...members.keys()];
  if (names.length !== RECORD_BUNDLE_FILES.length || names.some((name, index) => name !== RECORD_BUNDLE_FILES[index]))
    refuse(`the tar holds ${names.join(", ") || "nothing"}; a record's bundle holds exactly ${RECORD_BUNDLE_FILES.join(", ")}`);
  const ownConcepts = packageNameForSubmission(input.id);
  const ownProofs = `${ownConcepts}Proofs`;
  const dependencies = [...input.dependencies];
  const taken = new Set([ownConcepts, ownProofs, ...dependencies.map((dependency) => dependency.packageName)]);
  const warm = warmEntries(members.get("lake-manifest.json")!, taken.size, input.environment, taken);
  let plan;
  try {
    plan = planCertificate({
      proofs: input.proofs,
      ownConcepts,
      ownProofs,
      source: input.source,
      environment: input.environment,
      // the report's list is the whole closure; which of them are direct
      // requires the validate job judged, and the edges name only those
      resolution: { concepts: [], proofs: dependencies, all: dependencies },
      warmPackages: warm,
    });
  } catch (error) {
    if (error instanceof LeanNameError || error instanceof Error) refuse(`the record's proofs generate no bundle: ${(error as Error).message}`);
    throw error;
  }
  if (plan === undefined) refuse("the record has no proofs, so no bundle");
  for (const name of RECORD_BUNDLE_FILES) {
    if (members.get(name) !== plan.bundle[name]) refuse(`${name} is not the generator's regeneration from the record`);
  }
  if (input.certificate.challenge !== plan.bundle["Challenge.lean"]) refuse("the recorded Challenge is not the bundle's");
  const sealed = sealBundle(plan.bundle);
  if (!sealed.tar.equals(tar)) refuse("the tar is not the sealing of its own members");
  if (sealed.digest !== input.certificate.bundle.digest) refuse("the recorded bundle digest is not the regenerated bundle's");
}
