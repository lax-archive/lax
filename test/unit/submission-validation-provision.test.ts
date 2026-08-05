import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionWorkspace } from "../../src/submission-validation/phases/provision.js";
import {
  cleanupTemporary,
  makeSubmission,
  staticResult,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

function fakeWarm(): string {
  const warm = temporary("lax-provision-warm-");
  writeFile(
    warm,
    "lake-manifest.json",
    JSON.stringify({
      version: "1.2.0",
      packages: [{ type: "git", name: "mathlib", inherited: false, scope: "" }],
    }),
  );
  return warm;
}

describe("submission workspace provisioning", () => {
  it("keeps sibling paths relative to the fetched repository after workspace copying", () => {
    const sourceRoot = temporary("lax-provision-siblings-");
    makeSubmission("lax-1", path.join(sourceRoot, "a"));
    const submissionRoot = makeSubmission("lax-2", path.join(sourceRoot, "b"));
    const job = temporary("lax-provision-job-");
    const checked = staticResult("lax-2");
    checked.concepts!.lakefile.pathRequires.push({ name: "Lax1", path: "../../a/concepts" });

    const workspace = provisionWorkspace(
      "concepts",
      { repositoryRoot: sourceRoot, submissionRoot },
      "b",
      checked,
      { concepts: [], proofs: [], all: [] },
      {
        concepts: [],
        proofs: [],
        closure: new Map([
          ["Lax1", {
            pkgDir: fs.realpathSync(path.join(sourceRoot, "a", "concepts")),
            gitRequires: [],
            pathEntries: [],
          }],
        ]),
      },
      job,
      fakeWarm(),
    );

    const manifest = JSON.parse(workspace.manifests.concepts) as {
      packages: Array<{ type: string; name: string; dir?: string }>;
    };
    expect(manifest.packages).toContainEqual(
      expect.objectContaining({ type: "path", name: "Lax1", dir: "../../a/concepts" }),
    );
    // sibling dirs must never escape through the absolute fetched-source tree
    expect(manifest.packages.some((entry) => entry.dir?.includes("source"))).toBe(false);
    // the warm workspace's own locked entries carry over verbatim
    expect(manifest.packages).toContainEqual(expect.objectContaining({ name: "mathlib" }));
  });

  it("materializes resolved dependencies at their in-container capture mounts", () => {
    const sourceRoot = makeSubmission("lax-2");
    const job = temporary("lax-provision-deps-job-");
    const dependency = {
      submissionId: "lax-7",
      kind: "concepts" as const,
      packageName: "Lax7",
      source: {
        repository: "https://github.com/alice/dependency",
        commit: "7".repeat(40),
        folder: ".",
      },
      state: "registered" as const,
      statements: [],
      requiredPackages: [],
    };

    const workspace = provisionWorkspace(
      "concepts",
      { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
      ".",
      staticResult("lax-2"),
      { concepts: [dependency], proofs: [dependency], all: [dependency] },
      { concepts: [], proofs: [], closure: new Map() },
      job,
      fakeWarm(),
    );

    const manifest = JSON.parse(workspace.manifests.concepts) as {
      packages: Array<{ type: string; name: string; dir?: string }>;
    };
    expect(manifest.packages).toContainEqual(
      expect.objectContaining({
        type: "path",
        name: "Lax7",
        dir: "/deps/lax-7/concepts/package",
      }),
    );
  });
});
