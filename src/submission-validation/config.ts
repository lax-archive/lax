import {
  LAYOUT_VERSION,
  LEAN_TOOLCHAIN,
  LEAN_VERSION,
  MATHLIB_REV,
  MATHLIB_URL,
  VALIDATION_IMAGE,
  VALIDATION_IMAGE_DIGEST,
} from "./pins.js";
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
  // Replay/Inspect worker budget. Measured 2026-08-05 (rewrite-plan.md
  // red-team addendum point 1): one full-mathlib environment import is
  // ~5.6 GiB and leanchecker holds one per concurrent task, so 2 threads
  // peak at ~11-12 GiB — the most a 16 GB swapless hosted runner fits.
  // Replay and Inspect must also never run concurrently with each other.
  leanThreads: 2,
  pids: 1_024,
};

/**
 * Stable in-container paths of the read-only runtime mounts ContainerRunner
 * adds to every invocation (see sandbox/layout.ts for the host-side sources).
 * sandbox/tools/run-check.mjs hardcodes the same strings — it runs inside the
 * container and cannot import this module; keep the two in step.
 */
export const RUNTIME_PATHS = {
  toolchain: "/opt/lax/toolchain",
  leanBin: "/opt/lax/toolchain/bin",
  leanchecker: "/opt/lax/toolchain/bin/leanchecker",
  warmWorkspace: "/opt/lax/warm",
  tools: "/opt/lax/bin",
  inspectorDir: "/opt/lax/inspector",
  inspector: "/opt/lax/inspector/laxinspector",
} as const;

/**
 * The trusted container runtime identity. It comes from the reviewed pins —
 * no environment variable is required, and the trusted workflow sets none. A
 * narrow override remains for smoke-testing a candidate image before a pin
 * bump: the override must itself be digest-pinned, so it can never weaken the
 * immutability guarantee, only point it elsewhere. Never set in production.
 */
export function configuredRuntime(
  image = process.env.LAX_VALIDATION_IMAGE,
): ValidationRuntimeIdentity {
  let imageDigest = VALIDATION_IMAGE_DIGEST;
  if (image === undefined || image === "") {
    image = VALIDATION_IMAGE;
  } else {
    const match = /@sha256:([0-9a-f]{64})$/u.exec(image);
    if (match === null) {
      throw new ValidationError("LAX_VALIDATION_IMAGE must end in an immutable @sha256 digest");
    }
    imageDigest = match[1]!;
  }
  return {
    image,
    imageDigest,
    layoutVersion: LAYOUT_VERSION,
    leanToolchain: LEAN_TOOLCHAIN,
    leanVersion: LEAN_VERSION,
    mathlibRepository: MATHLIB_URL,
    mathlibCommit: MATHLIB_REV,
  };
}
