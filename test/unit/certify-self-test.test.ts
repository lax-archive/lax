// The judge self-test's host-side pieces (certify/self-test.ts): the project
// lax owns, the comparator config and export targets composed the record's
// way, the forgery on lean4export's NDJSON, and the tool digests.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_TEST_MODULES,
  SELF_TEST_THEOREM,
  forgeKernelRejection,
  selfTestComparatorConfig,
  selfTestExportTargets,
  selfTestProjectFiles,
  toolDigests,
  verifyToolDigests,
} from "../../src/submission-validation/certify/self-test.js";
import { JUDGE_TOOLS } from "../../src/submission-validation/contracts.js";
import type { ArchiveEnvironment } from "../../src/submission-validation/environments.js";
import { leanFacts } from "../../src/submission-validation/lean-facts.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const ENVIRONMENT: ArchiveEnvironment = {
  id: "v4.35.0",
  specVersion: 2,
  leanToolchain: "leanprover/lean4:v4.35.0",
  admittedAt: "2026-10-03",
  inspector: "inspector",
  libraries: [],
  mathlibCommit: "a".repeat(40),
};

/** A Solution export the way lean4export 3.1.0 writes it (NDJSON, names
 * hash-consed per component), reduced to the records the forgery reads. */
const EXPORT = [
  '{"in":1,"str":{"pre":0,"str":"Cert"}}',
  '{"in":2,"str":{"pre":1,"str":"selfTest"}}',
  '{"in":3,"str":{"pre":1,"str":"other"}}',
  '{"thm":{"all":[3],"levelParams":[],"name":3,"type":1,"value":4}}',
  '{"thm":{"all":[2],"levelParams":[],"name":2,"type":1,"value":5}}',
  "",
].join("\n");

describe("the judge self-test", () => {
  it("owns a core-only project with three one-line modules: the matching pair and the mismatch", () => {
    const files = selfTestProjectFiles();
    expect(Object.keys(files).sort()).toEqual(["SelfChallenge.lean", "SelfMismatch.lean", "SelfSolution.lean", "lake-manifest.json", "lakefile.toml"]);
    expect(files["SelfChallenge.lean"]).toBe(`theorem ${SELF_TEST_THEOREM} : True := sorry\n`);
    expect(files["SelfSolution.lean"]).toBe(`theorem ${SELF_TEST_THEOREM} : True := True.intro\n`);
    expect(files["SelfMismatch.lean"]).toBe(`theorem ${SELF_TEST_THEOREM} : 1 = 1 := rfl\n`);
    // no require, no import: nothing of any record or library
    expect(files["lakefile.toml"]).not.toContain("require");
    expect(JSON.parse(files["lake-manifest.json"]!)).toMatchObject({ packages: [] });
    for (const module of Object.values(SELF_TEST_MODULES)) expect(files[`${module}.lean`]).not.toContain("import");
    expect(files["lakefile.toml"]).toContain(`roots = ["${SELF_TEST_MODULES.challenge}", "${SELF_TEST_MODULES.solution}", "${SELF_TEST_MODULES.mismatch}"]`);
  });

  it("asks the comparator about the one theorem, naming the self-test's modules, with the background axioms", () => {
    expect(JSON.parse(selfTestComparatorConfig())).toEqual({
      challenge_module: "SelfChallenge",
      solution_module: "SelfSolution",
      theorem_names: [SELF_TEST_THEOREM],
      definition_names: [],
      permitted_axioms: ["propext", "Classical.choice", "Quot.sound"],
    });
  });

  it("exports with the record's own target composition, every target in Lean core", () => {
    const facts = leanFacts(ENVIRONMENT);
    expect(selfTestExportTargets(ENVIRONMENT)).toEqual([
      ...facts.comparatorExportTargets.slice(0, 4),
      SELF_TEST_THEOREM,
      ...facts.backgroundAxioms,
      ...facts.comparatorExportTargets.slice(4),
    ]);
  });

  it("forges the kernel-rejected export by setting the theorem's value to its type, and only that theorem's", () => {
    const forged = forgeKernelRejection(EXPORT, SELF_TEST_THEOREM).split("\n");
    expect(forged).toHaveLength(6);
    expect(forged[4]).toBe('{"thm":{"all":[2],"levelParams":[],"name":2,"type":1,"value":1}}');
    // the other theorem and every name record are untouched
    expect(forged.slice(0, 4)).toEqual(EXPORT.split("\n").slice(0, 4));
    expect(forged[5]).toBe("");
  });

  it("refuses to forge an export it cannot read: no such theorem, two of them, or not NDJSON", () => {
    expect(() => forgeKernelRejection(EXPORT, "Cert.missing")).toThrow("carries 0 theorem record(s) named Cert.missing");
    const twice = `${EXPORT}${'{"thm":{"all":[2],"levelParams":[],"name":2,"type":1,"value":6}}'}\n`;
    expect(() => forgeKernelRejection(twice, SELF_TEST_THEOREM)).toThrow("carries 2 theorem record(s)");
    expect(() => forgeKernelRejection("not json\n", SELF_TEST_THEOREM)).toThrow("is not NDJSON");
    for (const bad of [() => forgeKernelRejection(EXPORT, "Cert.missing"), () => forgeKernelRejection("x\n", SELF_TEST_THEOREM)]) {
      expect(bad).toThrow(expect.objectContaining({ kind: "infrastructure" }));
    }
  });

  it("digests every judge binary as installed and holds them to the same digests afterwards", () => {
    const toolchain = temporary("lax-self-test-toolchain-");
    fs.mkdirSync(path.join(toolchain, "bin"));
    for (const tool of JUDGE_TOOLS) fs.writeFileSync(path.join(toolchain, "bin", tool), `${tool}\n`);
    const digests = toolDigests(toolchain);
    expect(Object.keys(digests).sort()).toEqual([...JUDGE_TOOLS].sort());
    expect(digests.lake).toBe(createHash("sha256").update("lake\n").digest("hex"));
    expect(() => verifyToolDigests(toolchain, digests)).not.toThrow();
    fs.writeFileSync(path.join(toolchain, "bin", "con-ron"), "tampered\n");
    expect(() => verifyToolDigests(toolchain, digests)).toThrow("judge tool con-ron changed");
    fs.rmSync(path.join(toolchain, "bin", "lean"));
    expect(() => toolDigests(toolchain)).toThrow("judge tool lean is not installed");
    fs.mkdirSync(path.join(toolchain, "bin", "lean"));
    expect(() => toolDigests(toolchain)).toThrow("is not a regular file");
  });
});
