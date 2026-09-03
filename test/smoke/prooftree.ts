import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lock from "../../src/submission-validation/runtime/validation-runtime.lock.json" with { type: "json" };

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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-prooftree-smoke-"));
const leanEnvironment = {
  ...process.env,
  ELAN_TOOLCHAIN: lock.leanToolchain,
  LEAN_PATH: temporary,
};

function lean(args: string[]): string {
  return execFileSync("lean", args, {
    cwd: repository,
    encoding: "utf8",
    env: leanEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3 * 60_000,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const version = lean(["--version"]);
  assert(
    version.includes(`version ${lock.leanVersion.slice(1)}`),
    `proof-tree smoke test requires ${lock.leanVersion}; found ${version.trim()}`,
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
  console.log("proof-tree smoke test passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
