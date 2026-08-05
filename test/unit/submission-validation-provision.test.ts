import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { provisionWorkspace } from "../../src/submission-validation/phases/provision.js";
import type { ValidationRunner } from "../../src/submission-validation/sandbox/container.js";
import {
  cleanupTemporary,
  makeSubmission,
  staticResult,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

describe("submission workspace provisioning", () => {
  it("keeps sibling paths relative to the fetched repository after workspace copying", async () => {
    const sourceRoot = temporary("lax-provision-siblings-");
    makeSubmission("lax-1", path.join(sourceRoot, "a"));
    const submissionRoot = makeSubmission("lax-2", path.join(sourceRoot, "b"));
    const job = temporary("lax-provision-job-");
    const checked = staticResult("lax-2");
    checked.concepts!.lakefile.pathRequires.push({ name: "Lax1", path: "../../a/concepts" });
    let plan: {
      packages: Array<{
        directory: string;
        pathDependencies: Array<{ name: string; directory: string }>;
      }>;
    } | undefined;
    const runner: ValidationRunner = {
      run: async () => {
        const repository = path.join(job, "workspaces", "concepts", "repository");
        plan = JSON.parse(fs.readFileSync(path.join(repository, ".lax-provision.json"), "utf8"));
        for (const kind of ["concepts", "proofs"] as const)
          writeFile(repository, `b/${kind}/lake-manifest.json`, "{\"packages\":[]}\n");
        return { code: 0, output: "", timedOut: false };
      },
      verifyRuntime: async () => {},
    };

    await provisionWorkspace(
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
      path.join(job, "missing-dependencies"),
      runner,
      DEFAULT_LIMITS,
    );

    const conceptPlan = plan!.packages.find((pkg) => pkg.directory.endsWith("/concepts"))!;
    expect(conceptPlan.pathDependencies).toContainEqual({
      name: "Lax1",
      directory: "../../a/concepts",
    });
    expect(conceptPlan.pathDependencies.some((dependency) => dependency.directory.includes("source")))
      .toBe(false);
  });
});
