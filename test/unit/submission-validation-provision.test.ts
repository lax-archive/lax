import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { materializeHostCaptures } from "../../src/submission-validation/host/captures.js";
import type { ResolvedDependency } from "../../src/submission-validation/contracts.js";
import {
  installOwnConceptCapture,
  provisionWorkspace,
} from "../../src/submission-validation/phases/provision.js";
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
  it("seeds only the own ../concepts edge, never a path out of the submission", () => {
    const sourceRoot = temporary("lax-provision-tree-");
    makeSubmission("lax-1", path.join(sourceRoot, "a"));
    const submissionRoot = makeSubmission("lax-2", path.join(sourceRoot, "b"));
    const job = temporary("lax-provision-job-");

    const workspace = provisionWorkspace(
      "proofs",
      { repositoryRoot: sourceRoot, submissionRoot },
      "b",
      staticResult("lax-2"),
      { concepts: [], proofs: [], all: [] },
      job,
      fakeWarm(),
    );

    const packages = (kind: "concepts" | "proofs") =>
      (JSON.parse(workspace.manifests[kind]) as {
        packages: Array<{ type: string; name: string; dir?: string }>;
      }).packages;
    // the proof package's own concept package, spelled relatively
    expect(packages("proofs")).toContainEqual(
      expect.objectContaining({ type: "path", name: "Lax2", dir: "../concepts" }),
    );
    // nothing reaches another submission folder, and no path escapes into the
    // absolute fetched-source tree
    for (const kind of ["concepts", "proofs"] as const)
      for (const entry of packages(kind))
        expect(entry.dir === undefined || entry.dir === "../concepts").toBe(true);
    // the warm workspace's own locked entries carry over verbatim
    expect(packages("concepts")).toContainEqual(expect.objectContaining({ name: "mathlib" }));
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

  it("installs the own concept capture's full output set, ir included", () => {
    const sourceRoot = makeSubmission("lax-2");
    const job = temporary("lax-provision-install-job-");
    const workspace = provisionWorkspace(
      "proofs",
      { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
      ".",
      staticResult("lax-2"),
      { concepts: [], proofs: [], all: [] },
      job,
      fakeWarm(),
    );
    const captureRoot = temporary("lax-provision-capture-");
    // Lake treats a path dependency's module as stale unless the trace AND
    // every companion — including the C artifacts under build/ir — are
    // present (captures/seal.ts); the concepts tree is read-only during the
    // proofs compile, so a missing companion breaks the build.
    writeFile(captureRoot, "concepts/lib/Lax2/Basic.olean", "olean");
    writeFile(captureRoot, "concepts/lib/Lax2/Basic.trace", "trace");
    writeFile(captureRoot, "concepts/ir/Lax2/Basic.c", "c");
    writeFile(captureRoot, "concepts/ir/Lax2/Basic.c.hash", "hash");

    installOwnConceptCapture(workspace, captureRoot);

    const lib = workspace.libraries.concepts;
    const ir = path.resolve(lib, "..", "..", "ir");
    for (const filename of [
      path.join(lib, "Lax2", "Basic.olean"),
      path.join(lib, "Lax2", "Basic.trace"),
      path.join(ir, "Lax2", "Basic.c"),
      path.join(ir, "Lax2", "Basic.c.hash"),
    ]) {
      expect(fs.existsSync(filename)).toBe(true);
      expect(fs.statSync(filename).mode & 0o222).toBe(0);
    }
  });
});

describe("host capture registry allowlist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function dependencyWith(registryBlob: string): ResolvedDependency {
    return {
      packageName: "Lax7",
      submissionId: "lax-7",
      kind: "concepts",
      source: {
        repository: "https://github.com/alice/dependency",
        commit: "7".repeat(40),
        folder: ".",
      },
      state: "registered",
      capture: {
        formatVersion: 1,
        digest: "a".repeat(64),
        sourceCommit: "7".repeat(40),
        leanToolchain: "leanprover/lean4:v4.30.0",
        mathlibCommit: "c".repeat(40),
        files: [{ path: "concepts/lib/Lax7.olean", bytes: 1, sha256: "b".repeat(64) }],
        registryBlob,
      },
      statements: [],
      requiredPackages: [],
    };
  }

  it("rejects a non-ghcr registryBlob reference without any network fetch when the seam is unset", async () => {
    // The LAX_CAPTURE_REGISTRY_URL seam must never widen the production
    // allowlist: with the seam unset, a 127.0.0.1 reference dies at the
    // digest-address check before a single request is made.
    expect(process.env.LAX_CAPTURE_REGISTRY_URL).toBeUndefined();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      materializeHostCaptures(
        [dependencyWith(`127.0.0.1:9999/lax-archive/lax-captures@sha256:${"a".repeat(64)}`)],
        temporary("lax-captures-job-"),
        DEFAULT_LIMITS,
      ),
    ).rejects.toThrow("not the record's ghcr digest address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a blob redirect to a local address when the seam is unset", async () => {
    expect(process.env.LAX_CAPTURE_REGISTRY_URL).toBeUndefined();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.startsWith("https://ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "anonymous" }), { status: 200 });
      }
      // ghcr answering the digest-addressed blob GET with a redirect off the
      // production allowlist: the download must refuse to follow it.
      return new Response(null, {
        status: 307,
        headers: { location: "http://127.0.0.1:9999/blob" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      materializeHostCaptures(
        [dependencyWith(`ghcr.io/lax-archive/lax-captures@sha256:${"a".repeat(64)}`)],
        temporary("lax-captures-job-"),
        DEFAULT_LIMITS,
      ),
    ).rejects.toThrow("capture redirect leaves the allowed public HTTPS locations");
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://ghcr.io/"))).toBe(true);
  });
});
