// Opt-in end-to-end test against the pinned *real* mathlib revision — the
// port of the old repo's e2e.test.ts "builds a submission on top of the
// pinned mathlib". Runs the host pipeline exactly as `lax build` would:
// the real pins (setup-env.ts leaves them alone under LAX_E2E), the user's
// real warm store (~/.lax/warm via sharedWarmBase()), and a stable
// submission dir (test/paths.ts E2E_WORKSPACE) so `.lake/` survives across
// runs and rebuilds stay incremental. The first run on a cold machine
// downloads gigabytes:
//   LAX_E2E=1 npx vitest run test/e2e/real-mathlib.test.ts

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { E2E_WORKSPACE } from "../paths.js";
import {
  buildOnHost,
  freshLaxHome,
  makeHostSubmission,
  messages,
} from "../support/host.js";

describe.skipIf(process.env.LAX_E2E !== "1")("mathlib e2e (host pipeline, real pins)", () => {
  beforeAll(() => {
    freshLaxHome();
  });

  it("builds a submission on top of the pinned mathlib", async () => {
    // stable path: the workspace trees survive across runs
    const root = makeHostSubmission("lax-99", {
      "concepts/Lax99.lean": "import Lax99.Squares\n",
      "concepts/Lax99/Squares.lean": `import Mathlib.Algebra.Group.Even

/-!
---
title: Even squares
type: theorem
---
The square of an even natural number is even.
-/

namespace Lax99.Squares

/-- if n is even, so is n * n -/
axiom evenSquare : ∀ n : ℕ, Even n → Even (n * n)

end Lax99.Squares
`,
      "proofs/Lax99Proofs.lean": "import Lax99Proofs.Basic\n",
      "proofs/Lax99Proofs/Basic.lean": `import Lax99.Squares
import Mathlib.Tactic.Ring

namespace Lax99Proofs

/--
---
conclusion: Lax99.Squares.evenSquare
---
unfold evenness and close with ring
-/
theorem even_square : ∀ n : ℕ, Even n → Even (n * n) := by
  rintro n ⟨r, rfl⟩
  exact ⟨(r + r) * r, by ring⟩

end Lax99Proofs
`,
    }, E2E_WORKSPACE);

    const report = await buildOnHost(root, { id: "lax-99" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    const out = report.buildOutput!;
    expect(out.concepts[0]!.statements.map((statement) => statement.id))
      .toEqual(["Lax99.Squares.evenSquare"]);
    expect(out.concepts[0]!.mathlibImports).toEqual(["Mathlib.Algebra.Group.Even"]);
    expect(out.proofs[0]!.conclusion).toBe("Lax99.Squares.evenSquare");
    expect(out.proofs[0]!.assumptions).toEqual([]);

    // ---- phase 2: mathlib-specific edges, incremental rebuild ----
    // importing a module of mathlib's own dependencies is not allowed;
    // mathlib's `lemma` syntax still counts as theorem kind.
    fs.writeFileSync(
      path.join(root, "concepts", "Lax99", "Squares.lean"),
      `import Mathlib.Algebra.Group.Even
import Batteries.Logic

/-!
---
title: Even squares
type: theorem
---
The square of an even natural number is even.
-/

namespace Lax99.Squares

/-- if n is even, so is n * n -/
axiom evenSquare : ∀ n : ℕ, Even n → Even (n * n)

end Lax99.Squares
`,
    );
    fs.writeFileSync(
      path.join(root, "proofs", "Lax99Proofs", "Basic.lean"),
      `import Lax99.Squares
import Mathlib.Tactic.Ring
import Mathlib.Tactic.Lemma

namespace Lax99Proofs

/--
---
conclusion: Lax99.Squares.evenSquare
---
written with mathlib's lemma syntax; still of theorem kind
-/
lemma even_square : ∀ n : ℕ, Even n → Even (n * n) := by
  rintro n ⟨r, rfl⟩
  exact ⟨(r + r) * r, by ring⟩

end Lax99Proofs
`,
    );
    const second = await buildOnHost(root, { id: "lax-99" });
    expect(messages(second)).toContain(
      "module Lax99.Squares imports undeclared package module Batteries.Logic",
    );
    // the lemma-syntax proof is judged at theorem kind: no violation names it
    expect(messages(second)).not.toContain("even_square");
  }, 3_600_000);
});
