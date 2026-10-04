import { describe, expect, it } from "vitest";
import { groupFindings, phaseLabel } from "../../src/cli/findings.js";

describe("local validation reporting", () => {
  it("groups findings once, under the author's nouns for each phase", () => {
    const duplicate = { phase: "static" as const, rule: "manifest", message: "title is missing" };
    expect(
      groupFindings(
        [
          duplicate,
          duplicate,
          { phase: "static", rule: "license", message: "LICENSE is missing" },
          { phase: "resolution", rule: "dependency", message: "Lax2 is unavailable" },
        ],
        "error",
      ),
    ).toEqual({
      headline: "3 errors",
      body: [
        "layout · manifest",
        "  title is missing",
        "layout · license",
        "  LICENSE is missing",
        "dependencies · dependency",
        "  Lax2 is unavailable",
      ],
    });
  });

  it("keeps a transcript's lines, indented under its rule", () => {
    expect(
      groupFindings(
        [
          {
            phase: "compile-proofs",
            rule: "build",
            message: "Proofs/Main.lean:9:2: error: unsolved goals\n⊢ False",
          },
        ],
        "error",
      ),
    ).toEqual({
      headline: "1 error",
      body: ["proofs · build", "  Proofs/Main.lean:9:2: error: unsolved goals", "  ⊢ False"],
    });
  });

  it("heads spec-2 findings by intent, the judge's first, after anything unheaded", () => {
    expect(
      groupFindings(
        [
          { phase: "inspect", rule: "namespace", message: "proof declaration Foo does not carry namespace Lax1Proofs", intent: "standards" },
          { phase: "certify", rule: "kernel-rejected", message: "Lean's kernel rejected the solution:\nerror: …", intent: "judge" },
          { phase: "static", rule: "manifest", message: "title is missing" },
          { phase: "inspect", rule: "proof", message: "theorem Lax1Proofs.rep concludes Poly.{w, w} with `w` repeated", intent: "translation" },
        ],
        "error",
      ),
    ).toEqual({
      headline: "4 errors",
      body: [
        "layout · manifest",
        "  title is missing",
        "judge · the proof does not establish the edge",
        "  certificate · kernel-rejected",
        "    Lean's kernel rejected the solution:",
        "    error: …",
        "translation · the theorem is not the edge the record claims",
        "  statements · proof",
        "    theorem Lax1Proofs.rep concludes Poly.{w, w} with `w` repeated",
        "standards · archive standard, not a correctness failure",
        "  statements · namespace",
        "    proof declaration Foo does not carry namespace Lax1Proofs",
      ],
    });
  });

  it("returns nothing when validation found nothing", () => {
    expect(groupFindings([], "warning")).toBeUndefined();
  });

  it("passes an unmapped phase through rather than inventing a name for it", () => {
    expect(phaseLabel("compile-concepts")).toBe("concepts");
    expect(phaseLabel("something-new")).toBe("something-new");
  });
});
