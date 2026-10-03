import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type {
  CaptureManifest,
  CapturedFile,
  ContentSpecVersion,
  ModuleInventory,
  ValidationRuntimeIdentity,
} from "../contracts.js";
import { sealTar } from "../certify/bundle.js";
import type { ValidationRunner } from "../sandbox/container.js";
import {
  containerBoundaryFailure,
  infrastructureFailure,
  resourceLimitFailure,
  submissionFailure,
} from "../failures.js";
import { copyPackageInputs } from "../phases/package-files.js";

const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

export function capturePackage(
  kind: "concepts" | "proofs",
  pristineSubmissionRoot: string,
  compiledLibrary: string,
  provisionedManifest: string,
  inventory: ModuleInventory,
  captureRoot: string,
): void {
  const packageSource = path.join(pristineSubmissionRoot, kind);
  const capturedSource = path.join(captureRoot, kind, "package");
  copyPackageInputs(packageSource, capturedSource, inventory.packageName);
  fs.writeFileSync(path.join(capturedSource, "lake-manifest.json"), provisionedManifest, { mode: 0o444 });
  const modules = [inventory.rootModule, ...inventory.modules];
  const olean = (moduleName: string): string =>
    path.join(compiledLibrary, `${moduleName.split(".").join("/")}.olean`);
  // Diagnose the whole inventory before copying anything: the container path
  // carries no self-heal, so this message is the author's only clue.
  const unusable = modules.filter((moduleName) => !regularContainedArtifact(compiledLibrary, olean(moduleName)));
  if (unusable.length > 0) throw missingArtifacts(inventory, unusable);
  for (const moduleName of modules) {
    const moduleBase = moduleName.split(".").join("/");
    const relative = `${moduleBase}.olean`;
    const source = path.join(compiledLibrary, relative);
    // Re-checked immediately before the copy that trusts it, so the guard is
    // never separated from its use.
    if (!regularContainedArtifact(compiledLibrary, source)) throw missingArtifacts(inventory, [moduleName]);
    const destination = path.join(captureRoot, kind, "lib", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o444);
    // Lake decides whether a path dependency's module is up to date from its
    // stored build metadata and the full recorded output set — `<mod>.trace`,
    // the `.hash`/`.ilean` companions, and the C artifacts under
    // `.lake/build/ir` — not from the olean alone: with any of them missing a
    // downstream `lake build` tries to rebuild the read-only capture and
    // fails (verified empirically at the pinned v4.30.0; lake even rewrites a
    // missing `.c.hash` in place, so it must ship too). Capture whichever
    // companions the build produced; only the olean is mandatory.
    for (const suffix of [".olean.hash", ".ilean", ".ilean.hash", ".trace"]) {
      copyCompanion(
        path.join(compiledLibrary, `${moduleBase}${suffix}`),
        compiledLibrary,
        path.join(captureRoot, kind, "lib", `${moduleBase}${suffix}`),
      );
    }
    const compiledIr = path.resolve(compiledLibrary, "../../ir");
    for (const suffix of [".c", ".c.hash"]) {
      copyCompanion(
        path.join(compiledIr, `${moduleBase}${suffix}`),
        compiledLibrary,
        path.join(captureRoot, kind, "ir", `${moduleBase}${suffix}`),
      );
    }
  }
}

function missingArtifacts(inventory: ModuleInventory, modules: string[]): Error {
  return submissionFailure(
    `compiled artifact is missing or unsafe for ${modules.length === 1 ? "module" : "modules"} ` +
      `${modules.join(", ")} of package ${inventory.packageName}; root module ` +
      `${inventory.rootModule} must import exactly the other modules of its package, so a ` +
      "module outside the root's import closure is never built",
  );
}

