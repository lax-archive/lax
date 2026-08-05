import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { PublishedCapture, ResolvedDependency } from "../contracts.js";
import type { ValidationRunner } from "../sandbox/container.js";

/** Deduplicate the resolved captures by submission and enforce the aggregate
 * declared-size budget; shared by the container and host materializers. */
export function capturesBySubmission(
  dependencies: ResolvedDependency[],
  limits: ValidationLimits,
): Map<string, PublishedCapture> {
  const bySubmission = new Map<string, PublishedCapture>();
  for (const dependency of dependencies) {
    if (dependency.capture === undefined) continue;
    const previous = bySubmission.get(dependency.submissionId);
    if (previous !== undefined && previous.digest !== dependency.capture.digest)
      throw new Error(`dependency ${dependency.submissionId} resolves to conflicting artifact captures`);
    bySubmission.set(dependency.submissionId, dependency.capture);
  }
  let declaredBytes = 0;
  for (const capture of bySubmission.values()) {
    for (const file of capture.files) {
      declaredBytes += file.bytes;
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.maxWorkspaceBytes) {
        throw new Error("dependency captures exceed the aggregate validation workspace limit");
      }
    }
  }
  return bySubmission;
}

export async function materializeDependencyCaptures(
  dependencies: ResolvedDependency[],
  jobDir: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<Map<string, string>> {
  const bySubmission = capturesBySubmission(dependencies, limits);
  const materialized = await mapConcurrent(
    [...bySubmission],
    4,
    async ([id, capture]): Promise<[string, string]> => {
      const base = path.join(jobDir, "dependencies", id);
      const archiveName = `${id}-${capture.digest}.tar`;
      const archive = path.join(jobDir, "downloads", archiveName);
      fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
      try {
        const download = await runner.run({
          label: `download-${id}`,
          args: ["node", "/opt/lax/bin/download-capture.mjs", capture.registryBlob, `/job/downloads/${archiveName}`],
          mounts: [{ source: jobDir, target: "/job", writable: true }],
          network: true,
          timeoutMs: limits.fetchTimeoutMs,
          maxOutputBytes: limits.maxOutputBytes,
        });
        if (download.code !== 0) throw new Error(`could not download capture for ${id}: ${download.output.trim()}`);
        if (sha256File(archive) !== capture.digest) throw new Error(`capture archive digest mismatch for ${id}`);
        const extract = await runner.run({
          label: `extract-${id}`,
          args: ["node", "/opt/lax/bin/extract-capture.mjs", `/job/downloads/${archiveName}`, `/job/dependencies/${id}`],
          mounts: [{ source: jobDir, target: "/job", writable: true }],
          timeoutMs: 60_000,
          maxOutputBytes: limits.maxOutputBytes,
        });
        if (extract.code !== 0) throw new Error(`could not extract capture for ${id}: ${extract.output.trim()}`);
        verifyFiles(base, capture);
        makeCapturedPackagesUsable(base, (kind, tree) => `/deps/${id}/${kind}/${tree}`);
        makeReadOnly(base);
        return [id, base];
      } finally {
        fs.rmSync(archive, { force: true });
      }
    },
  );
  return new Map(materialized);
}

export async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

/**
 * Give an extracted capture the canonical Lake build layout: link each
 * package's `.lake/build/lib/lean` at the capture's `lib` directory and its
 * `.lake/build/ir` at the capture's `ir` directory (the link targets are
 * container-absolute in the trusted pipeline and host-absolute in the host
 * pipeline) and refresh artifact mtimes so Lake treats them as newer than
 * the captured sources.
 */
export function makeCapturedPackagesUsable(
  root: string,
  linkTarget: (kind: "concepts" | "proofs", tree: "lib" | "ir") => string,
): void {
  for (const kind of ["concepts", "proofs"] as const) {
    const packageRoot = path.join(root, kind, "package");
    const library = path.join(root, kind, "lib");
    if (!fs.existsSync(packageRoot) || !fs.existsSync(library)) continue;
    const target = path.join(packageRoot, ".lake", "build", "lib", "lean");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(linkTarget(kind, "lib"), target);
    touchTree(library);
    const ir = path.join(root, kind, "ir");
    if (fs.existsSync(ir)) {
      fs.symlinkSync(linkTarget(kind, "ir"), path.join(packageRoot, ".lake", "build", "ir"));
      touchTree(ir);
    }
  }
}

function touchTree(directory: string): void {
  const now = new Date();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) touchTree(filename);
    else if (entry.isFile()) fs.utimesSync(filename, now, now);
  }
}

export function verifyFiles(root: string, capture: PublishedCapture): void {
  const expected = new Map(capture.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("dependency capture contains a symlink");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        const relative = path.relative(root, filename).split(path.sep).join("/");
        const specification = expected.get(relative);
        if (specification === undefined) throw new Error(`dependency capture has unexpected file ${relative}`);
        const stat = fs.statSync(filename);
        if (stat.size !== specification.bytes || sha256File(filename) !== specification.sha256)
          throw new Error(`dependency capture file failed verification: ${relative}`);
        seen.add(relative);
      } else throw new Error("dependency capture contains a non-regular entry");
    }
  };
  walk(root);
  if (seen.size !== expected.size) throw new Error("dependency capture is missing declared files");
}

export function makeReadOnly(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) makeReadOnly(filename);
    else if (entry.isFile()) fs.chmodSync(filename, 0o444);
  }
  fs.chmodSync(directory, 0o555);
}

export function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}
