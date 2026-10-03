// The spec-2 fake environment end to end on the host (axiomfree-plan.md,
// stage 1): a row under the rehearsal toolchain whose set is the fake
// mathlib plus the fixture LaxCore (test/fake-laxcore.ts). The warm store
// has to provision the whole set, a scaffolded package requiring both has to
// build — and import LaxCore, and tag a definition — and a package that
// forgets LaxCore has to fail the libraries rule before anything is built.
//
// Skips itself where the rehearsal toolchain is not installed; ci.yml installs
// it (test/paths.ts SPEC2_TOOLCHAIN). Stage 2 added the content rules: the
// inspector reads the tag from the real oleans, the validator classifies
// statements and proofs, and `build-output.json` records telescopes — the
// second block below proves that whole path through the host pipeline.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  environment as environmentById,
  epoch,
  librariesOf,
} from "../../src/submission-validation/environments.js";
import { toolchainDir } from "../../src/submission-validation/host/leanenv.js";
import { warmDir, warmReady } from "../../src/submission-validation/host/warmstore.js";
import { sharedWarmBase } from "../paths.js";
import { spec2TestEnvironment, withTestEnvironments, withTestEnvironmentsAsync } from "../support/environments.js";
import { buildOnHost, freshLaxHome, makeHostSubmission, messages, rules } from "../support/host.js";

// the fixture LaxCore seam is set by test/setup-env.ts for fast runs only;
// a LAX_E2E run keeps the real pins and has no spec-2 row to rehearse
const SPEC2 = process.env.LAX_E2E === "1" ? undefined : spec2TestEnvironment();
const installed =
  SPEC2 !== undefined &&
  withTestEnvironments([SPEC2], () =>
    fs.existsSync(path.join(toolchainDir(environmentById(SPEC2.id)!), "bin", "lean")),
  );

beforeAll(() => {
  freshLaxHome();
});

