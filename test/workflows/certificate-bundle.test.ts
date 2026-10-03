// The publisher's reading of a certificate bundle (certify/verify-bundle.ts;
// codex review 2026-10-03, finding 2): the published tar must be the
// regeneration, from the record's own data, of the five files the judge
// judged — not merely some bytes with the recorded digest. The forgeries
// here are coherent: every digest is updated to match the swapped bytes, and
// a telescope is edited together with its regenerated Challenge.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundle, sealBundle, sealTar } from "../../src/submission-validation/certify/bundle.js";
import { planCertificate, type CertifyRecord } from "../../src/submission-validation/certify/project.js";
import { BUNDLE_FILES, challengeText, certifiedProof } from "../../src/submission-validation/certify/generate.js";
import { verifyCertificateBundle, type BundleProvenance } from "../../src/submission-validation/certify/verify-bundle.js";
import type { ProofEntry, ResolvedDependency } from "../../src/submission-validation/contracts.js";
import { environment as environmentById, librariesOf } from "../../src/submission-validation/environments.js";
import { spec2TestEnvironment, withTestEnvironments } from "../support/environments.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const SOURCE = { repository: "https://github.com/alice/infinite", commit: "1".repeat(40), folder: "." };

const DEPENDENCY: ResolvedDependency = {
  packageName: "Lax7",
  submissionId: "lax-7",
  kind: "concepts",
  source: { repository: "https://github.com/alice/primes", commit: "7".repeat(40), folder: "." },
  state: "registered",
  statements: ["Lax7.Primes.ExistsPrimeDivisor"],
  requiredPackages: [],
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

/** The warm closure as a store's manifest lists it: the libraries plus one
 * transitive dependency of mathlib's. */
function warmPackages(): Record<string, unknown>[] {
  const environment = environmentById("v4.35.0")!;
  const entry = (name: string, url: string, rev: string): Record<string, unknown> => ({
    url, type: "git", subDir: null, scope: "", rev, name, manifestFile: "lake-manifest.json", inputRev: rev, inherited: false, configFile: "lakefile.toml",
  });
  return [
    entry("batteries", "https://github.com/leanprover-community/batteries", "3".repeat(40)),
    ...librariesOf(environment).map((library) => entry(library.name, library.url(), library.commit)),
  ];
}

/** What the validate job's run produced for this record: the sealed bundle
 * and the certificate block that names it. */
function produced(proofs: ProofEntry[] = PROOFS, warm = warmPackages()): { tar: Buffer; provenance: BundleProvenance; record: CertifyRecord } {
  const environment = environmentById("v4.35.0")!;
  const record: CertifyRecord = {
    proofs,
    ownConcepts: "Lax1",
    ownProofs: "Lax1Proofs",
    source: SOURCE,
    environment,
    resolution: { concepts: [], proofs: [DEPENDENCY], all: [DEPENDENCY] },
    warmPackages: warm,
  };
  const plan = planCertificate(record)!;
  const sealed = sealBundle(plan.bundle);
  return {
    tar: sealed.tar,
    record,
    provenance: {
      id: "lax-1",
      proofs,
      source: SOURCE,
      environment,
      dependencies: [DEPENDENCY],
      certificate: { bundle: { formatVersion: 1, digest: sealed.digest }, challenge: plan.bundle["Challenge.lean"] },
    },
  };
}

describe("the publisher's reading of a certificate bundle", () => {
  it("accepts the bundle the generator and sealer produce for the record", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { tar, provenance } = produced();
      expect(() => verifyCertificateBundle(tar, provenance)).not.toThrow();
      // and the same bytes, read back from disk, as the publisher has them
      const file = path.join(temporary("lax-bundle-"), "certificate.tar");
      fs.writeFileSync(file, tar);
      expect(() => verifyCertificateBundle(fs.readFileSync(file), provenance)).not.toThrow();
    });
  });

  it("refuses an unrelated valid bundle swapped in with a consistent digest", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const genuine = produced();
      // another record's bundle: a different proof, sealed by the same sealer
      const other = produced([{ ...PROOFS[0]!, telescope: { hypotheses: [], conclusion: PROOFS[0]!.telescope!.conclusion }, assumptions: [] }]);
      expect(other.tar.equals(genuine.tar)).toBe(false);
      const forged: BundleProvenance = {
        ...genuine.provenance,
        certificate: { ...genuine.provenance.certificate, bundle: { formatVersion: 1, digest: other.provenance.certificate.bundle.digest } },
      };
      expect(() => verifyCertificateBundle(other.tar, forged)).toThrow("Challenge.lean is not the generator's regeneration");
      // arbitrary bytes with a matching digest are not a bundle at all
      const bytes = Buffer.alloc(10_240, 0x41);
      expect(() => verifyCertificateBundle(bytes, forged)).toThrow("certificate bundle:");
    });
  });

  it("refuses a telescope edited together with its regenerated Challenge: the bundle no longer matches", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const genuine = produced();
      const weakened: ProofEntry[] = [{ ...PROOFS[0]!, telescope: { hypotheses: [], conclusion: PROOFS[0]!.telescope!.conclusion }, assumptions: [] }];
      const regenerated = challengeText(weakened.map(certifiedProof));
      expect(regenerated).not.toBe(genuine.provenance.certificate.challenge);
      // the record now claims the weakened edge, with a Challenge that agrees
      // with it — the published tar still holds the real one
      expect(() => verifyCertificateBundle(genuine.tar, {
        ...genuine.provenance,
        proofs: weakened,
        certificate: { ...genuine.provenance.certificate, challenge: regenerated },
      })).toThrow("Challenge.lean is not the generator's regeneration");
      // and a bundle re-sealed for the weakened edge under the old digest
      const resealed = produced(weakened);
      expect(() => verifyCertificateBundle(resealed.tar, {
        ...genuine.provenance,
        proofs: weakened,
        certificate: { ...genuine.provenance.certificate, challenge: regenerated },
      })).toThrow("recorded bundle digest is not the regenerated bundle's");
    });
  });

  it("refuses a recorded Challenge that is not the bundle's", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { tar, provenance } = produced();
      expect(() => verifyCertificateBundle(tar, {
        ...provenance,
        certificate: { ...provenance.certificate, challenge: `${provenance.certificate.challenge}\n` },
      })).toThrow("recorded Challenge is not the bundle's");
    });
  });

  it("holds the lakefile to the record's own source and its dependencies' triples", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { tar, provenance } = produced();
      // (the manifest, which pins the same triples, is compared first)
      expect(() => verifyCertificateBundle(tar, { ...provenance, source: { ...SOURCE, commit: "2".repeat(40) } }))
        .toThrow("lake-manifest.json is not the generator's regeneration");
      expect(() => verifyCertificateBundle(tar, {
        ...provenance,
        dependencies: [{ ...DEPENDENCY, source: { ...DEPENDENCY.source, commit: "8".repeat(40) } }],
      })).toThrow("lake-manifest.json is not the generator's regeneration");
      // the lakefile alone: a bundle whose manifest agrees but whose lakefile does not
      const members = readBundle(tar);
      const edited = sealTar(BUNDLE_FILES.map((name) => ({
        name,
        content: Buffer.from(name === "lakefile.toml" ? members.get(name)!.replace('subDir = "concepts"', 'subDir = "elsewhere"') : members.get(name)!, "utf8"),
      })));
      expect(() => verifyCertificateBundle(edited.tar, {
        ...provenance,
        certificate: { ...provenance.certificate, bundle: { formatVersion: 1, digest: edited.digest } },
      })).toThrow("lakefile.toml is not the generator's regeneration");
      // a record whose edges name a package it does not depend on generates no bundle
      expect(() => verifyCertificateBundle(tar, { ...provenance, dependencies: [] }))
        .toThrow("the record's proofs generate no bundle");
    });
  });

  it("holds the warm closure in the manifest to its shape and to the environment's pins", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const environment = environmentById("v4.35.0")!;
      const warm = warmPackages();
      // the library at another commit than the row pins
      const repinned = warm.map((entry) => (entry.name === "LaxCore" ? { ...entry, rev: "9".repeat(40), inputRev: "9".repeat(40) } : entry));
      const forged = produced(PROOFS, repinned);
      expect(() => verifyCertificateBundle(forged.tar, forged.provenance)).toThrow("pins LaxCore elsewhere than the environment does");
      // a library missing from the closure
      const missing = produced(PROOFS, warm.filter((entry) => entry.name !== "mathlib"));
      expect(() => verifyCertificateBundle(missing.tar, missing.provenance)).toThrow("lacks the environment's library mathlib");
      // a path entry smuggled into the closure
      const pathEntry = produced(PROOFS, [...warm, { type: "path", name: "evil", dir: "/tmp/evil", scope: "", inherited: false, manifestFile: "lake-manifest.json", configFile: "lakefile.toml" }]);
      expect(() => verifyCertificateBundle(pathEntry.tar, pathEntry.provenance)).toThrow('carries the key "dir"');
      const pathTyped = produced(PROOFS, [...warm, { ...warm[0]!, name: "evil", type: "path" }]);
      expect(() => verifyCertificateBundle(pathTyped.tar, pathTyped.provenance)).toThrow("not a git entry");
      // an entry that repeats a dependency's name
      const shadow = produced(PROOFS, [...warm, { ...warm[0]!, name: "Lax7" }]);
      expect(() => verifyCertificateBundle(shadow.tar, shadow.provenance)).toThrow("repeats a package");
      // a rev that is not a commit
      const tag = produced(PROOFS, warm.map((entry) => (entry.name === "batteries" ? { ...entry, rev: "v4.35.0" } : entry)));
      expect(() => verifyCertificateBundle(tag.tar, tag.provenance)).toThrow("has no commit");
      expect(librariesOf(environment).map((library) => library.name)).toEqual(["mathlib", "LaxCore"]);
    });
  });

  it("refuses a tar with the wrong members or a damaged structure", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { tar, provenance } = produced();
      // a sixth member
      const extra = Buffer.concat([tar.subarray(0, tar.length - 10_240), tar.subarray(0, 1024), tar.subarray(tar.length - 10_240)]);
      expect(() => verifyCertificateBundle(extra, provenance)).toThrow("certificate bundle:");
      // a header byte flipped
      const damaged = Buffer.from(tar);
      damaged[1] = damaged[1]! ^ 0x01;
      expect(() => verifyCertificateBundle(damaged, provenance)).toThrow("header checksum");
    });
  });
});
