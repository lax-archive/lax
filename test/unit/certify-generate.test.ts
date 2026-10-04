// The certificate generator (axiomfree-plan.md, "Certify" 1; stage 3's
// goldens): a record bundle's four files for an unconditional proof, a conditional one
// with a duplicated hypothesis, a polymorphic one, handwritten names with
// keyword components and Lean's less common identifier characters, and a
// polymorphic proof of the spec-2 inspector golden exactly as the inspector
// reports it — compared byte for byte against test/fixtures/certify/<case>/.
// Regeneration from the recorded proof entries is deterministic by
// construction, and the generator writes only archive names.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readBundle, sealBundle, sealTar } from "../../src/submission-validation/certify/bundle.js";
import {
  RECORD_BUNDLE_FILES,
  bundleMembers,
  challengeText,
  comparatorConfigText,
  conceptPackagesOf,
  edgesOf,
  lakefileText,
  manifestDependencies,
  theoremNamesOf,
  universes,
  type CertifiedProof,
  type RecordBundle,
} from "../../src/submission-validation/certify/generate.js";
import { leanLevel, leanName, LeanNameError } from "../../src/submission-validation/certify/lean-name.js";
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
          { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] },
          { statement: "Lax261.Infinite.Auxiliary", levels: [] },
          { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] },
          { statement: "Lax261.Infinite.Auxiliary", levels: [] },
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
          { statement: "Lax38.Order.HasSucc", levels: [] },
          { statement: "Lax38.Order.Refl", levels: ["v"] },
        ],
        conclusion: { statement: "Lax38.Order.Both", levels: ["u", "v"] },
      },
    },
  ],
  escaping: [
    { id: "Lax7Proofs.theorem.good?", levelParams: ["fun"], telescope: { hypotheses: [{ statement: "Lax7.Facts.℘", levels: [] }], conclusion: { statement: "Lax7.Facts.α'", levels: ["fun"] } } },
  ],
  // the same shapes as the inspector itself reports them: the polymorphic
  // proof `polyProof.{w}` of the spec-2 golden fixture, taken from the real
  // report (test/fixtures/inspector-golden-spec2/expected.json), so the
  // generator's input is the inspector's output and not a handwritten guess
  // at it (the golden's proof lives beside its statement in one package,
  // which no record may do: the files are compared as text, never built)
  inspected: [inspectedProof("Spec2.Basic.polyProof")],
};

/** A proof of the spec-2 inspector golden as the validator would record it:
 * the declaration's canonical name, level parameters and telescope, with
 * every level a parameter name (the report's `["param", "λ"]`). */
function inspectedProof(name: string): CertifiedProof {
  const report = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "..", "inspector-golden-spec2", "expected.json"), "utf8"),
  ) as { declarations: Array<Record<string, any>> };
  const declaration = report.declarations.find((entry) => entry.name === name);
  if (declaration === undefined) throw new Error(`${name} is not in the spec-2 golden report`);
  const levels = (raw: Array<[string, string]>): string[] => raw.map((level) => {
    if (level[0] !== "param") throw new Error(`${name} has a level that is no parameter`);
    return level[1];
  });
  const telescope = declaration.telescope as {
    hypotheses: Array<{ const: string; levels: Array<[string, string]> }>;
    conclusion: { const: string; levels: Array<[string, string]> };
  };
  return {
    id: declaration.name as string,
    levelParams: declaration.levelParams as string[],
    telescope: {
      hypotheses: telescope.hypotheses.map((hypothesis) => ({ statement: hypothesis.const, levels: levels(hypothesis.levels) })),
      conclusion: { statement: telescope.conclusion.const, levels: levels(telescope.conclusion.levels) },
    },
  };
}