describe.skipIf(!installed)("a spec-2 archive environment (real lake, fake mathlib, fixture LaxCore)", () => {
  const SPEC2 = spec2TestEnvironment();
  it("provisions the library set and builds a package requiring and importing LaxCore", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(environment.specVersion).toBe(2);
      expect(environment.leanToolchain).not.toBe(epoch().leanToolchain);
      expect(librariesOf(environment).map((library) => library.name)).toEqual(["mathlib", "LaxCore"]);

      const root = makeHostSubmission(
        "lax-35",
        {
          "concepts/Lax35.lean": "import Lax35.Zero\n",
          "concepts/Lax35/Zero.lean": `import LaxCore

/-!
---
title: Zero equals zero
type: theorem
---
A statement in the spec-2 shape: a tagged \`def\` of type \`Prop\`.
-/

namespace Lax35.Zero

/-- zero equals zero -/
@[lax_statement] def ZeroEq : Prop := 0 = 0

end Lax35.Zero
`,
          "proofs/Lax35Proofs.lean": "import Lax35Proofs.Basic\n",
          "proofs/Lax35Proofs/Basic.lean": `import Lax35.Zero

namespace Lax35Proofs

theorem zero_eq : Lax35.Zero.ZeroEq := rfl

end Lax35Proofs
`,
        },
        undefined,
        { environment },
      );
      // the scaffold wrote the row's content spec and both libraries
      expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain('specVersion: "2"');
      const conceptLakefile = fs.readFileSync(path.join(root, "concepts", "lakefile.toml"), "utf8");
      expect(conceptLakefile).toContain('name = "LaxCore"');
      expect(conceptLakefile).toContain(`rev = "${process.env.LAX_LAXCORE_REV}"`);

      const report = await buildOnHost(root, { id: "lax-35" });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.runtime.environment).toBe(SPEC2.id);
      expect(report.runtime.leanToolchain).toBe(SPEC2.leanToolchain);
      // the tagged def is a statement and the theorem over it is the edge {} → ZeroEq
      expect(report.buildOutput!.concepts[0]!.statements.map((statement) => statement.id)).toEqual(["Lax35.Zero.ZeroEq"]);
      expect(report.buildOutput!.proofs.map((proof) => [proof.conclusion, proof.assumptions])).toEqual([["Lax35.Zero.ZeroEq", []]]);

      // the warm store of the row holds the whole set, built, and sealed
      const warm = fs.realpathSync(warmDir(environment, sharedWarmBase()));
      expect(warmReady(warm)).toBe(true);
      expect(path.basename(warm)).toBe(`${SPEC2.id}-${environment.mathlibCommit.slice(0, 12)}-${process.env.LAX_LAXCORE_REV!.slice(0, 12)}`);
      expect(fs.readFileSync(path.join(warm, "LaxWarm.lean"), "utf8")).toBe("import Mathlib\nimport LaxCore\n");
      const warmManifest = JSON.parse(fs.readFileSync(path.join(warm, "lake-manifest.json"), "utf8")) as {
        packages: { name: string; type: string; rev?: string }[];
      };
      expect(warmManifest.packages.map((pkg) => [pkg.name, pkg.type, pkg.rev]).sort()).toEqual([
        ["LaxCore", "git", process.env.LAX_LAXCORE_REV],
        ["mathlib", "git", process.env.LAX_MATHLIB_REV],
      ]);
      const laxCoreOlean = path.join(warm, ".lake", "packages", "LaxCore", ".lake", "build", "lib", "lean", "LaxCore.olean");
      expect(fs.existsSync(laxCoreOlean)).toBe(true);
      expect(fs.statSync(laxCoreOlean).mode & 0o222).toBe(0);

      // and both packages were redirected at it through the overrides, with
      // the git-type entries kept verbatim in their seeded manifests
      for (const kind of ["concepts", "proofs"]) {
        const overrides = JSON.parse(
          fs.readFileSync(path.join(root, kind, ".lake", "package-overrides.json"), "utf8"),
        ) as { packages: { type: string; name: string; dir: string }[] };
        const laxCore = overrides.packages.find((pkg) => pkg.name === "LaxCore")!;
        expect(laxCore.type).toBe("path");
        expect(laxCore.dir).toBe(path.join(warm, ".lake", "packages", "LaxCore"));
        const manifest = JSON.parse(
          fs.readFileSync(path.join(root, kind, "lake-manifest.json"), "utf8"),
        ) as { packages: { type: string; name: string; rev?: string }[] };
        expect(manifest.packages.find((pkg) => pkg.name === "LaxCore")).toMatchObject({
          type: "git",
          rev: process.env.LAX_LAXCORE_REV,
        });
        expect(fs.existsSync(path.join(root, kind, ".lake", "packages"))).toBe(false);
      }
    });
  }, 600_000);

  it("refuses a package that omits LaxCore before building anything", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission("lax-36", {}, undefined, { environment, omitLibraries: ["LaxCore"] });
      const report = await buildOnHost(root, { id: "lax-36" });
      expect(report.ok).toBe(false);
      expect(rules(report)).toEqual(new Set(["lakefile"]));
      expect(messages(report)).toContain("concepts/lakefile.toml: the package must require pinned LaxCore directly");
      expect(messages(report)).toContain("proofs/lakefile.toml: the package must require pinned LaxCore directly");
      expect(fs.existsSync(path.join(root, "concepts", "lake-manifest.json"))).toBe(false);
    });
  });

  it("classifies a two-package spec-2 submission and records telescopes in build-output.json", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-38",
        {
          "concepts/Lax38.lean": "import Lax38.Order\n",
          "concepts/Lax38/Order.lean": `import LaxCore

/-!
---
title: Order facts
type: theorem
---
Two statements and an auxiliary.
-/

namespace Lax38.Order

/-- every natural has a strict successor -/
@[lax_statement] def HasSucc : Prop := ∀ n : Nat, ∃ m, n < m

/-- reflexivity, universe-polymorphic -/
@[lax_statement] def Refl.{u} : Prop := ∀ (α : Sort u) (a : α), a = a

/-- an auxiliary: a Prop-valued definition without the marker -/
def IsSmall (n : Nat) : Prop := n < 10

end Lax38.Order
`,
          "proofs/Lax38Proofs.lean": "import Lax38Proofs.Basic\n",
          "proofs/Lax38Proofs/Basic.lean": `import Lax38.Order

namespace Lax38Proofs

/-- a helper -/
theorem lt_succ (n : Nat) : n < n + 1 := Nat.lt_succ_self n

/-- unconditional -/
theorem hasSucc : Lax38.Order.HasSucc := fun n => ⟨n + 1, lt_succ n⟩

/--
conditional, universe-polymorphic

# Strategy

Ignore the hypothesis.
-/
theorem refl_of_hasSucc.{u} (_h : Lax38.Order.HasSucc) : Lax38.Order.Refl.{u} := fun _ _ => rfl

end Lax38Proofs
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-38" });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.warnings).toEqual([]);
      const out = report.buildOutput!;
      expect(out.inputs.manifest.specVersion).toBe("2");
      expect(out.concepts).toHaveLength(1);
      expect(out.concepts[0]!.mathlibImports).toEqual([]);
      expect(out.concepts[0]!.statements).toEqual([
        {
          id: "Lax38.Order.HasSucc",
          levelParams: [],
          signature: "HasSucc : Prop",
          body: "∀ (n : Nat), Exists fun m => instLTNat.lt n m",
          doc: "every natural has a strict successor",
          startLine: 13,
          endLine: 14,
        },
        {
          id: "Lax38.Order.Refl",
          levelParams: ["u"],
          signature: "Refl.{u} : Prop",
          body: "∀ (α : Sort u) (a : α), Eq a a",
          doc: "reflexivity, universe-polymorphic",
          startLine: 16,
          endLine: 17,
        },
      ]);
      expect(out.proofs).toEqual([
        {
          id: "Lax38Proofs.hasSucc",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: [],
          telescope: { hypotheses: [], conclusion: { statement: "Lax38.Order.HasSucc", levels: [] } },
          conclusion: "Lax38.Order.HasSucc",
          assumptions: [],
          description: "unconditional",
        },
        {
          id: "Lax38Proofs.refl_of_hasSucc",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: ["u"],
          telescope: {
            hypotheses: [{ statement: "Lax38.Order.HasSucc", levels: [], binder: "default" }],
            conclusion: { statement: "Lax38.Order.Refl", levels: ["u"] },
          },
          conclusion: "Lax38.Order.Refl",
          assumptions: ["Lax38.Order.HasSucc"],
          description: "conditional, universe-polymorphic",
          sections: [{ title: "Strategy", markdown: "Ignore the hypothesis." }],
        },
      ]);
      // and the entries carry their keys in the documented order, which is
      // what the CLI serialises into the author's build-output.json
      expect(Object.keys(out.proofs[1]!)).toEqual(["id", "path", "levelParams", "telescope", "conclusion", "assumptions", "description", "sections"]);
      expect(Object.keys(out.concepts[0]!.statements[1]!)).toEqual(["id", "levelParams", "signature", "body", "doc", "startLine", "endLine"]);
    });
  }, 600_000);

  it("fails in Inspect on a private proof-shaped theorem and a concrete universe level", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-39",
        {
          "concepts/Lax39.lean": "import Lax39.Order\n",
          "concepts/Lax39/Order.lean": `import LaxCore

/-!
---
title: Order facts
type: theorem
---
One polymorphic statement.
-/

namespace Lax39.Order

@[lax_statement] def Refl.{u} : Prop := ∀ (α : Sort u) (a : α), a = a

end Lax39.Order
`,
          "proofs/Lax39Proofs.lean": "import Lax39Proofs.Basic\n",
          "proofs/Lax39Proofs/Basic.lean": `import Lax39.Order

namespace Lax39Proofs

private theorem hidden.{u} : Lax39.Order.Refl.{u} := fun _ _ => rfl

theorem special : Lax39.Order.Refl.{0} := fun _ _ => rfl

end Lax39Proofs
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-39" });
      expect(report.ok).toBe(false);
      expect(rules(report)).toEqual(new Set(["proof"]));
      expect(report.violations.every((violation) => violation.phase === "inspect")).toBe(true);
      expect(messages(report)).toContain(
        "private theorem Lax39Proofs.hidden has the shape of a proof ({} → Lax39.Order.Refl); the archive's certificate must name it from another module — drop `private`",
      );
      expect(messages(report)).toContain(
        "theorem Lax39Proofs.special instantiates Lax39.Order.Refl at universe level `0`; every level argument of a statement in a proof's type must be a universe parameter of the proof",
      );
      expect(report.buildOutput).toBeUndefined();
    });
  }, 600_000);

  it("a tagged private def never reaches Inspect: LaxCore's hook refuses it at compile time", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-40",
        {
          "concepts/Lax40.lean": "import Lax40.Hidden\n",
          "concepts/Lax40/Hidden.lean": `import LaxCore

/-!
---
title: A hidden statement
type: theorem
---
The hook's private rule.
-/

namespace Lax40.Hidden

@[lax_statement] private def Secret : Prop := True

end Lax40.Hidden
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-40" });
      expect(report.ok).toBe(false);
      expect(report.violations.map((violation) => violation.phase)).toEqual(["compile-concepts"]);
      expect(messages(report)).toContain(
        "invalid `@[lax_statement]` on `Lax40.Hidden.Secret`: a statement cannot be `private`",
      );
    });
  }, 600_000);

  it("refuses a spec-1 manifest in the spec-2 row", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission("lax-37", {}, undefined, { environment });
      const manifestPath = path.join(root, "manifest.yaml");
      fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace('specVersion: "2"', 'specVersion: "1"'));
      const report = await buildOnHost(root, { id: "lax-37" });
      expect(report.ok).toBe(false);
      expect(messages(report)).toContain('specVersion must be "2" in environment v4.35.0');
    });
  });
});
