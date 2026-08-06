// The trusted container path's dependency-capture materialization
// (captures/materialize.ts), driven through the standard fake-runner seam: a
// runner that plays download-capture.mjs (writes the prepared blob bytes)
// and extract-capture.mjs (a real local tar extraction). This carries the
// digest/inventory verification coverage that used to ride on the host
// pipeline's capture path — locally dependencies now build from source, so
// captures are verified only here and in the container e2e surfaces (docker
// smoke, live rehearsal).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { materializeDependencyCaptures } from "../../src/submission-validation/captures/materialize.js";
import type { PublishedCapture, ResolvedDependency } from "../../src/submission-validation/contracts.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import { removeValidationWorkspace } from "../../src/submission-validation/workspace-cleanup.js";
import { cleanupTemporary, temporary, writeFile } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A sealed capture fixture: deterministic tar of a package + lib tree, with
 * the per-file inventory a database record would declare. */
function captureFixture(): { blob: Buffer; capture: PublishedCapture } {
  const root = temporary("lax-capture-fixture-");
  const files: Record<string, string> = {
    "concepts/package/lakefile.toml": 'name = "Lax7"\n',
    "concepts/lib/Lax7.olean": "olean bytes",
    "concepts/lib/Lax7.trace": "trace bytes",
  };
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content);
  const tarPath = path.join(temporary("lax-capture-tar-"), "capture.tar");
  execFileSync("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--format=ustar", "-cf", tarPath, "-C", root, ".",
  ]);
  const blob = fs.readFileSync(tarPath);
  const capture: PublishedCapture = {
    formatVersion: 1,
    digest: sha256(blob),
    sourceCommit: "7".repeat(40),
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "c".repeat(40),
    files: Object.entries(files).map(([relative, content]) => ({
      path: relative,
      bytes: Buffer.byteLength(content),
      sha256: sha256(Buffer.from(content)),
    })),
    registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${sha256(blob)}`,
  };
  return { blob, capture };
}

function dependencyWith(capture: PublishedCapture): ResolvedDependency {
  return {
    packageName: "Lax7",
    submissionId: "lax-7",
    kind: "concepts",
    source: { repository: "https://github.com/alice/dependency", commit: "7".repeat(40), folder: "." },
    state: "registered",
    capture,
    statements: [],
    requiredPackages: [],
  };
}

/** Plays the two sandbox tools against the host jobDir: the download step
 * writes `blob` where the tool would, the extract step is a real tar run. */
function fakeRunner(jobDir: string, blob: Buffer): ValidationRunner {
  return {
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      const hostPath = (containerPath: string): string =>
        path.join(jobDir, path.relative("/job", containerPath));
      if (invocation.label.startsWith("download-")) {
        const destination = hostPath(invocation.args[3]!);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, blob);
        return { code: 0, output: "", timedOut: false };
      }
      if (invocation.label.startsWith("extract-")) {
        const archive = hostPath(invocation.args[2]!);
        const destination = hostPath(invocation.args[3]!);
        fs.mkdirSync(destination, { recursive: true });
        execFileSync("tar", ["--extract", "--file", archive, "--directory", destination]);
        return { code: 0, output: "", timedOut: false };
      }
      throw new Error(`unexpected invocation ${invocation.label}`);
    },
    async verifyRuntime(): Promise<void> {},
  };
}

describe("container dependency-capture materialization", () => {
  it("downloads, verifies, and lays out a capture read-only with /deps link targets", async () => {
    const { blob, capture } = captureFixture();
    const jobDir = temporary("lax-materialize-job-");
    const materialized = await materializeDependencyCaptures(
      [dependencyWith(capture)],
      jobDir,
      fakeRunner(jobDir, blob),
      DEFAULT_LIMITS,
    );
    const base = path.join(jobDir, "dependencies", "lax-7");
    expect(materialized.get("lax-7")).toBe(base);
    const olean = path.join(base, "concepts", "lib", "Lax7.olean");
    expect(fs.existsSync(olean)).toBe(true);
    // read-only: no downstream compile can alter the verified artifacts
    expect(fs.statSync(olean).mode & 0o222).toBe(0);
    // the canonical lake layout link points at the in-container /deps mount
    const link = path.join(base, "concepts", "package", ".lake", "build", "lib", "lean");
    expect(fs.readlinkSync(link)).toBe("/deps/lax-7/concepts/lib");
    // the downloaded archive never outlives materialization
    expect(fs.readdirSync(path.join(jobDir, "downloads"))).toEqual([]);
    // the sealed tree needs the write bits restored before removal — the
    // same cleanup the trusted job runs
    removeValidationWorkspace(jobDir);
    expect(fs.existsSync(jobDir)).toBe(false);
  });

  it("fails closed on a tampered blob before any extraction", async () => {
    const { blob, capture } = captureFixture();
    const tampered = Buffer.from(blob);
    tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
    const jobDir = temporary("lax-materialize-job-");
    await expect(
      materializeDependencyCaptures(
        [dependencyWith(capture)],
        jobDir,
        fakeRunner(jobDir, tampered),
        DEFAULT_LIMITS,
      ),
    ).rejects.toThrow("capture archive digest mismatch for lax-7");
    expect(fs.existsSync(path.join(jobDir, "dependencies", "lax-7", "concepts"))).toBe(false);
  });

  it("fails closed when the extracted files do not match the record's inventory", async () => {
    const { blob, capture } = captureFixture();
    // outer digest matches the blob, but the record declares a different hash
    // for one file — per-file verification must catch it
    const lying: PublishedCapture = {
      ...capture,
      files: capture.files.map((file) =>
        file.path.endsWith(".olean") ? { ...file, sha256: "b".repeat(64) } : file),
    };
    const jobDir = temporary("lax-materialize-job-");
    await expect(
      materializeDependencyCaptures(
        [dependencyWith(lying)],
        jobDir,
        fakeRunner(jobDir, blob),
        DEFAULT_LIMITS,
      ),
    ).rejects.toThrow("dependency capture file failed verification: concepts/lib/Lax7.olean");
  });
});
