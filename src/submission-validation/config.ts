import lock from "./runtime/validation-runtime.lock.json" with { type: "json" };
import type { ValidationRuntimeIdentity } from "./contracts.js";
import { ValidationError } from "../shared/validation.js";

export interface ValidationLimits {
  fetchTimeoutMs: number;
  compileTimeoutMs: number;
  checkTimeoutMs: number;
  maxOutputBytes: number;
  maxWorkspaceBytes: number;
  maxWorkspaceEntries: number;
  minFreeDiskBytes: number;
  memoryBytes: number;
  cpuCount: number;
  leanThreads: number;
  pids: number;
}

export const DEFAULT_LIMITS: ValidationLimits = {
  fetchTimeoutMs: 10 * 60_000,
  compileTimeoutMs: 30 * 60_000,
  checkTimeoutMs: 20 * 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxWorkspaceBytes: 20 * 1024 * 1024 * 1024,
  maxWorkspaceEntries: 1_000_000,
  minFreeDiskBytes: 5 * 1024 * 1024 * 1024,
  memoryBytes: 16 * 1024 * 1024 * 1024,
  cpuCount: 4,
  leanThreads: 2,
  pids: 1_024,
};

export const RUNTIME_PATHS = {
  warmWorkspace: "/opt/lax-runtime/warm",
  leanBin: "/opt/lean/bin",
  leanchecker: "/opt/lean/bin/leanchecker",
  inspector: "/opt/lax-runtime/bin/laxinspector",
  runtimeManifest: "/opt/lax-runtime/runtime-manifest.json",
} as const;

export function configuredRuntime(
  image = process.env.LAX_VALIDATION_IMAGE,
  options: { allowLocalImageId?: boolean } = {},
): ValidationRuntimeIdentity {
  if (image === undefined || image === "") {
    throw new ValidationError("LAX_VALIDATION_IMAGE must pin the validation runtime by digest");
  }
  const match = /@sha256:([0-9a-f]{64})$/u.exec(image);
  const local = options.allowLocalImageId === true ? /^sha256:([0-9a-f]{64})$/u.exec(image) : null;
  if (match === null && local === null) {
    throw new ValidationError("LAX_VALIDATION_IMAGE must end in an immutable @sha256 digest");
  }
  return {
    image,
    imageDigest: (match ?? local)![1]!,
    layoutVersion: lock.layoutVersion,
    leanToolchain: lock.leanToolchain,
    leanVersion: lock.leanVersion,
    mathlibRepository: lock.mathlibRepository,
    mathlibCommit: lock.mathlibCommit,
  };
}
