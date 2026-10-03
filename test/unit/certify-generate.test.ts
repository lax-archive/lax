// The certificate generator (axiomfree-plan.md, "Certify" 1; stage 3's
// goldens): the five files for an unconditional proof, a conditional one
// with every binder kind and a duplicated hypothesis, a polymorphic one, and
// a name Lean cannot read unbracketed — compared byte for byte against
// test/fixtures/certify/<case>/. Regeneration from the recorded proof entries
// is deterministic by construction, and the escaper is held to Lean's
// identifier grammar.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readBundle, sealBundle } from "../../src/submission-validation/certify/bundle.js";
import {
  BUNDLE_FILES,
  challengeText,
  comparatorConfigText,
  conceptPackagesOf,
  edgesOf,
  lakefileText,
  manifestDependencies,
  solutionText,
  theoremNamesOf,
  type BundleFile,
  type CertifiedProof,
} from "../../src/submission-validation/certify/generate.js";
import { isPlainIdentifier, leanName } from "../../src/submission-validation/certify/lean-name.js";
import { manifestText } from "../../src/submission-validation/host/warmstore.js";
import type { PinnedLibrary } from "../../src/submission-validation/environments.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "certify");

const LIBRARIES: readonly PinnedLibrary[] = [
  { name: "mathlib", url: () => "https://github.com/leanprover-community/mathlib4", commit: "a".repeat(40), required: true },
  { name: "LaxCore", url: () => "https://github.com/lax-archive/lax-core", commit: "b".repeat(40), required: true },
];

/** The warm closure as the store's locked manifest lists it, abridged. */
const WARM_PACKAGES = [
  { url: "https://github.com/lax-archive/lax-core", type: "git", subDir: null, scope: "", rev: "b".repeat(40), name: "LaxCore", manifestFile: "lake-manifest.json", inputRev: "b".repeat(40), inherited: false, configFile: "lakefile.toml" },
  { url: "https://github.com/leanprover-community/mathlib4", type: "git", subDir: null, scope: "", rev: "a".repeat(40), name: "mathlib", manifestFile: "lake-manifest.json", inputRev: "a".repeat(40), inherited: false, configFile: "lakefile.toml" },
];

const CASES: Record<string, CertifiedProof[]> = {
  unconditional: [
    { id: "Lax38Proofs.hasSucc", levelParams: [], telescope: { hypotheses: [], conclusion: { statement: "Lax38.Order.HasSucc", levels: [] } } },
  ],
  conditional: [
    {
      id: "Lax261Proofs.euclid",
      levelParams: [],
      telescope: {
        hypotheses: [
          { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [], binder: "default" },
          { statement: "Lax261.Infinite.Auxiliary", levels: [], binder: "implicit" },
          { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [], binder: "instImplicit" },
          { statement: "Lax261.Infinite.Auxiliary", levels: [], binder: "strictImplicit" },
        ],
        conclusion: { statement: "Lax261.Infinite.InfinitelyManyPrimes", levels: [] },
      },
    },
    { id: "Lax261Proofs.aux", levelParams: [], telescope: { hypotheses: [], conclusion: { statement: "Lax261.Infinite.Auxiliary", levels: [] } } },
  ],
  polymorphic: [
    {
      id: "Lax38Proofs.refl_of_hasSucc",
      levelParams: ["u", "v"],
      telescope: {
        hypotheses: [
          { statement: "Lax38.Order.HasSucc", levels: [], binder: "default" },
          { statement: "Lax38.Order.Refl", levels: ["v"], binder: "default" },
        ],
        conclusion: { statement: "Lax38.Order.Both", levels: ["u", "v"] },
      },
    },
  ],
  escaping: [
    { id: "Lax7Proofs.theorem.定理", levelParams: ["λ"], telescope: { hypotheses: [{ statement: "Lax7.Facts.fun", levels: [], binder: "default" }], conclusion: { statement: "Lax7.Facts.α'", levels: ["λ"] } } },
  ],
};

