import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import type {
  ValidationReport,
  ValidationRequest,
} from "../../src/submission-validation/contracts.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";
import {
  compileSubmission,
  inspectSubmission,
  replaySubmission,
  validateSubmission,
  type ValidationOptions,
} from "../../src/submission-validation/pipeline.js";

interface RuntimePins {
  leanToolchain: string;
  leanVersion: string;
  mathlibRepository: string;
  mathlibCommit: string;
}

interface SmokeFixture {
  name: string;
  id: string;
  files?: Record<string, string>;
  check(report: ValidationReport, jobRoot: string): void;
}

const image = process.env.LAX_VALIDATION_IMAGE;
assert(
  image !== undefined && /@sha256:[0-9a-f]{64}$/u.test(image),
  "LAX_VALIDATION_IMAGE must be digest-pinned",
);

const runtime = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../src/submission-validation/runtime/validation-runtime.lock.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as RuntimePins;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-submission-validation-smoke-"));
const completed: Array<{ name: string; ok: boolean; captureFiles?: number }> = [];
const selectedFixtures = fixtures().filter(
  (fixture) => process.env.LAX_SMOKE_CASE === undefined || fixture.name === process.env.LAX_SMOKE_CASE,
);
assert(selectedFixtures.length > 0, `no smoke fixture named ${process.env.LAX_SMOKE_CASE}`);

