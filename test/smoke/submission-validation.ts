// Real-container smoke over the trusted validation pipeline: the pinned
// *stock* image (pulled by verifyRuntime), the VM/host-installed toolchain
// and warm mathlib workspace mounted read-only, and the shared
// seedManifest/seedOverrides provisioning. Runs the same host-setup path the
// trusted workflow uses (host/setup.ts) against the user's real ~/.lax, so an
// existing warm store is reused and never re-downloaded. Needs docker.
//
// The `paper-web` fixture additionally needs the fetched ReflowTeX fork
// (`npm run reflowtex:fetch` — checkout + hash-pinned venv): the web
// derivation compiles and converts inside the pinned TeX image but encodes
// through the fork on this host, exactly as the Validate job does.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import type {
  ValidationReport,
  ValidationRequest,
} from "../../src/submission-validation/contracts.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";
import { ensureValidationHost } from "../../src/submission-validation/host/setup.js";
import {
  LEAN_TOOLCHAIN,
  LEAN_VERSION,
  MATHLIB_REV,
  MATHLIB_URL,
  REFLOWTEX_REV,
} from "../../src/submission-validation/pins.js";
import {
  validateSubmission,
  type ValidationOptions,
} from "../../src/submission-validation/pipeline.js";
import { formatProfile, Profiler } from "../../src/shared/profile.js";

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
  /** Extra manifest.yaml keys (a `paper:` block). */
  manifestExtra?: string;
  check(report: ValidationReport, jobRoot: string): void;
}

assert(
  process.env.LAX_MATHLIB_URL === undefined && process.env.LAX_MATHLIB_REV === undefined,
  "the smoke runs against the real pins; unset the LAX_MATHLIB_* test seam",
);