function generate(proofs: CertifiedProof[]): Record<BundleFile, string> {
  const concepts = conceptPackagesOf(proofs);
  const packages = [
    ...concepts.map((name) => ({ name, source: { git: `https://github.com/alice/${name.toLowerCase()}`, rev: "c".repeat(40), subDir: "concepts" } })),
    { name: `${concepts[0]}Proofs`, source: { git: `https://github.com/alice/${concepts[0]!.toLowerCase()}`, rev: "c".repeat(40), subDir: "proofs" } },
  ];
  return {
    "Challenge.lean": challengeText(proofs),
    "Solution.lean": solutionText(proofs),
    "comparator.json": comparatorConfigText(proofs),
    "lakefile.toml": lakefileText(LIBRARIES, packages, "bundle"),
    "lake-manifest.json": manifestText(WARM_PACKAGES, manifestDependencies(packages)),
  };
}

describe("the certificate generator", () => {
  for (const [name, proofs] of Object.entries(CASES)) {
    it(`writes the ${name} case as its golden files`, () => {
      const generated = generate(proofs);
      for (const file of BUNDLE_FILES) {
        const golden = path.join(FIXTURES, name, file);
        if (process.env.LAX_UPDATE_GOLDEN === "1") {
          fs.mkdirSync(path.dirname(golden), { recursive: true });
          fs.writeFileSync(golden, generated[file]);
        }
        expect(generated[file], `${name}/${file}`).toBe(fs.readFileSync(golden, "utf8"));
      }
    });
  }

  it("is deterministic and orders by id whatever order the proofs arrive in", () => {
    const proofs = CASES.conditional!;
    const reversed = [...proofs].reverse();
    expect(challengeText(reversed)).toBe(challengeText(proofs));
    expect(solutionText(reversed)).toBe(solutionText(proofs));
    expect(comparatorConfigText(reversed)).toBe(comparatorConfigText(proofs));
    expect(theoremNamesOf(reversed)).toEqual(["Cert.Lax261Proofs.aux", "Cert.Lax261Proofs.euclid"]);
    // the Challenge imports exactly the concept packages the edges name
    expect(conceptPackagesOf(proofs)).toEqual(["Lax261", "Lax42"]);
    expect(challengeText(proofs)).not.toMatch(/^import .*Proofs/mu);
    expect(solutionText(proofs)).toMatch(/^import Lax261Proofs$/mu);
    // the edges, derived: duplicates kept in binder order
    expect(edgesOf(proofs)[1]).toEqual({
      proof: "Lax261Proofs.euclid",
      theorem: "Cert.Lax261Proofs.euclid",
      hypotheses: ["Lax42.Primes.ExistsPrimeDivisor", "Lax261.Infinite.Auxiliary", "Lax42.Primes.ExistsPrimeDivisor", "Lax261.Infinite.Auxiliary"],
      conclusion: "Lax261.Infinite.InfinitelyManyPrimes",
    });
  });

  it("escapes every component Lean would not read back unbracketed, and nothing else", () => {
    expect(isPlainIdentifier("hasSucc")).toBe(true);
    expect(isPlainIdentifier("α'")).toBe(true);
    expect(isPlainIdentifier("h₁")).toBe(true);
    expect(isPlainIdentifier("_x!?")).toBe(true);
    expect(isPlainIdentifier("fun")).toBe(false);
    expect(isPlainIdentifier("theorem")).toBe(false);
    expect(isPlainIdentifier("定理")).toBe(false);
    expect(isPlainIdentifier("λ")).toBe(false);
    expect(isPlainIdentifier("1st")).toBe(false);
    expect(leanName("Lax7.Facts.fun")).toBe("Lax7.Facts.«fun»");
    expect(leanName("Lax7Proofs.theorem.定理")).toBe("Lax7Proofs.«theorem».«定理»");
    expect(leanName("Lax7.Facts.α'")).toBe("Lax7.Facts.α'");
    // a canonical name never carries brackets or spaces; one that does is a
    // programming error, never something to emit
    expect(() => leanName("Lax7.«x»")).toThrow("cannot emit");
    expect(() => leanName("Lax7..x")).toThrow("cannot emit");
    expect(() => leanName("")).toThrow("cannot emit");
  });

  it("seals the five files into a ustar archive that reads back", () => {
    const files = generate(CASES.conditional!);
    const sealed = sealBundle(files);
    expect(sealed.tar.length % 10_240).toBe(0);
    expect(sealed.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealBundle(files).digest).toBe(sealed.digest);
    expect(Object.fromEntries(readBundle(sealed.tar))).toEqual(files);
    // a byte of difference is a different bundle
    expect(sealBundle({ ...files, "Solution.lean": `${files["Solution.lean"]}\n` }).digest).not.toBe(sealed.digest);
  });
});
