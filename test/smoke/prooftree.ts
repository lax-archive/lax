// The proof-tree composer, end to end, under every admitted environment whose
// toolchain this machine has installed.
//
// The composer's Lean sources are shared by every environment and have no
// conditional compilation, so a Lean release that moves a core signature
// breaks them for everyone — and the stage-0 spike measured that the unit and
// fake-mathlib e2e suites pass straight through such a break. This smoke and
// the inspector golden test are therefore the two things an admission run has
// to execute. It needs no mathlib: the fixtures import Lean core only.
//
// Environment selection follows the golden test's: the epoch in a normal run,
// plus whatever `LAX_TEST_ENVIRONMENTS` injects (the admission workflow
// injects its candidate and installs exactly that toolchain). Nothing is
// provisioned to run it, and a run that checked nothing fails.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  environments,
  type ArchiveEnvironment,
} from "../../src/submission-validation/environments.js";
import { leanBinary, toolchainDir } from "../../src/submission-validation/host/leanenv.js";

interface TheoremReport {
  statement: string;
  proof: string;
  generated: string;
  axioms: string[];
  clean: boolean;
}

interface KernelReport {
  moduleName: string;
  outputOlean: string;
  theorems: TheoremReport[];
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = path.join(repository, "test", "fixtures", "prooftree");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkComposer(environment: ArchiveEnvironment): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-prooftree-smoke-"));
  const leanEnvironment = {
    ...process.env,
    ELAN_TOOLCHAIN: environment.leanToolchain,
    LEAN_PATH: temporary,
  };
  // the environment's own binary, not a PATH lookup: elan's default toolchain
  // is not this machine's business here (same reasoning as host/leanenv.ts)
  const leanBin = leanBinary(environment);
  const lean = (args: string[]): string =>
    execFileSync(leanBin, args, {
      cwd: repository,
      encoding: "utf8",
      env: leanEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3 * 60_000,
    });

  try {
    const version = lean(["--version"]);
    assert(
      version.includes(`version ${environment.id.slice(1)}`),
      `proof-tree smoke test requires ${environment.id}; found ${version.trim()}`,
    );

    lean(["-o", path.join(temporary, "Concepts.olean"), path.join(fixtures, "Concepts.lean")]);
    lean(["-o", path.join(temporary, "Advanced.olean"), path.join(fixtures, "Advanced.lean")]);

    const moduleName = "AdvancedGenerated";
    const outputOlean = path.join(temporary, `${moduleName}.olean`);
    const outputReport = path.join(temporary, "kernel-report.json");
    const requestFile = path.join(temporary, "request.json");
    const entries = [
      { statement: "A", proof: "advancedProofA", assumptions: [] },
      { statement: "B", proof: "advancedProofB", assumptions: ["A"] },
      { statement: "C", proof: "advancedProofC", assumptions: ["A"] },
      { statement: "D", proof: "advancedProofD", assumptions: ["A"] },
      { statement: "E", proof: "advancedProofE", assumptions: ["Open"] },
      { statement: "F", proof: "advancedProofF", assumptions: ["E"] },
      { statement: "G", proof: "advancedProofG", assumptions: ["A"] },
      { statement: "H", proof: "advancedProofH", assumptions: ["A"] },
    ].map((entry) => ({
      ...entry,
      generated: `${moduleName}.${entry.statement}`,
    }));
    fs.writeFileSync(requestFile, `${JSON.stringify({
      moduleName,
      outputOlean,
      outputReport,
      conceptModules: ["Concepts"],
      entries,
    }, null, 2)}\n`);

    process.stdout.write(lean([
      "--run",
      path.join(repository, "assets", "prooftree", "Main.lean"),
      requestFile,
      "Advanced",
    ]));
    process.stdout.write(lean([
      "--run",
      path.join(repository, "assets", "prooftree", "Verify.lean"),
      requestFile,
      moduleName,
    ]));
    const printedAxioms = lean([path.join(fixtures, "AdvancedCheck.lean")]);

    const report = JSON.parse(fs.readFileSync(outputReport, "utf8")) as KernelReport;
    assert(report.moduleName === moduleName, "composer reported the wrong module");
    assert(report.outputOlean === outputOlean, "composer reported the wrong output path");
    assert(report.theorems.length === entries.length, "composer omitted theorem results");
    const byStatement = new Map(report.theorems.map((theorem) => [theorem.statement, theorem]));
    for (const statement of ["A", "B", "C", "D", "G", "H"]) {
      const theorem = byStatement.get(statement);
      assert(theorem?.clean === true, `${statement} should be clean`);
      assert(
        JSON.stringify(theorem.axioms) === JSON.stringify(["propext", "Classical.choice", "Quot.sound"]),
        `${statement} should report exactly the conservative background axioms`,
      );
    }
    for (const statement of ["E", "F"]) {
      const theorem = byStatement.get(statement);
      assert(theorem?.clean === false, `${statement} should retain its open assumption`);
      assert(theorem.axioms.includes("Open"), `${statement} should report its transitive open assumption`);
    }
    assert(printedAxioms.includes("'AdvancedGenerated.E' depends on axioms: [Open]"), "kernel did not retain E's open axiom");
    assert(printedAxioms.includes("'AdvancedGenerated.F' depends on axioms: [Open]"), "kernel did not retain F's open axiom");
    console.log(`proof-tree smoke test passed under ${environment.id}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const checked: string[] = [];
for (const environment of environments()) {
  if (!fs.existsSync(toolchainDir(environment))) {
    console.log(`proof-tree smoke test: ${environment.id} is not installed, skipping`);
    continue;
  }
  checkComposer(environment);
  checked.push(environment.id);
}
assert(checked.length > 0, "no admitted environment's toolchain is installed; nothing was checked");