const runtime: RuntimePins = {
  leanToolchain: LEAN_TOOLCHAIN,
  leanVersion: LEAN_VERSION,
  mathlibRepository: MATHLIB_URL,
  mathlibCommit: MATHLIB_REV,
};
assert(await ensureValidationHost({ echo: true }), "validation host setup failed");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-submission-validation-smoke-"));
const completed: Array<{ name: string; ok: boolean; wallMs?: number; captureFiles?: number }> = [];
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
    writeFixture(sourceRoot, fixture.id, runtime, fixture.files ?? {}, fixture.manifestExtra ?? "");
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
    const profiler = new Profiler();
    const options: ValidationOptions = {
      local: {
        fetched: { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
        archive: new ArchiveSnapshot(archiveRoot, request.archiveSha),
      },
      profiler,
    };
    const started = performance.now();
    const report = await validateSubmission(request, jobRoot, options);
    console.error(`\n[${fixture.name}]\n${formatProfile(profiler.snapshot())}`);
    fixture.check(report, jobRoot);
    completed.push({
      name: fixture.name,
      ok: report.ok,
      wallMs: Math.round(performance.now() - started),
      ...(report.capture === undefined ? {} : { captureFiles: report.capture.files.length }),
    });
  }
  console.log(JSON.stringify({ ok: true, cases: completed }));
} finally {
  if (process.env.LAX_SMOKE_KEEP === "1") console.error(`smoke workspace retained at ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
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
      // The paper layer's trusted path: the pinned TeX Live image pulled on
      // demand (5.5 GB — the slow case), latexmk in the bare container beside
      // the Lean chain, destinations read back, ids resolved against Inspect,
      // the PDF handed out and its sources captured under paper/.
      name: "paper",
      id: "lax-44",
      files: paperFiles(),
      manifestExtra: "paper:\n  folder: paper\n  main: main.tex\n",
      check(report, jobRoot) {
        assertSuccessful(report);
        const paper = report.buildOutput!.paper;
        assert(paper !== undefined, "the paper was not recorded");
        assert.deepEqual(
          paper.marks.map((mark) => [mark.id, mark.kind]),
          [["Lax44.Claim", "concept"], ["Lax44Proofs.claim", "proof"]],
          JSON.stringify(paper.marks, null, 2),
        );
        assert.equal(paper.pdf.pages, 1);
        const pdfPath = (report as { paperPdfPath?: string }).paperPdfPath;
        assert(pdfPath !== undefined && pdfPath.startsWith(jobRoot), "the PDF did not come out of the job directory");
        const bytes = fs.readFileSync(pdfPath);
        assert.equal(bytes.length, paper.pdf.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), paper.pdf.digest);
        assert.deepEqual(
          report.capture!.files.filter((file) => file.path.startsWith("paper/")).map((file) => file.path),
          ["paper/main.tex"],
          "the paper sources were not captured",
        );
      },
    },
    {
      // The web derivation's trusted path (paper-web-plan.md stage 3): the
      // -shell-escape lualatex compile in the TeX image on its own fresh
      // copy, tikz externalization through the re-injected sub-run, the
      // in-image export (fonts by name, picture PDFs to sanitized SVG), the
      // host-side encode over the fetched fork, the oracle, and the sealed
      // paper-web.tar leaving the job bound to `paper.web`.
      name: "paper-web",
      id: "lax-45",
      files: paperWebFiles(),
      manifestExtra: "paper:\n  folder: paper\n  main: main.tex\n",
      check(report, jobRoot) {
        assertSuccessful(report);
        // The picture's transparent shape is the only expected web note: it
        // is redrawn without transparency (see below), which is reported and
        // never a skip.
        const webSkips = report.warnings.filter(
          (warning) => warning.rule.startsWith("web-") && warning.rule !== "web-pictures-flattened",
        );
        assert.equal(
          webSkips.length,
          0,
          "the web derivation skipped (run `npm run reflowtex:fetch` first?): " +
            JSON.stringify(webSkips, null, 2),
        );
        const flattened = report.warnings.filter((warning) => warning.rule === "web-pictures-flattened");
        assert.equal(flattened.length, 1, "the transparent picture was not reported as flattened");
        const paper = report.buildOutput!.paper;
        assert(paper !== undefined, "the paper was not recorded");
        const web = paper.web;
        assert(web !== undefined, "the web view was not recorded");
        assert.equal(web.format.tool, "reflowtex");
        assert.equal(web.format.rev, REFLOWTEX_REV);
        const webPath = (report as { paperWebPath?: string }).paperWebPath;
        assert(webPath !== undefined && webPath.startsWith(jobRoot), "the bundle did not come out of the job directory");
        const bundle = fs.readFileSync(webPath);
        assert.equal(bundle.length, web.bundle.bytes);
        assert.equal(createHash("sha256").update(bundle).digest("hex"), web.bundle.digest);
        const entries = execFileSync("tar", ["-tf", webPath], { encoding: "utf8" }).trim().split("\n");
        for (const required of ["index.json", "blocks/000.pb", "schema/latex.proto"]) {
          assert(entries.includes(required), `bundle is missing ${required}`);
        }
        // The tikz picture came through the in-image dvisvgm conversion into
        // the encoded block as inline SVG (the encode child's own dvisvgm
        // seam is pinned shut on this path, so a missed conversion cannot
        // pass silently — reaching here proves the export step converted).
        const block = execFileSync("tar", ["-xOf", webPath, "blocks/000.pb"]);
        assert(block.includes(Buffer.from("<path", "utf8")), "the encoded block carries no picture SVG");
        // Ghostscript rasterizes a page with transparency and the sanitizer
        // drops the raster, which left the figure blank until the export
        // learned to redraw it without transparency; and the EPS route draws
        // the page above the origin, which the host squares up before the
        // encode reads it. Both are invisible downstream, so they are checked
        // in the bytes the reader's browser will draw.
        assert(!block.includes(Buffer.from("<image", "utf8")), "the picture arrived as a raster image");
        assert(
          block.includes(Buffer.from("<g transform='translate(", "utf8")),
          "the picture's box was not moved to the origin",
        );
        // The T1 Latin Modern text face reached the bundle as a converted
        // outline: the in-image export resolved `ec-lmr10` through
        // pdftex.map (lmr10.pfb + lm-ec.enc under the TeX name) and the
        // host encode converted it — the route the first real lipics paper
        // (lax-65) found missing.
        const index = JSON.parse(execFileSync("tar", ["-xOf", webPath, "index.json"], { encoding: "utf8" })) as {
          fonts: Record<string, string>;
        };
        const converted = Object.keys(index.fonts).filter((name) => /^ec-lmr10\.reflowtex-[0-9a-f]{8}\.otf$/u.test(name));
        assert.equal(converted.length, 1, `no converted ec-lmr10 in the font map: ${Object.keys(index.fonts).join(", ")}`);
        assert(entries.includes(index.fonts[converted[0]!]!), "the converted face is mapped but not carried");
        // The PDF path is untouched beside it.
        assert.equal(paper.pdf.pages, 1);
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
  manifestExtra = "",
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
      "authors:\n  - name: Lax Smoke\n    github: lax-archive\nbibEntries: []\n" +
      manifestExtra,
  );
  write("abstract.md", `End-to-end submission validation smoke test for ${id}.\n`);
  write("LICENSE", fs.readFileSync(new URL("../../assets/apache-2.0.txt", import.meta.url), "utf8"));
  write(".gitignore", "build-output.json\npaper.pdf\nlake-manifest.json\n.lake/\n");
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
    // run_cmd (Lean core) executes authored IO at *compile* time: overwriting
    // the target source must bounce off the read-only source mount, while the
    // shadow olean lands in writable build state and must never reach the
    // capture. (As authored upstream this module used `run_tac` without any
    // import — a parse error, so the fixture never compiled and the smoke was
    // red on main; repaired during stage 3A.)
    "concepts/Lax43/Attack.lean": `import Lean

${conceptModule(
      "Compile attack",
      `run_cmd do
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

function paperFiles(): Record<string, string> {
  return {
    "concepts/Lax44.lean": "import Lax44.Claim\n",
    "concepts/Lax44/Claim.lean": conceptModule(
      "A claim",
      "namespace Lax44.Claim\n/-- the claim -/\naxiom holds : 0 = 0\nend Lax44.Claim\n",
    ),
    "proofs/Lax44Proofs.lean": "import Lax44Proofs.Basic\n",
    "proofs/Lax44Proofs/Basic.lean": `import Lax44.Claim

namespace Lax44Proofs

/--
---
conclusion: Lax44.Claim.holds
---
by reflexivity
-/
theorem claim : 0 = 0 := rfl

end Lax44Proofs
`,
    "paper/main.tex": `\\documentclass{article}
\\usepackage{amsthm}
\\newtheorem{theorem}{Theorem}
\\begin{document}
% lax begin Lax44.Claim
\\begin{theorem}
  $0 = 0$.
\\end{theorem}
% lax end
% lax begin Lax44Proofs.claim
\\begin{proof}
  By reflexivity.
\\end{proof}
% lax end
\\end{document}
`,
  };
}

function paperWebFiles(): Record<string, string> {
  return {
    "concepts/Lax45.lean": "import Lax45.Claim\n",
    "concepts/Lax45/Claim.lean": conceptModule(
      "A claim",
      "namespace Lax45.Claim\n/-- the claim -/\naxiom holds : 0 = 0\nend Lax45.Claim\n",
    ),
    "proofs/Lax45Proofs.lean": "import Lax45Proofs.Basic\n",
    "proofs/Lax45Proofs/Basic.lean": `import Lax45.Claim

namespace Lax45Proofs

/--
---
conclusion: Lax45.Claim.holds
---
by reflexivity
-/
theorem claim : 0 = 0 := rfl

end Lax45Proofs
`,
    // A textless tikz picture on purpose, and a transparent shape in it:
    // externalization, the -shell-escape sub-run, the in-image dvisvgm
    // conversion, the flatten-and-retry for the raster Ghostscript makes of
    // any transparency, and the SVG sanitizer are all exercised while the
    // oracle's substrates stay token-identical
    // (picture *label* text is a PDF-only token and a known oracle
    // tolerance question, not this smoke's subject). T1 Latin Modern is the
    // text face every lmodern/lipics paper uses: its outlines resolve only
    // through pdftex.map (`lmr10.pfb` re-encoded by `lm-ec.enc`), which the
    // in-image export must carry for the encode host to convert them.
    "paper/main.tex": `\\documentclass{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsthm}
\\usepackage{tikz}
\\newtheorem{theorem}{Theorem}
\\begin{document}
The picture below has an arrow and a box drawn by tikz, externalized by
the web compile into its own sub-run and converted to inline vector
graphics for the reflow surface, while this paragraph provides the
running text both substrates carry verbatim, word for word, so the
derivation's oracle sees two token sequences that agree completely.

\\begin{tikzpicture}
  \\draw[->] (0,0) -- (2,1);
  \\draw (3,0) rectangle (4,1);
  \\fill[opacity=0.3] (0.2,0.2) rectangle (1,0.8);
\\end{tikzpicture}

% lax begin Lax45.Claim
\\begin{theorem}
  $0 = 0$.
\\end{theorem}
% lax end
% lax begin Lax45Proofs.claim
\\begin{proof}
  By reflexivity.
\\end{proof}
% lax end
\\end{document}
`,
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
