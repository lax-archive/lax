// Lean-content regressions: judgments that only a *real* compile can
// produce. Ported from the old repo's pipeline.test.ts and edge.test.ts with
// the Lean fixtures kept verbatim — each one is shaped the way it is for a
// reason recorded in its comment. They live in their own file so vitest forks
// them beside host-pipeline.test.ts rather than after it.
//
// Everything here runs the host toolchain against the fake mathlib (see
// test/fake-mathlib.ts); the suite's testTimeout is 600s.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOnHost, freshLaxHome, makeHostSubmission, messages, rules } from "../support/host.js";

beforeAll(() => {
  freshLaxHome();
});

// Ported as the old one-statement-per-concept suite and inverted here: the
// cardinality gate (one-axiom-plan.md) is gone, so the fixtures are kept
// verbatim and only the expectations flipped — a concept module declaring two
// axioms is now ordinary content (rewrite.md, "multiple statements per
// concept").
describe("statements per concept", () => {
  /** A concept package with the given modules, built concepts-only: statement
   * cardinality is a property of the concept package alone. */
  function conceptPackage(id: string, name: string, modules: Record<string, string>): string {
    const names = Object.keys(modules);
    return makeHostSubmission(id, {
      [`concepts/${name}.lean`]: names.map((module) => `import ${name}.${module}\n`).join(""),
      ...Object.fromEntries(
        names.map((module) => [
          `concepts/${name}/${module}.lean`,
          `/-!
---
title: ${module}
type: theorem
---
a concept module.
-/

namespace ${name}.${module}

${modules[module]}
end ${name}.${module}
`,
        ]),
      ),
    });
  }

  it("accepts zero, one, and several axioms in a concept module", async () => {
    const root = conceptPackage("lax-25", "Lax25", {
      // zero axioms: vocabulary only
      Vocab: "/-- vocabulary, no claim -/\ndef two : Nat := 2\n",
      // one axiom
      Claim: "/-- the claim -/\naxiom claim : 2 = 2\n",
      // several axioms in one module: no longer a violation
      Two: "/-- first claim -/\naxiom claimA : 5 = 5\n\n/-- second claim -/\naxiom claimB : 6 = 6\n",
    });
    const report = await buildOnHost(root, { id: "lax-25", scope: "concepts" });
    expect(report.violations).toEqual([]);
  });

  it("carries every statement of a multi-statement concept into the build output", async () => {
    // The fixture the gate used to reject, now taken all the way through a
    // full concept+proof build: both axioms of Lax26.Two are statements, each
    // separately concludable, and both reach the build output.
    const root = makeHostSubmission("lax-26", {
      "concepts/Lax26.lean": "import Lax26.Two\nimport Lax26.Fine\n",
      "concepts/Lax26/Two.lean": `/-!
---
title: Two
type: theorem
---
a concept module with two statements.
-/

namespace Lax26.Two

/-- first claim -/
axiom claimA : 2 = 2

/-- second claim -/
axiom claimB : 3 = 3

end Lax26.Two
`,
      "concepts/Lax26/Fine.lean": `/-!
---
title: Fine
type: theorem
---
a concept module with one statement.
-/

namespace Lax26.Fine

/-- the claim -/
axiom claim : 4 = 4

end Lax26.Fine
`,
      "proofs/Lax26Proofs.lean": "import Lax26Proofs.Basic\n",
      "proofs/Lax26Proofs/Basic.lean": `import Lax26.Two

namespace Lax26Proofs

/--
---
conclusion: Lax26.Two.claimA
---
proves the first statement of the concept
-/
theorem provesA : 2 = 2 := rfl

/--
---
conclusion: Lax26.Two.claimB
assumptions:
  - Lax26.Two.claimA
---
proves the second statement of the same concept, assuming the first
-/
theorem provesB : 3 = 3 := by
  have h := Lax26.Two.claimA
  rfl

end Lax26Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-26" });
    expect(rules(report)).toEqual(new Set());
    const output = report.buildOutput!;
    const two = output.concepts.find((concept) => concept.id === "Lax26.Two")!;
    expect(two.statements.map((statement) => statement.id)).toEqual([
      "Lax26.Two.claimA",
      "Lax26.Two.claimB",
    ]);
    expect(two.statements.map((statement) => statement.doc)).toEqual([
      "first claim",
      "second claim",
    ]);
    // both statements of the one concept are independently concludable, and
    // one may be assumed while proving the other
    expect(output.proofs.map((proof) => [proof.conclusion, proof.assumptions])).toEqual([
      ["Lax26.Two.claimA", []],
      ["Lax26.Two.claimB", ["Lax26.Two.claimA"]],
    ]);
  });
});

describe("axiom closures through dependency cycles", () => {
  it("reports complete assumption sets for proofs behind mutual inductives", async () => {
    // Mutual inductives form a dependency cycle; each side's axiom closure
    // reaches the other side's statement only through the cycle. The
    // inspector's cross-declaration cache must not memoize the partial sets
    // computed while the cycle is still open — a proof touching only one
    // side must still report both statements as assumptions.
    const root = makeHostSubmission("lax-23", {
      "concepts/Lax23.lean":
        "import Lax23.SideA\nimport Lax23.SideB\nimport Lax23.ViaA\nimport Lax23.ViaB\n",
      "concepts/Lax23/SideA.lean": `/-!
---
title: Side A
type: theorem
---
Statement reached through the A side of the cycle.
-/

namespace Lax23.SideA

/-- statement reached through the A side of the cycle -/
axiom side : 2 = 2

end Lax23.SideA
`,
      "concepts/Lax23/SideB.lean": `/-!
---
title: Side B
type: theorem
---
Statement reached through the B side of the cycle.
-/

namespace Lax23.SideB

/-- statement reached through the B side of the cycle -/
axiom side : 3 = 3

end Lax23.SideB
`,
      "concepts/Lax23/ViaA.lean": `/-!
---
title: Via A
type: theorem
---
Conclusion for the proof touching A.
-/

namespace Lax23.ViaA

/-- conclusion for the proof touching A -/
axiom via : 0 = 0

end Lax23.ViaA
`,
      "concepts/Lax23/ViaB.lean": `/-!
---
title: Via B
type: theorem
---
Conclusion for the proof touching B.
-/

namespace Lax23.ViaB

/-- conclusion for the proof touching B -/
axiom via : 1 = 1

end Lax23.ViaB
`,
      "proofs/Lax23Proofs.lean": "import Lax23Proofs.Basic\n",
      "proofs/Lax23Proofs/Basic.lean": `import Lax23.SideA
import Lax23.SideB
import Lax23.ViaA
import Lax23.ViaB

namespace Lax23Proofs

def qa : Prop := Lax23.SideA.side = Lax23.SideA.side

def qb : Prop := Lax23.SideB.side = Lax23.SideB.side

mutual
  inductive A : Prop where
    | mk : B → qa → A
  inductive B : Prop where
    | mk : A → qb → B
end

/--
---
conclusion: Lax23.ViaA.via
assumptions:
  - Lax23.SideA.side
  - Lax23.SideB.side
---
touches only the A side; its closure reaches sideB through the cycle
-/
theorem via_a : 0 = 0 := (fun _ : A → A => rfl) fun a => a

/--
---
conclusion: Lax23.ViaB.via
assumptions:
  - Lax23.SideA.side
  - Lax23.SideB.side
---
touches only the B side; its closure reaches sideA through the cycle
-/
theorem via_b : 1 = 1 := (fun _ : B → B => rfl) fun b => b

end Lax23Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-23" });
    expect(report.violations).toEqual([]);
    expect(report.buildOutput!.proofs.map((proof) => [proof.conclusion, proof.assumptions])).toEqual([
      ["Lax23.ViaA.via", ["Lax23.SideA.side", "Lax23.SideB.side"]],
      ["Lax23.ViaB.via", ["Lax23.SideA.side", "Lax23.SideB.side"]],
    ]);
  });
});

describe("compiler-realized reserved names", () => {
  it("tolerates simp-persisted lemmas named under a concept's namespace", async () => {
    // simp with a concept definition persists auto-derived reserved lemmas
    // (`<fn>.congr_simp`, `<fn>.eq_def`, …) in the *proof* module, named
    // under the rewritten function's namespace — through no fault of the
    // author, so the namespace rule must not fire (history/hiccups.md, 2026-07-21)
    // `pick` has an instance argument depending on a rewritable argument, so
    // simp cannot use the plain congr lemmas: it realizes `pick.congr_simp`
    // (verified below on the olean) in the proof module, named under the
    // concept's namespace
    const root = makeHostSubmission("lax-40", {
      "concepts/Lax40.lean": "import Lax40.Wrap\n",
      "concepts/Lax40/Wrap.lean": `/-!
---
title: Wrap
type: theorem
---
a definition whose instance argument makes simp derive a congruence lemma
-/
namespace Lax40.Wrap

class MyPos (n : Nat) : Prop where
  pos : 0 < n

def pick (n : Nat) [MyPos n] : Nat := n

instance : MyPos 1 := ⟨Nat.one_pos⟩
instance : MyPos (0 + 1) := ⟨Nat.one_pos⟩

/-- the claim -/
axiom claim : pick (0 + 1) = pick 1

end Lax40.Wrap
`,
      "proofs/Lax40Proofs.lean": "import Lax40Proofs.Basic\n",
      "proofs/Lax40Proofs/Basic.lean": `import Lax40.Wrap

namespace Lax40Proofs

open Lax40.Wrap in
/--
---
conclusion: Lax40.Wrap.claim
---
the simp rewrite under pick realizes its congruence lemma here
-/
theorem my : pick (0 + 1) = pick 1 := by
  simp

end Lax40Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-40" });
    expect(report.violations).toEqual([]);
    // the scenario only guards the filter while simp actually persisted the
    // reserved lemma in the proof module — assert it did
    const olean = fs.readFileSync(
      path.join(root, "proofs", ".lake", "build", "lib", "lean", "Lax40Proofs", "Basic.olean"),
    );
    expect(olean.includes("congr_simp")).toBe(true);
  });

  it("keeps an authored reserved-suffix name visible to namespace enforcement", async () => {
    const root = makeHostSubmission("lax-41", {
      "concepts/Lax41.lean": "import Lax41.Sneak\n",
      "concepts/Lax41/Sneak.lean": `/-!
---
title: Sneak
type: theorem
---
squats an out-of-namespace name behind the reserved suffix
-/
namespace Elsewhere

/-- the claim -/
axiom congr_simp : 3 = 3

end Elsewhere
`,
    });
    const report = await buildOnHost(root, { id: "lax-41" });
    expect(rules(report)).toContain("namespace");
    expect(messages(report)).toContain("Elsewhere.congr_simp");
  });
});

describe("inspect-level violations through a real compile", () => {
  it("collects every inspect-level violation in one run", async () => {
    const root = makeHostSubmission("lax-3", {
      // root misses Orphan -> root-module violation
      "concepts/Lax3.lean": "import Lax3.Zero\nimport Lax3.Plain\n",
      "concepts/Lax3/Zero.lean": `/-!
---
title: Zero
type: theorem
---
fine concept
-/

namespace Lax3.Zero

/-- statement -/
axiom zeroEq : 0 = 0

/-- uses a statement: axiom-free violation -/
theorem usesStatement : 0 = 0 := zeroEq

/-- escapes the namespace -/
theorem _root_.Lax3Escape.bad : 0 = 0 := rfl

/--
---
conclusion: Lax3.Zero.zeroEq
---
frontmatter on a concept declaration
-/
axiom misplacedProof : 0 = 0

end Lax3.Zero
`,
      // no module docstring -> annotation violation
      "concepts/Lax3/Plain.lean": "namespace Lax3.Plain\ndef x : Nat := 0\nend Lax3.Plain\n",
      // valid but not imported by the root
      "concepts/Lax3/Orphan.lean": `/-!
---
title: Orphan
type: theorem
---
valid but unimported
-/
namespace Lax3.Orphan
def y : Nat := 1
end Lax3.Orphan
`,
      "proofs/Lax3Proofs.lean": "import Lax3Proofs.Basic\n",
      "proofs/Lax3Proofs/Basic.lean": `import Lax3.Zero

namespace Lax3Proofs

/-- a stray axiom: hygiene violation -/
axiom stray : 5 = 5

/--
---
conclusion: Lax3.Zero.zeroEq
---
valid proof
-/
theorem good : 0 = 0 := rfl

/--
---
conclusion: Lax3.Zero.zeroEq
---
not a theorem
-/
def notThm : 0 = 0 := rfl

/--
---
conclusion: Lax3.Zero.zeroEq
foo: unknown key
---
type mismatch
-/
theorem wrongType : 1 = 1 := rfl

/--
---
conclusion: Lax3.Zero.nope
---
unresolvable conclusion
-/
theorem unresolved : 0 = 0 := rfl

/--
---
conclusion: Lax3.Zero.zeroEq
assumptions:
  - Lax3.Zero.zeroEq
---
claims an assumption it does not use
-/
theorem wrongAssumptions : 0 = 0 := rfl

/--
---
description: no conclusion here
---
frontmatter without conclusion
-/
theorem noConclusion : 0 = 0 := rfl

/-- sorry: hygiene violation -/
theorem sorried : 2 = 2 := sorry

/-- escapes the namespace -/
theorem _root_.LaxEscape.p : 0 = 0 := rfl

end Lax3Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-3" });
    const found = messages(report);

    expect(found).toContain("[root-module] Lax3 must import exactly its package modules");
    expect(found).toContain("[annotation] concept Lax3.Plain must carry exactly one module docstring");
    expect(found).toContain("[annotation] concept declaration Lax3.Zero.misplacedProof carries proof frontmatter");
    expect(found).toContain("[axiom-free] concept declaration Lax3.Zero.usesStatement");
    // Lax3.Zero declares two axioms; that is no longer a violation of its own
    expect(found).not.toContain("[one-statement]");
    expect(found).toContain("[namespace] concept declaration Lax3Escape.bad");
    expect(found).toContain("[namespace] proof declaration LaxEscape.p");
    expect(found).toContain("[axiom-hygiene] proof declaration Lax3Proofs.stray");
    expect(found).toContain("sorryAx");
    expect(found).toContain("[proof] proof Lax3Proofs.notThm must be a theorem declaration");
    expect(found).toContain("[frontmatter] proof Lax3Proofs.wrongType: unrecognized scalar foo");
    expect(found).toContain(
      "[proof] proof Lax3Proofs.wrongType: theorem type is not definitionally equal",
    );
    expect(found).toContain("[proof] proof Lax3Proofs.unresolved: conclusion Lax3.Zero.nope does not resolve");
    expect(found).toContain(
      "[proof] proof Lax3Proofs.wrongAssumptions: declared assumptions do not match",
    );
    expect(found).toContain("[frontmatter] proof Lax3Proofs.noConclusion: unrecognized scalar description");
    expect(report.buildOutput).toBeUndefined();
  });
});

describe("edge cases that must pass", () => {
  it("accepts structures, private defs, deep namespaces, kernel defeq, nested proof modules, and transitive reachability", async () => {
    const root = makeHostSubmission("lax-6", {
      // root: explicit `import Init` must be ignored by the exactness check
      "concepts/Lax6.lean": "import Init\nimport Lax6.S\nimport Lax6.N\n",
      "concepts/Lax6/S.lean": `/-!
---
title: Structures and friends
type: theorem
---
edge cases that are all fine
-/

namespace Lax6.S

/-- a structure: elaboration generates ctor, recursor, mk.injEq, ... -/
structure P where
  x : Nat
  y : Nat

private def helper : Nat := 0

/-- reducible statement: 2 + 2 is definitionally 4 -/
axiom twoTwo : 2 + 2 = 4

end Lax6.S
`,
      // a statement declared in a namespace deeper than the module's
      "concepts/Lax6/N.lean": `/-!
---
title: Nested
type: theorem
---
a statement in a deeper namespace
-/

namespace Lax6.N

namespace Deep.Er
/-- statement in a deeper namespace -/
axiom nested : 1 = 1
end Deep.Er

end Lax6.N
`,
      "proofs/Lax6Proofs.lean": "import Lax6Proofs.Helper\nimport Lax6Proofs.Deep.A\n",
      // intermediate module: Deep.A reaches the concept only through it
      "proofs/Lax6Proofs/Helper.lean": `import Lax6.S
import Lax6.N

namespace Lax6Proofs

/--
---
conclusion: Lax6.S.twoTwo
---
the proof's type 4 = 4 is defeq, not syntactically equal, to 2 + 2 = 4
-/
theorem viaDefeq : 4 = 4 := rfl

/-- a helper whose docstring contains a --- rule
---
this is prose, not frontmatter
-/
theorem helperWithRule : 1 = 1 := rfl

end Lax6Proofs
`,
      "proofs/Lax6Proofs/Deep/A.lean": `import Lax6Proofs.Helper

namespace Lax6Proofs.Deep

/--
---
conclusion: Lax6.N.Deep.Er.nested
assumptions:
---
proof in a nested module, reusing another proof, empty assumptions list
-/
theorem viaHelper : 1 = 1 := helperWithRule

end Lax6Proofs.Deep
`,
    });
    const report = await buildOnHost(root, { id: "lax-6" });
    expect(report.violations).toEqual([]);
    const output = report.buildOutput!;
    expect(output.concepts.flatMap((concept) => concept.statements.map((s) => s.id)).sort()).toEqual([
      "Lax6.N.Deep.Er.nested",
      "Lax6.S.twoTwo",
    ]);
    expect(output.proofs.map((proof) => proof.id)).toEqual([
      "Lax6Proofs.Deep.viaHelper",
      "Lax6Proofs.viaDefeq",
    ]);
    expect(output.proofs.map((proof) => proof.path)).toEqual([
      "proofs/Lax6Proofs/Deep/A.lean",
      "proofs/Lax6Proofs/Helper.lean",
    ]);
    // `helperWithRule`'s docstring carries a `---` rule that does not parse as
    // frontmatter. The declaration is admissible as a helper, so this is a
    // warning and never a violation — but it stays visible, because the same
    // shape is what a mistyped proof frontmatter looks like.
    expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
      "docstring of Lax6Proofs.helperWithRule contains a `---` line but was not recognized as " +
        "frontmatter (the lines above it do not parse as `key: value`)",
    );
  });
});

describe("edge cases that must fail", () => {
  it("catches frontmatter and environment edge violations in one run", async () => {
    const root = makeHostSubmission("lax-7", {
      // extra Std import -> root-module exactness violation (Init stays ignored)
      "concepts/Lax7.lean": "import Std\nimport Lax7.S\nimport Lax7.Two\n",
      "concepts/Lax7/S.lean": `/-!
---
title: S
type: theorem
---
fine
-/

namespace Lax7.S

/-- statement -/
axiom claim : 0 = 0

/-- sorry in a concept -/
theorem sorried : 2 = 2 := sorry

end Lax7.S
`,
      // two module docstrings
      "concepts/Lax7/Two.lean": `/-!
---
title: first
type: theorem
---
one
-/

/-! second module docstring -/

namespace Lax7.Two
def x : Nat := 0
end Lax7.Two
`,
      "proofs/Lax7Proofs.lean": "import Lax7Proofs.Basic\n",
      "proofs/Lax7Proofs/Basic.lean": `import Lax7.S

namespace Lax7Proofs

/--
---
conclusion: Lax7.S.claim
conclusion: Lax7.S.claim
---
duplicate key
-/
theorem dup : 0 = 0 := rfl

/--
---
- item without a list key
---
bad list
-/
theorem badList : 0 = 0 := rfl

/--
---
conclusion: Lax7.S.claim
assumptions: Lax7.S.claim
---
assumptions must be a list, not a scalar
-/
theorem scalarAssumptions : 0 = 0 := rfl

end Lax7Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-7" });
    const found = messages(report);
    expect(found).toContain("[root-module] Lax7 must import exactly its package modules");
    expect(found).not.toContain("Init"); // the implicit import stays ignored
    expect(found).toContain("[axiom-free] concept declaration Lax7.S.sorried");
    expect(found).toContain("[annotation] concept Lax7.Two must carry exactly one module docstring");
    expect(found).toContain("[frontmatter] proof Lax7Proofs.dup: duplicate key conclusion");
    expect(found).toContain("[frontmatter] proof Lax7Proofs.badList");
    // DEVIATION from the old suite: a scalar under a list-only key is now
    // rejected as an unrecognized *scalar* key rather than with a dedicated
    // "must be a yaml list" message. Same rule, different wording.
    expect(found).toContain("[frontmatter] proof Lax7Proofs.scalarAssumptions: unrecognized scalar assumptions");
  });
});
