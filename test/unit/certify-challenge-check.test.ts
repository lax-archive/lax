// The Challenge held to the telescope (certify/challenge-check.ts): the
// inspector's reading of the built Challenge against the record's edges,
// structured on both sides. The macro case the namespace review ran — a
// global `macro_rules` for `theorem` turning `Cert.p : 1 = 2` into
// `Cert.p : True` with both exports agreeing — is the first mismatch below;
// the rest are every other way the built theorem could differ from the edge.

import { describe, expect, it } from "vitest";
import { checkChallengeReport } from "../../src/submission-validation/certify/challenge-check.js";
import { certifiedProof, edgeTheorem, type CertificateTheorem } from "../../src/submission-validation/certify/generate.js";
import type { InspectorDeclaration, InspectorReport, ProofEntry } from "../../src/submission-validation/contracts.js";

const EDGE: ProofEntry = {
  id: "Lax1Proofs.euclid",
  path: "proofs/Lax1Proofs/Basic.lean",
  levelParams: ["u"],
  telescope: {
    hypotheses: [
      { statement: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
      { statement: "Lax1.Infinite.Poly", levels: ["u"] },
    ],
    conclusion: { statement: "Lax1.Infinite.InfinitelyManyPrimes", levels: ["u"] },
  },
  conclusion: "Lax1.Infinite.InfinitelyManyPrimes",
  assumptions: ["Lax1.Infinite.Poly", "Lax7.Primes.ExistsPrimeDivisor"],
  description: "",
};

/** What the Challenge must state for proof entries: their edges. */
function edges(...proofs: ProofEntry[]): CertificateTheorem[] {
  return proofs.map((proof) => edgeTheorem(certifiedProof(proof)));
}

/** The built theorem exactly as the edge states it. */
function built(overrides: Partial<InspectorDeclaration> = {}): InspectorDeclaration {
  return {
    name: "Lax1Proofs.euclid",
    kind: "theorem",
    module: "Challenge",
    axioms: ["sorryAx"],
    usedConstants: [],
    userName: "Lax1Proofs.euclid",
    origin: { kind: "authored" },
    laxStatement: false,
    isProp: false,
    levelParams: ["u"],
    telescope: {
      hypotheses: [
        { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
        { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
      ],
      conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]] },
    },
    ...overrides,
  };
}

function report(...declarations: InspectorDeclaration[]): InspectorReport {
  return {
    modules: [{ name: "Challenge", imports: ["Lax1", "Lax7"], moduleDocs: [], declCount: declarations.length, globalSyntax: [] }],
    declarations,
  };
}