function copyCompanion(source: string, compiledLibrary: string, destination: string): void {
  if (!fs.existsSync(source) || !regularContainedArtifact(compiledLibrary, source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o444);
}

function regularContainedArtifact(compiledLibrary: string, filename: string): boolean {
  try {
    // Authored IO controls everything below the writable .lake directory.
    // Reject direct links and ancestor links that redirect outside it.
    if (!fs.lstatSync(filename).isFile()) return false;
    const buildRoot = fs.realpathSync(path.resolve(compiledLibrary, "../../.."));
    const actual = fs.realpathSync(filename);
    return actual.startsWith(`${buildRoot}${path.sep}`);
  } catch {
    return false;
  }
}

/** The `references.tar` a spec-2 record pushes beside its capture, written
 * next to the capture tar by sealCapture and describeLocalCapture. */
export const REFERENCES_FILENAME = "references.tar";

/** The members of the `references` layer: the concept sources and their
 * `.ilean` files, in inventory (path) order, named `./<path>` as the
 * capture tar names them. */
function referenceMembers(captureRoot: string, files: readonly CapturedFile[]): Array<{ name: string; content: Buffer }> {
  return files
    .filter((file) =>
      (file.path.startsWith("concepts/package/") && file.path.endsWith(".lean")) ||
      (file.path.startsWith("concepts/lib/") && file.path.endsWith(".ilean")))
    .map((file) => ({ name: `./${file.path}`, content: fs.readFileSync(path.join(captureRoot, file.path)) }));
}

/**
 * The spec-2 additions to a capture manifest (contracts.ts CaptureManifest):
 * the tar's size and member count, and the `references` layer, which is
 * sealed here and written to `referencesPath`.
 */
function captureSummary(
  captureRoot: string,
  files: readonly CapturedFile[],
  tarBytes: number,
  referencesPath: string,
): Pick<CaptureManifest, "bytes" | "fileCount" | "references"> {
  const sealed = sealTar(referenceMembers(captureRoot, files));
  fs.writeFileSync(referencesPath, sealed.tar, { mode: 0o600 });
  return {
    bytes: tarBytes,
    fileCount: files.length,
    references: { digest: sealed.digest, bytes: sealed.tar.length },
  };
}

export async function sealCapture(
  captureRoot: string,
  archivePath: string,
  sourceCommit: string,
  runtime: ValidationRuntimeIdentity,
  runner: ValidationRunner,
  limits: ValidationLimits,
  /** The record's content spec: a spec-2 capture is summarised and gets its
   * `references` layer (written beside the tar); a spec-1 one is unchanged. */
  spec: ContentSpecVersion = 1,
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
  if (result.code !== 0) {
    const boundary = containerBoundaryFailure(
      result,
      "sealing the artifact capture exceeded its time limit",
      "sealing the artifact capture exceeded its memory limit",
    );
    if (boundary !== undefined) throw boundary;
    throw infrastructureFailure(`could not seal artifact capture: ${result.output.trim()}`);
  }
  const digest = sha256File(archivePath);
  return {
    formatVersion: 1,
    digest,
    sourceCommit,
    leanToolchain: runtime.leanToolchain,
    mathlibCommit: runtime.mathlibCommit,
    files,
    ...(spec === 2
      ? captureSummary(captureRoot, files, fs.statSync(archivePath).size, path.join(path.dirname(archivePath), REFERENCES_FILENAME))
      : {}),
  };
}

/** Describe a local build capture without producing the publishable tar
 * archive. A spec-2 description still seals its `references` layer (a few
 * KB) into `referencesPath`, so the local record has the record's shape;
 * `bytes` is the inventory's total, as there is no tar. */
export function describeLocalCapture(
  captureRoot: string,
  sourceCommit: string,
  runtime: ValidationRuntimeIdentity,
  spec: ContentSpecVersion = 1,
  referencesPath = path.join(captureRoot, "..", REFERENCES_FILENAME),
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
    ...(spec === 2
      ? captureSummary(captureRoot, files, files.reduce((total, file) => total + file.bytes, 0), referencesPath)
      : {}),
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
        if (result.length >= MAX_CAPTURE_FILES) {
          throw resourceLimitFailure(`capture contains more than ${MAX_CAPTURE_FILES} files`);
        }
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CAPTURE_BYTES)
          throw resourceLimitFailure("capture exceeds 2 GiB");
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
