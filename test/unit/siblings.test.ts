import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { resolveSiblings, siblingManifestDir } from "../../src/submission-validation/host/siblings.js";
import { runStaticValidation } from "../../src/submission-validation/phases/static.js";
import {
  appendRequirement,
  cleanupTemporary,
  git,
  initializeGit,
  makeSubmission,
  request,
  RUNTIME,
  temporary,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

/** Three checkouts side by side under one base, so the relative paths are
 * the ones an author writes: `../../<folder>/<kind>` from a package dir. */
function layout(): { base: string; a: string; b: string; c: string } {
  const base = temporary("lax-siblings-");
  return {
    base,
    a: makeSubmission("lax-7", path.join(base, "A")),
    b: makeSubmission("lax-9", path.join(base, "B")),
    c: makeSubmission("lax-5", path.join(base, "C")),
  };
}

function archive(records: Array<{ id: string; state: string; source?: object }> = []): ArchiveSnapshot {
  const root = temporary("lax-archive-");
  for (const record of records) {
    const directory = path.join(root, record.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "record.json"),
      JSON.stringify({ ...record, specVersion: "1", createdAt: "2026-01-01T00:00:00Z" }),
    );
    fs.writeFileSync(
      path.join(directory, "build-output.json"),
      JSON.stringify({ id: record.id, specVersion: "1", requiredByConcepts: [], requiredByProofs: [] }),
    );
  }
  return new ArchiveSnapshot(root, "a".repeat(40));
}

function closureOf(root: string, snapshot = archive()) {
  // static validation reads the tracked tree; the fixture changes between
  // calls, so each call commits whatever is there now
  if (fs.existsSync(path.join(root, ".git"))) {
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  } else initializeGit(root);
  const check = runStaticValidation(request("lax-9"), root, RUNTIME, { siblings: true });
  expect(check.findings.violations).toEqual([]);
  const findings = new FindingCollector("static");
  const closure = resolveSiblings(root, check.result, check.runtime, snapshot, findings);
  return { closure, findings };
}

describe("sibling closure (lax build --nonstrict)", () => {
  it("walks concept siblings into both packages, with manifest dirs relative to each", () => {
    const { b } = layout();
    appendRequirement(path.dirname(b), "B", "concepts", 'name = "Lax7"\npath = "../../A/concepts"');
    const { closure, findings } = closureOf(b);
    expect(findings.violations).toEqual([]);
    expect(closure.concepts.map((sibling) => sibling.name)).toEqual(["Lax7"]);
    // the proof package inherits the concept package's siblings: lake needs
    // the entry in the proofs manifest too
    expect(closure.proofs.map((sibling) => sibling.name)).toEqual(["Lax7"]);
    expect(siblingManifestDir(path.join(b, "concepts"), closure.concepts[0]!)).toBe("../../A/concepts");
    expect(siblingManifestDir(path.join(b, "proofs"), closure.proofs[0]!)).toBe("../../A/concepts");
  });

  it("follows a sibling's own path requires, git requires, and a sibling proof package's concept edge", () => {
    const { base, b } = layout();
    // A's concepts reach C by path and a registered Lax3 by git; B's proofs
    // reach A's proofs, which reach A's concepts through ../concepts.
    appendRequirement(base, "A", "concepts", 'name = "Lax5"\npath = "../../C/concepts"');
    appendRequirement(
      base,
      "A",
      "concepts",
      `name = "Lax3"\ngit = "https://github.com/lax-test/three"\nrev = "${"3".repeat(40)}"\nsubDir = "concepts"`,
    );
    appendRequirement(base, "B", "proofs", 'name = "Lax7Proofs"\npath = "../../A/proofs"');
    const { closure, findings } = closureOf(b);
    expect(findings.violations).toEqual([]);
    expect(closure.concepts).toEqual([]);
    expect(closure.proofs.map((sibling) => `${sibling.name}:${siblingManifestDir(path.join(b, "proofs"), sibling)}`).sort())
      .toEqual(["Lax5:../../C/concepts", "Lax7:../../A/concepts", "Lax7Proofs:../../A/proofs"]);
    expect(closure.gitRequires.proofs.map((require) => require.name)).toEqual(["Lax3"]);
    // the proof-dependency warning is the author's, as for a git require
    expect(findings.warnings).toEqual([]);
  });

  it("refuses a sibling the archive has registered, spelling out the git require to write", () => {
    const { b } = layout();
    appendRequirement(path.dirname(b), "B", "concepts", 'name = "Lax7"\npath = "../../A/concepts"');
    const registered = archive([
      {
        id: "lax-7",
        state: "registered",
        source: { repository: "https://github.com/alice/seven", commit: "7".repeat(40), folder: "sub" },
      },
    ]);
    const { closure, findings } = closureOf(b, registered);
    expect(closure.concepts).toEqual([]);
    const message = findings.violations.map((finding) => finding.message).join("\n");
    expect(message).toContain("lax-7 is registered");
    expect(message).toContain('git = "https://github.com/alice/seven"');
    expect(message).toContain(`rev = "${"7".repeat(40)}"`);
    expect(message).toContain('subDir = "sub/concepts"');
    expect(message).toContain("supersedes: lax-7");
    // a draft record is no obstacle: the sibling is for exactly that stage
    const draft = archive([
      {
        id: "lax-7",
        state: "draft",
        source: { repository: "https://github.com/alice/seven", commit: "6".repeat(40), folder: "sub" },
      },
    ]);
    expect(closureOf(b, draft).findings.violations).toEqual([]);
  });

  it("refuses paths that resolve inside the submission, do not exist, or name a different package", () => {
    const { base, b } = layout();
    for (const [requirement, expected] of [
      ['name = "Lax7"\npath = "../proofs"', "resolves inside this submission"],
      ['name = "Lax7"\npath = "../../missing/concepts"', "does not exist"],
      // C's lakefile names Lax5, not Lax7
      ['name = "Lax7"\npath = "../../C/concepts"', "is package Lax5, not Lax7"],
    ] as const) {
      fs.writeFileSync(
        path.join(b, "concepts", "lakefile.toml"),
        fs.readFileSync(path.join(base, "A", "concepts", "lakefile.toml"), "utf8").replace(/Lax7/gu, "Lax9"),
      );
      appendRequirement(base, "B", "concepts", requirement);
      const { findings } = closureOf(b);
      expect(findings.violations.map((finding) => finding.message).join("\n")).toContain(expected);
    }
  });
});
