import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type {
  CaptureManifest,
  CapturedFile,
  ModuleInventory,
  ValidationRuntimeIdentity,
} from "../contracts.js";
import type { ContainerRunner } from "../sandbox/container.js";

const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

export function capturePackage(
  kind: "concepts" | "proofs",
  pristineSubmissionRoot: string,
  compiledSubmissionRoot: string,
  provisionedManifest: string,
  inventory: ModuleInventory,
  captureRoot: string,
): void {
  const library = path.join(compiledSubmissionRoot, kind, ".lake", "build", "lib", "lean");
  const packageSource = path.join(pristineSubmissionRoot, kind);
  const capturedSource = path.join(captureRoot, kind, "package");
  copyPackageSource(packageSource, capturedSource);
  fs.writeFileSync(path.join(capturedSource, "lake-manifest.json"), provisionedManifest, { mode: 0o444 });
  for (const moduleName of [inventory.rootModule, ...inventory.modules]) {
    const relative = `${moduleName.split(".").join("/")}.olean`;
    const source = path.join(library, relative);
    if (!regularContainedArtifact(library, source)) {
      throw new Error(`compiled artifact is missing or unsafe for module ${moduleName}`);
    }
    const destination = path.join(captureRoot, kind, "lib", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o444);
  }
}

function regularContainedArtifact(library: string, filename: string): boolean {
  try {
    // Authored IO controls everything below the writable .lake directory.
    // Reject direct links and ancestor links that redirect outside it.
    if (!fs.lstatSync(filename).isFile()) return false;
    const buildRoot = fs.realpathSync(path.resolve(library, "../../.."));
    const actual = fs.realpathSync(filename);
    return actual.startsWith(`${buildRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function copyPackageSource(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (filename) => {
      const relative = path.relative(source, filename);
      if (relative === "") return true;
      const parts = relative.split(path.sep);
      return !parts.includes(".lake") && !parts.includes(".git") && path.basename(filename) !== "build-output.json";
    },
  });
}

export async function sealCapture(
  captureRoot: string,
  archivePath: string,
  sourceCommit: string,
  runtime: ValidationRuntimeIdentity,
  runner: ContainerRunner,
  limits: ValidationLimits,
): Promise<CaptureManifest> {
  const files = inventoryFiles(captureRoot);
  if (files.length === 0) throw new Error("cannot seal an empty artifact capture");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  fs.rmSync(archivePath, { force: true });
  const result = await runner.run({
    label: "seal-capture",
    args: [
      "tar",
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=ustar",
      "-cf",
      `/output/${path.basename(archivePath)}`,
      "-C",
      "/capture",
      ".",
    ],
    mounts: [
      { source: captureRoot, target: "/capture" },
      { source: path.dirname(archivePath), target: "/output", writable: true },
    ],
    timeoutMs: limits.checkTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) throw new Error(`could not seal artifact capture: ${result.output.trim()}`);
  const digest = sha256File(archivePath);
  return {
    formatVersion: 1,
    digest,
    sourceCommit,
    leanToolchain: runtime.leanToolchain,
    mathlibCommit: runtime.mathlibCommit,
    files,
  };
}

/** Describe a local build capture without producing the publishable tar archive. */
export function describeLocalCapture(
  captureRoot: string,
  sourceCommit: string,
  runtime: ValidationRuntimeIdentity,
): CaptureManifest {
  const files = inventoryFiles(captureRoot);
  if (files.length === 0) throw new Error("cannot describe an empty artifact capture");
  const digest = createHash("sha256")
    .update(JSON.stringify(files), "utf8")
    .digest("hex");
  return {
    formatVersion: 1,
    digest,
    sourceCommit,
    leanToolchain: runtime.leanToolchain,
    mathlibCommit: runtime.mathlibCommit,
    files,
  };
}

function inventoryFiles(root: string): CapturedFile[] {
  const result: CapturedFile[] = [];
  let totalBytes = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("capture contains a symbolic link");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        const relative = path.relative(root, filename).split(path.sep).join("/");
        const stat = fs.statSync(filename);
        totalBytes += stat.size;
        if (result.length >= MAX_CAPTURE_FILES) throw new Error(`capture contains more than ${MAX_CAPTURE_FILES} files`);
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CAPTURE_BYTES)
          throw new Error("capture exceeds 2 GiB");
        result.push({ path: relative, bytes: stat.size, sha256: sha256File(filename) });
      } else throw new Error("capture contains a non-regular filesystem entry");
    }
  };
  walk(root);
  return result;
}

function sha256File(filename: string): string {
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
