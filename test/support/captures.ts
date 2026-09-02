// "Publish a local capture": the test-side twin of the trusted publish path
// for cross-submission dependency tests. Runs a host build of an upstream
// submission, seals its capture root into the deterministic tar the trusted
// job produces (captures/seal.ts sealCapture, minus the container), pushes it
// through the real GhcrCaptureStore to the fake registry (test/fake-ghcr.ts,
// via the LAX_CAPTURE_REGISTRY_URL seam the caller must have set), and writes
// the lax-database record/build-output pair a downstream resolution reads.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { GhcrCaptureStore } from "../../src/shared/capture-store.js";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import type {
  PublishedCapture,
  ValidationReport,
} from "../../src/submission-validation/contracts.js";
import { buildOnHost, tmpDir } from "./host.js";

export interface PublishedUpstream {
  id: string;
  source: { repository: string; commit: string; folder: string };
  report: ValidationReport;
  published: PublishedCapture;
}

/** Build `root` on the host, seal and push its capture to the fake registry,
 * and return everything a database record needs to reference it. `archive`
 * carries the upstream's own dependencies for chained submissions. */
export async function publishLocalCapture(
  id: string,
  root: string,
  repository: string,
  archive?: ArchiveSnapshot,
): Promise<PublishedUpstream> {
  const jobDir = path.join(tmpDir("lax-upstream-job-"), "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const report = await buildOnHost(root, { id, repository, jobDir, archive });
  if (!report.ok || report.capture === undefined || report.buildOutput === undefined) {
    throw new Error(`upstream build failed:\n${JSON.stringify(report.violations, null, 2)}`);
  }
  const tarPath = path.join(tmpDir("lax-capture-tar-"), "capture.tar");
  execFileSync("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=ustar",
    "-cf",
    tarPath,
    "-C",
    path.join(jobDir, "capture"),
    ".",
  ]);
  // The record's capture digest is the sealed tar's — describeLocalCapture's
  // inventory hash never leaves the local build.
  const manifest = { ...report.capture, digest: sha256File(tarPath) };
  const store = new GhcrCaptureStore("fake-registry-credential", CAPTURES_REPOSITORY);
  const source = report.request.source;
  const { capture: published } = await store.promote(id, source, manifest, tarPath);
  return { id, source, report, published };
}

/** Write the `record.json` + `build-output.json` pair for a published
 * upstream into `archiveRoot`, the shape archive/snapshot.ts loads. */
export function registerUpstream(
  archiveRoot: string,
  upstream: PublishedUpstream,
  state: "draft" | "registered" = "registered",
): void {
  const directory = path.join(archiveRoot, upstream.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "record.json"),
    JSON.stringify({ id: upstream.id, specVersion: "1", state, source: upstream.source }),
  );
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({
      id: upstream.id,
      specVersion: "1",
      ...upstream.report.buildOutput,
      capture: upstream.published,
    }),
  );
}

/** An Archive snapshot holding the given published upstreams. */
export function archiveWith(
  ...upstreams: Array<PublishedUpstream | [PublishedUpstream, "draft" | "registered"]>
): ArchiveSnapshot {
  const root = tmpDir("lax-archive-");
  for (const entry of upstreams) {
    const [upstream, state] = Array.isArray(entry) ? entry : [entry, "registered" as const];
    registerUpstream(root, upstream, state);
  }
  return new ArchiveSnapshot(root, "a".repeat(40));
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