describe("the Challenge held to the telescope", () => {
  it("accepts a built theorem that states exactly the recorded edge", () => {
    expect(checkChallengeReport(report(built()), edges(EDGE))).toBeUndefined();
  });

  it("ignores declarations of other modules and keeps the first of a name", () => {
    const elsewhere = built({ module: "Lax1.Infinite", telescope: null });
    expect(checkChallengeReport(report(elsewhere, built()), edges(EDGE))).toBeUndefined();
  });

  const cases: Array<[string, InspectorDeclaration, string]> = [
    [
      "a rewritten conclusion (the global macro_rules case)",
      built({ telescope: { hypotheses: [], conclusion: { const: "True", levels: [] } } }),
      "elaborated to {} → True in the built Challenge (0 hypotheses where the record has 2)",
    ],
    ["a type that is not a chain", built({ telescope: null }), "is not a chain of statements"],
    ["a definition where a theorem was stated", built({ kind: "def" }), "is a def, not a theorem"],
    ["a non-canonical name", built({ nonCanonical: true }), "is not a canonical name"],
    ["other universe parameters", built({ levelParams: ["u", "v"] }), "has universe parameters {u, v}"],
    [
      "a hypothesis naming another statement",
      built({
        telescope: {
          hypotheses: [
            { const: "Lax7.Primes.Other", levels: [] },
            { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
          ],
          conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]] },
        },
      }),
      "hypothesis 1 is Lax7.Primes.Other, not Lax7.Primes.ExistsPrimeDivisor",
    ],
    [
      "a conclusion whose printed name is the recorded one but does not read back",
      built({
        telescope: {
          hypotheses: [
            { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
            { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
          ],
          conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]], nonCanonical: true },
        },
      }),
      "the conclusion is a constant printed Lax1.Infinite.InfinitelyManyPrimes that is not that name, not Lax1.Infinite.InfinitelyManyPrimes",
    ],
    [
      "hypotheses in another order",
      built({
        telescope: {
          hypotheses: [
            { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
            { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
          ],
          conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]] },
        },
      }),
      "hypothesis 1 is Lax1.Infinite.Poly, not Lax7.Primes.ExistsPrimeDivisor",
    ],
    [
      "a hypothesis at a concrete universe",
      built({
        telescope: {
          hypotheses: [
            { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
            { const: "Lax1.Infinite.Poly", levels: [["succ", ["zero"]]] },
          ],
          conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]] },
        },
      }),
      "hypothesis 2 instantiates Lax1.Infinite.Poly at {0+1}, not {u}",
    ],
    [
      "another conclusion",
      built({
        telescope: {
          hypotheses: [
            { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
            { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
          ],
          conclusion: { const: "Lax1.Infinite.Weaker", levels: [["param", "u"]] },
        },
      }),
      "the conclusion is Lax1.Infinite.Weaker, not Lax1.Infinite.InfinitelyManyPrimes",
    ],
    [
      "the conclusion at another universe variable",
      built({
        levelParams: ["u"],
        telescope: {
          hypotheses: [
            { const: "Lax7.Primes.ExistsPrimeDivisor", levels: [] },
            { const: "Lax1.Infinite.Poly", levels: [["param", "u"]] },
          ],
          conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "v"]] },
        },
      }),
      "the conclusion instantiates Lax1.Infinite.InfinitelyManyPrimes at {v}, not {u}",
    ],
  ];
  for (const [name, declaration, detail] of cases) {
    it(`refuses ${name}`, () => {
      const result = checkChallengeReport(report(declaration), edges(EDGE));
      expect(result).toMatchObject({ kind: "violation", intent: "translation", rule: "challenge-mismatch" });
      expect(result!.message).toContain("Lax1Proofs.euclid states the edge {Lax7.Primes.ExistsPrimeDivisor, Lax1.Infinite.Poly.{u}} → Lax1.Infinite.InfinitelyManyPrimes.{u}.{u} by the archive's records but");
      expect(result!.message).toContain(detail);
    });
  }

  it("refuses a Challenge that does not declare the theorem at all", () => {
    const result = checkChallengeReport(report(), edges(EDGE));
    expect(result).toMatchObject({ kind: "violation", rule: "challenge-mismatch" });
    expect(result!.message).toContain("is not declared in the built Challenge");
  });

  it("checks every edge, in id order, and reports the first disagreement", () => {
    const second: ProofEntry = { ...EDGE, id: "Lax1Proofs.another", conclusion: "Lax1.Infinite.InfinitelyManyPrimes" };
    const result = checkChallengeReport(report(built()), edges(EDGE, second));
    expect(result!.message).toContain("Lax1Proofs.another states the edge");
  });

  // a reader's relative certificate (cli/certify-run.ts): one implied edge
  // under `Cert.<statement-id>`, held the same way
  it("holds a relative certificate's one theorem to its implied edge", () => {
    const relative: CertificateTheorem = {
      name: "Cert.Lax1.Infinite.InfinitelyManyPrimes",
      levelParams: ["u"],
      telescope: {
        hypotheses: [{ statement: "Lax1.Infinite.Poly", levels: ["u"] }],
        conclusion: { statement: "Lax1.Infinite.InfinitelyManyPrimes", levels: ["u"] },
      },
    };
    const stated = built({
      name: relative.name,
      userName: relative.name,
      telescope: {
        hypotheses: [{ const: "Lax1.Infinite.Poly", levels: [["param", "u"]] }],
        conclusion: { const: "Lax1.Infinite.InfinitelyManyPrimes", levels: [["param", "u"]] },
      },
    });
    expect(checkChallengeReport(report(stated), [relative])).toBeUndefined();
    const rewritten = built({ name: relative.name, userName: relative.name, telescope: { hypotheses: [], conclusion: { const: "True", levels: [] } } });
    const result = checkChallengeReport(report(rewritten), [relative]);
    expect(result).toMatchObject({ kind: "violation", intent: "translation", rule: "challenge-mismatch" });
    expect(result!.message).toContain(
      "Cert.Lax1.Infinite.InfinitelyManyPrimes states the edge {Lax1.Infinite.Poly.{u}} → Lax1.Infinite.InfinitelyManyPrimes.{u}.{u} by the archive's records but elaborated to {} → True",
    );
  });
});
