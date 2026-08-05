// The archive environment pins used by the host (no-container) `lax build`
// path: the toolchain and mathlib revision every submission builds against.
//
// The values are read from runtime/validation-runtime.lock.json — the same
// reviewed lock that pins the CI container image — so the host path and the
// trusted container path can never disagree. The lock file carries a pointer
// back here; stage 3 (removing the custom runtime image) makes this module
// the single home of the pins.
//
// Test/dev seam: LAX_MATHLIB_URL/LAX_MATHLIB_REV substitute a small local
// "mathlib" so the fast tests exercise the real warm-store and seeding
// machinery without downloading gigabytes. Never set in production.

import lock from "./runtime/validation-runtime.lock.json" with { type: "json" };
import type { ValidationRuntimeIdentity } from "./contracts.js";

export const LEAN_VERSION = lock.leanVersion;
export const LEAN_TOOLCHAIN = lock.leanToolchain;

export const MATHLIB_URL = process.env.LAX_MATHLIB_URL ?? lock.mathlibRepository;
export const MATHLIB_REV = process.env.LAX_MATHLIB_REV ?? lock.mathlibCommit;

/**
 * The runtime identity of a host-toolchain build. There is no container
 * image, so the image fields carry the literal "host" marker; the pin fields
 * are the same archive pins the container manifest asserts.
 */
export function hostValidationRuntime(): ValidationRuntimeIdentity {
  return {
    image: "host",
    imageDigest: "host",
    layoutVersion: lock.layoutVersion,
    leanToolchain: LEAN_TOOLCHAIN,
    leanVersion: LEAN_VERSION,
    mathlibRepository: MATHLIB_URL,
    mathlibCommit: MATHLIB_REV,
  };
}