try {
  for (const fixture of selectedFixtures) {
    const fixtureRoot = path.join(root, fixture.name);
    const sourceRoot = path.join(fixtureRoot, "source");
    const archiveRoot = path.join(fixtureRoot, "archive");
    const jobRoot = path.join(fixtureRoot, "job");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.mkdirSync(jobRoot, { recursive: true });
    writeFixture(sourceRoot, fixture.id, runtime, fixture.files ?? {});
    execFileSync("git", ["init", "--quiet", sourceRoot]);
    execFileSync("git", ["-C", sourceRoot, "add", "."]);
    execFileSync("git", [
      "-C",
      sourceRoot,
      "-c",
      "user.name=Lax Smoke",
      "-c",
      "user.email=smoke@lax.invalid",
      "commit",
      "--quiet",
      "-m",
      fixture.name,
    ]);
    const commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const request: ValidationRequest = {
      requestVersion: 1,
      id: fixture.id,
      source: {
        repository: `https://github.com/lax-archive/smoke-${fixture.name}`,
        commit,
        folder: ".",
      },
      archiveSha: "0".repeat(40),
    };
    const options: ValidationOptions = {
      local: {
        fetched: { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
        archive: new ArchiveSnapshot(archiveRoot, request.archiveSha),
      },
    };
    const report = fixture.name === "minimal"
      ? await validateInStages(request, jobRoot, options)
      : await validateSubmission(request, jobRoot, options);
    fixture.check(report, jobRoot);
    completed.push({
      name: fixture.name,
      ok: report.ok,
      ...(report.capture === undefined ? {} : { captureFiles: report.capture.files.length }),
    });
  }
  console.log(JSON.stringify({ ok: true, cases: completed }));
} finally {
  if (process.env.LAX_SMOKE_KEEP === "1") console.error(`smoke workspace retained at ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}

async function validateInStages(
  request: ValidationRequest,
  jobRoot: string,
  options: ValidationOptions,
): Promise<ValidationReport> {
  const compileFailure = await compileSubmission(request, jobRoot, options);
  if (compileFailure !== undefined) return compileFailure;
  const replayFailure = await replaySubmission(request, jobRoot, options);
  if (replayFailure !== undefined) return replayFailure;
  return inspectSubmission(request, jobRoot, options);
}

function fixtures(): SmokeFixture[] {
  return [
    {
      name: "minimal",
      id: "lax-1",
      check(report) {
        assertSuccessful(report);
        assert.equal("dialect" in report, false, "dialect verdict unexpectedly returned");
        assert.equal(
          "dialect" in report.buildOutput!,
          false,
          "dialect metadata unexpectedly emitted",
        );
      },
    },
    {
      name: "warm-cache-permissions",
      id: "lax-42",
      files: warmCachePermissionFiles(),
      check(report) {
        assertSuccessful(report);
      },
    },
    {
      name: "compile-provenance-attacks",
      id: "lax-43",
      files: compileProvenanceAttackFiles(),
      check(report) {
        assertSuccessful(report);
        const target = report.buildOutput!.concepts.find((concept) => concept.id === "Lax43.Target");
        assert(target !== undefined, "immutable target concept was not inspected");
        assert(
          target.statements.some((statement) => statement.signature === "archived_claim : True"),
          "compiled statement did not come from the archived source",
        );
        assert(target.sourceText.includes("archived_claim : True"));
        assert(
          !report.capture!.files.some((file) => file.path.includes("Generated.olean")),
          "generated module shadow entered the capture",
        );
      },
    },
    {
      name: "mutual-inductive-axiom-closure",
      id: "lax-23",
      files: mutualInductiveFiles(),
      check(report) {
        assertSuccessful(report);
        assert.deepEqual(
          report.buildOutput!.proofs.map((proof) => [proof.conclusion, proof.assumptions]),
          [
            ["Lax23.ViaA.via", ["Lax23.SideA.side", "Lax23.SideB.side"]],
            ["Lax23.ViaB.via", ["Lax23.SideA.side", "Lax23.SideB.side"]],
          ],
          "mutual-inductive declarations produced incomplete axiom closures",
        );
      },
    },
    {
      name: "compiler-generated-reserved-name",
      id: "lax-40",
      files: compilerGeneratedReservedNameFiles(),
      check(report, jobRoot) {
        assertSuccessful(report);
        const artifact = fs.readFileSync(
          path.join(jobRoot, "capture", "proofs", "lib", "Lax40Proofs", "Basic.olean"),
        );
        assert(
          artifact.includes(Buffer.from("congr_simp")),
          "fixture did not realize the compiler-generated congr_simp declaration",
        );
      },
    },
    {
      name: "authored-reserved-name",
      id: "lax-41",
      files: authoredReservedNameFiles(),
      check(report) {
        assert.equal(report.ok, false, "an authored reserved-suffix namespace escape was accepted");
        assert(
          report.violations.some(
            (finding) =>
              finding.rule === "namespace" && finding.message.includes("Elsewhere.congr_simp"),
          ),
          JSON.stringify(report.violations, null, 2),
        );
      },
    },
  ];
}

function assertSuccessful(report: ValidationReport): void {
  assert.equal(report.ok, true, JSON.stringify(report.violations, null, 2));
  assert(report.capture !== undefined, "validation did not produce a capture");
  assert(report.buildOutput !== undefined, "validation did not produce build output");
}

function writeFixture(
  root: string,
  id: string,
  pins: RuntimePins,
  files: Record<string, string>,
): void {
  const concepts = packageNameForSubmission(id);
  const proofs = `${concepts}Proofs`;
  const write = (relative: string, content: string): void => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, "utf8");
  };
  write(
    "manifest.yaml",
    `specVersion: "1"\nid: ${id}\nleanVersion: ${pins.leanVersion}\n` +
      `mathlibVersion: ${pins.mathlibCommit}\ntitle: Smoke submission ${id}\n` +
      "authors:\n  - name: Lax Smoke\n    github: lax-archive\nbibEntries: []\n",
  );
  write("abstract.md", `End-to-end submission validation smoke test for ${id}.\n`);
  write("LICENSE", fs.readFileSync(new URL("../../assets/apache-2.0.txt", import.meta.url), "utf8"));
  write(".gitignore", "build-output.json\nlake-manifest.json\n.lake/\n");
  write("concepts/lean-toolchain", `${pins.leanToolchain}\n`);
  write("concepts/lakefile.toml", lakefile(concepts, pins));
  write(`concepts/${concepts}.lean`, "");
  write("proofs/lean-toolchain", `${pins.leanToolchain}\n`);
  write("proofs/lakefile.toml", lakefile(proofs, pins, concepts));
  write(`proofs/${proofs}.lean`, "");
  for (const [relative, content] of Object.entries(files)) write(relative, content);
}

function lakefile(name: string, pins: RuntimePins, ownConcept?: string): string {
  return (
    `name = "${name}"\ndefaultTargets = ["${name}"]\n\n[leanOptions]\nautoImplicit = false\n\n` +
    `[[require]]\nname = "mathlib"\ngit = "${pins.mathlibRepository}"\nrev = "${pins.mathlibCommit}"\n\n` +
    (ownConcept === undefined
      ? ""
      : `[[require]]\nname = "${ownConcept}"\npath = "../concepts"\n\n`) +
    `[[lean_lib]]\nname = "${name}"\n`
  );
}

function conceptModule(title: string, body: string): string {
  return `/-!
---
title: ${title}
type: theorem
---
${title} smoke fixture.
-/

${body}`;
}

function warmCachePermissionFiles(): Record<string, string> {
  return {
    "concepts/Lax42.lean": "import Lax42.WarmCache\n",
    "concepts/Lax42/WarmCache.lean": `import Mathlib.Data.List.Basic
import Mathlib.Data.Set.Basic

${conceptModule(
  "Warm cache availability",
  `namespace Lax42.WarmCache

/-- A small statement that exercises the prebuilt Mathlib dependency graph. -/
axiom cache_readable : [0, 1].length = 2 ∧ (0 : Nat) ∈ ({0} : Set Nat)

end Lax42.WarmCache
`,
)}`,
  };
}

function compileProvenanceAttackFiles(): Record<string, string> {
  const replacement = conceptModule(
    "Immutable target",
    "namespace Lax43.Target\n/-- The archived claim. -/\naxiom archived_claim : False\nend Lax43.Target\n",
  );
  return {
    "concepts/Lax43.lean": "import Lax43.Attack\nimport Lax43.Target\n",
    "concepts/Lax43/Attack.lean": `${conceptModule(
      "Compile attack",
      `run_tac do
  try
    IO.FS.writeFile "Lax43/Target.lean" ${JSON.stringify(replacement)}
  catch _ =>
    pure ()
  IO.FS.createDirAll ".lake/build/lib/lean/Lax43"
  IO.FS.writeFile ".lake/build/lib/lean/Lax43/Generated.olean" "attacker generated object"

namespace Lax43.Attack
/-- The attack module remains a valid concept. -/
axiom attempted : True
end Lax43.Attack
`,
    )}`,
    "concepts/Lax43/Target.lean": `import Lax43.Attack

${conceptModule(
  "Immutable target",
  "namespace Lax43.Target\n/-- The archived claim. -/\naxiom archived_claim : True\nend Lax43.Target\n",
)}`,
  };
}

function mutualInductiveFiles(): Record<string, string> {
  return {
    "concepts/Lax23.lean":
      "import Lax23.SideA\nimport Lax23.SideB\nimport Lax23.ViaA\nimport Lax23.ViaB\n",
    "concepts/Lax23/SideA.lean": conceptModule(
      "Side A",
      "namespace Lax23.SideA\n/-- statement A -/\naxiom side : 2 = 2\nend Lax23.SideA\n",
    ),
    "concepts/Lax23/SideB.lean": conceptModule(
      "Side B",
      "namespace Lax23.SideB\n/-- statement B -/\naxiom side : 3 = 3\nend Lax23.SideB\n",
    ),
    "concepts/Lax23/ViaA.lean": conceptModule(
      "Via A",
      "namespace Lax23.ViaA\n/-- conclusion A -/\naxiom via : 0 = 0\nend Lax23.ViaA\n",
    ),
    "concepts/Lax23/ViaB.lean": conceptModule(
      "Via B",
      "namespace Lax23.ViaB\n/-- conclusion B -/\naxiom via : 1 = 1\nend Lax23.ViaB\n",
    ),
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
touches only the A side; its closure reaches side B through the cycle
-/
theorem via_a : 0 = 0 := (fun _ : A → A => rfl) fun a => a

/--
---
conclusion: Lax23.ViaB.via
assumptions:
  - Lax23.SideA.side
  - Lax23.SideB.side
---
touches only the B side; its closure reaches side A through the cycle
-/
theorem via_b : 1 = 1 := (fun _ : B → B => rfl) fun b => b

end Lax23Proofs
`,
  };
}

function compilerGeneratedReservedNameFiles(): Record<string, string> {
  return {
    "concepts/Lax40.lean": "import Lax40.Wrap\n",
    "concepts/Lax40/Wrap.lean": conceptModule(
      "Wrap",
      `namespace Lax40.Wrap

class MyPos (n : Nat) : Prop where
  pos : 0 < n

def pick (n : Nat) [MyPos n] : Nat := n

instance : MyPos 1 := ⟨Nat.one_pos⟩
instance : MyPos (0 + 1) := ⟨Nat.one_pos⟩

/-- the claim -/
axiom claim : pick (0 + 1) = pick 1

end Lax40.Wrap
`,
    ),
    "proofs/Lax40Proofs.lean": "import Lax40Proofs.Basic\n",
    "proofs/Lax40Proofs/Basic.lean": `import Lax40.Wrap

namespace Lax40Proofs

open Lax40.Wrap in
/--
---
conclusion: Lax40.Wrap.claim
---
the simp rewrite realizes a compiler-generated congruence declaration
-/
theorem my : pick (0 + 1) = pick 1 := by
  simp

end Lax40Proofs
`,
  };
}

function authoredReservedNameFiles(): Record<string, string> {
  return {
    "concepts/Lax41.lean": "import Lax41.Sneak\n",
    "concepts/Lax41/Sneak.lean": conceptModule(
      "Sneak",
      `namespace Elsewhere

/-- the authored namespace escape must remain visible despite the reserved suffix -/
axiom congr_simp : 3 = 3

end Elsewhere
`,
    ),
  };
}