function generate(proofs: CertifiedProof[]): RecordBundle {
  const concepts = conceptPackagesOf(proofs);
  const packages = [
    ...concepts.map((name) => ({ name, source: { git: `https://github.com/alice/${name.toLowerCase()}`, rev: "c".repeat(40), subDir: "concepts" } })),
    { name: `${concepts[0]}Proofs`, source: { git: `https://github.com/alice/${concepts[0]!.toLowerCase()}`, rev: "c".repeat(40), subDir: "proofs" } },
  ];
  return {
    "Challenge.lean": challengeText(proofs),
    "comparator.json": comparatorConfigText(proofs),
    "lakefile.toml": lakefileText(LIBRARIES, packages, "record"),
    "lake-manifest.json": manifestText(WARM_PACKAGES, manifestDependencies(packages)),
  };
}

describe("the certificate generator", () => {
  for (const [name, proofs] of Object.entries(CASES)) {
    it(`writes the ${name} case as its golden files`, () => {
      const generated = generate(proofs);
      for (const file of RECORD_BUNDLE_FILES) {
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
    expect(comparatorConfigText(reversed)).toBe(comparatorConfigText(proofs));
    // each Challenge theorem is the proof's own name, and the solution module
    // the proof package's root (ultracode review C1)
    expect(theoremNamesOf(reversed)).toEqual(["Lax261Proofs.aux", "Lax261Proofs.euclid"]);
    expect(JSON.parse(comparatorConfigText(proofs))).toMatchObject({ challenge_module: "Challenge", solution_module: "Lax261Proofs" });
    // the Challenge imports exactly the concept packages the edges name
    expect(conceptPackagesOf(proofs)).toEqual(["Lax261", "Lax42"]);
    expect(challengeText(proofs)).not.toMatch(/^import .*Proofs/mu);
    // proofs of two packages have no one solution module
    expect(() => comparatorConfigText([...proofs, { ...CASES.unconditional![0]! }])).toThrow("one proof package");
    // the edges, derived: duplicates kept in binder order
    expect(edgesOf(proofs)[1]).toEqual({
      proof: "Lax261Proofs.euclid",
      hypotheses: ["Lax42.Primes.ExistsPrimeDivisor", "Lax261.Infinite.Auxiliary", "Lax42.Primes.ExistsPrimeDivisor", "Lax261.Infinite.Auxiliary"],
      conclusion: "Lax261.Infinite.InfinitelyManyPrimes",
    });
  });

  it("writes an archive name as recorded, quoting only a keyword component", () => {
    expect(leanName("Lax7.Facts.hasSucc")).toBe("Lax7.Facts.hasSucc");
    expect(leanName("Lax7.Facts.α'")).toBe("Lax7.Facts.α'");
    expect(leanName("Lax7.Facts.h₁")).toBe("Lax7.Facts.h₁");
    expect(leanName("Lax7.Facts._x!?")).toBe("Lax7.Facts._x!?");
    expect(leanName("Lax7.Facts.℘")).toBe("Lax7.Facts.℘");
    expect(leanName("Lax7.Facts.fun")).toBe("Lax7.Facts.«fun»");
    expect(leanName("fun")).toBe("«fun»");
    // `_` inside a name is an ordinary identifier character
    expect(leanName("Lax7._x._y_")).toBe("Lax7._x._y_");
  });

  it("writes a universe parameter always quoted, keyword or not", () => {
    // the token table is open (`forall`, `return`, Mathlib's `lemma`), so a
    // name standing alone is quoted whatever it is (ultracode review C3)
    expect(leanLevel("u")).toBe("«u»");
    expect(leanLevel("forall")).toBe("«forall»");
    expect(leanLevel("lemma")).toBe("«lemma»");
    expect(universes(["u", "return"])).toBe(".{«u», «return»}");
    for (const name of ["Lax7.u", "«u»", "_", ""]) expect(() => leanLevel(name), name).toThrow(LeanNameError);
  });

  it("refuses, naming it, a name outside the archive's grammar", () => {
    for (const name of [
      "Lax7.«x»", "Lax7.«定理»", "Lax7.定理", "Lax7.x»", "Lax7..x", "Lax7.1st", "Lax7.3", "_", "Lax7.λ",
      "Lax7.a b", "Lax7.a\nb", "Lax7.a\u0007", "",
    ]) {
      let caught: unknown;
      try {
        leanName(name);
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(LeanNameError);
      expect((caught as LeanNameError).leanName).toBe(name);
      expect((caught as Error).message).toContain(JSON.stringify(name));
    }
  });

  it("seals a record's four files into a ustar archive that reads back", () => {
    const files = generate(CASES.conditional!);
    const sealed = sealBundle(files);
    expect(sealed.tar.length % 10_240).toBe(0);
    expect(sealed.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealBundle(files).digest).toBe(sealed.digest);
    expect(Object.fromEntries(readBundle(sealed.tar))).toEqual(files);
    expect([...readBundle(sealed.tar).keys()]).toEqual([...RECORD_BUNDLE_FILES]);
    // a byte of difference is a different bundle
    expect(sealBundle({ ...files, "Challenge.lean": `${files["Challenge.lean"]}\n` }).digest).not.toBe(sealed.digest);
  });

  it("knows two bundle shapes, differing by the relative certificate's Solution.lean alone", () => {
    const files = generate(CASES.conditional!);
    const relative = { ...files, "Solution.lean": "-- solution\n" };
    expect(bundleMembers(relative).map((member) => member.name)).toEqual([
      "Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml",
    ]);
    expect([...readBundle(sealBundle(relative).tar).keys()]).toHaveLength(5);
    // any other set is neither shape
    const { ["comparator.json"]: _dropped, ...partial } = files;
    expect(() => bundleMembers(partial)).toThrow("a bundle holds");
    const { ["lakefile.toml"]: _lakefile, ...noLakefile } = relative;
    expect(() => bundleMembers(noLakefile)).toThrow("a bundle holds");
  });

  it("reads back only a well-formed archive: checksums, member types, unique names, termination, no trailing data", () => {
    const files = generate(CASES.conditional!);
    const { tar } = sealBundle(files);
    const mutate = (edit: (copy: Buffer) => Buffer | void): Buffer => {
      const copy = Buffer.from(tar);
      return edit(copy) ?? copy;
    };
    // a flipped content byte breaks nothing structural — the digest is what
    // catches it — but a header byte breaks the checksum
    expect(() => readBundle(mutate((copy) => { copy[0] = copy[0]! ^ 0x01; }))).toThrow("header checksum");
    // a member that is not a regular file: the type byte alone breaks the
    // checksum; with the checksum recomputed the type itself is refused
    expect(() => readBundle(mutate((copy) => { copy[156] = 0x32; }))).toThrow("header checksum");
    expect(() => readBundle(mutate((copy) => {
      copy[156] = 0x32;
      let sum = 0;
      for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : copy[index]!;
      Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(copy, 148);
    }))).toThrow("not a regular file");
    // the end-of-archive blocks cut off
    expect(() => readBundle(tar.subarray(0, tar.length - 10_240))).toThrow();
    // data after the end-of-archive blocks
    expect(() => readBundle(mutate((copy) => { copy[copy.length - 1] = 0x41; }))).toThrow("data after the end-of-archive blocks");
    // not blocked to the record size
    expect(() => readBundle(Buffer.concat([tar, Buffer.alloc(512)]))).toThrow("not blocked");
    // a duplicate member
    const twice = sealTar([
      { name: "Challenge.lean", content: Buffer.from("a") },
      { name: "Challenge.lean", content: Buffer.from("b") },
    ]);
    expect(() => readBundle(twice.tar)).toThrow("duplicate member");
    // an escaping name
    expect(() => readBundle(sealTar([{ name: "../x", content: Buffer.from("a") }]).tar)).toThrow("member name");
    expect(() => readBundle(sealTar([{ name: "/etc/x", content: Buffer.from("a") }]).tar)).toThrow("member name");
    // and the empty archive is fine: two zero blocks, blocked
    expect([...readBundle(sealTar([]).tar).keys()]).toEqual([]);
  });
});
