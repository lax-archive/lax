import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { materializeHostCaptures } from "../../src/submission-validation/host/captures.js";
import type { ResolvedDependency } from "../../src/submission-validation/contracts.js";
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
