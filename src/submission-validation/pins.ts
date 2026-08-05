// The archive environment pins: the single home of every value that fixes
// what a submission builds against and where it runs. Both validation paths
// read them — the host (no-container) `lax build` path and the trusted
// container path — so the two can never disagree.
//
// The trusted sandbox is a *stock* image pinned by digest plus a VM-installed
// toolchain and warm mathlib workspace mounted read-only into it; there is no
// custom runtime image, Containerfile, or lock file any more. A pin bump is
// an ordinary reviewed edit of this module.
//
// Test/dev seam: LAX_MATHLIB_URL/LAX_MATHLIB_REV substitute a small local
// "mathlib" so the fast tests exercise the real warm-store and seeding
// machinery without downloading gigabytes. Never set in production.

import type { ValidationRuntimeIdentity } from "./contracts.js";

export const LEAN_VERSION = "v4.30.0";
export const LEAN_TOOLCHAIN = "leanprover/lean4:v4.30.0";

export const MATHLIB_URL =
  process.env.LAX_MATHLIB_URL ?? "https://github.com/leanprover-community/mathlib4";
export const MATHLIB_REV =
  process.env.LAX_MATHLIB_REV ?? "c5ea00351c28e24afc9f0f84379aa41082b1188f";

/** Commit of leanprover/elan whose `elan-init.sh` installs elan on the VM —
 * the same installer pin the deleted runtime image used. */
export const ELAN_COMMIT = "3d5138e1526a569a23901b8ee559032793cf445e";

/** The stock container image every trusted sandbox phase runs in. It only has
 * to provide node, tar, and a glibc base: the Lean toolchain and the warm
 * mathlib workspace are installed on the VM and bind-mounted read-only. Pulled
 * from Docker Hub — no Dockerfile, no apt install, no registry login. */
export const VALIDATION_IMAGE_NAME = "node:22-bookworm-slim";
/** linux/amd64 manifest digest of VALIDATION_IMAGE_NAME (resolve a new one
 * with `docker manifest inspect` on a pin bump). */
export const VALIDATION_IMAGE_DIGEST =
  "a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066";
/** The digest-pinned reference docker pulls and runs. */
export const VALIDATION_IMAGE = `${VALIDATION_IMAGE_NAME}@sha256:${VALIDATION_IMAGE_DIGEST}`;

/** Version of the validation runtime layout recorded in reports and captures.
 * The capture layout (concepts|proofs → package/, lib/) is unchanged from the
 * baked-image era, so the version stays 1. */
export const LAYOUT_VERSION = 1;

/**
 * The runtime identity of a host-toolchain build. There is no container
 * image, so the image fields carry the literal "host" marker; the pin fields
 * are the same archive pins the container path asserts.
 */
export function hostValidationRuntime(): ValidationRuntimeIdentity {
  return {
    image: "host",
    imageDigest: "host",
    layoutVersion: LAYOUT_VERSION,
    leanToolchain: LEAN_TOOLCHAIN,
    leanVersion: LEAN_VERSION,
    mathlibRepository: MATHLIB_URL,
    mathlibCommit: MATHLIB_REV,
  };
}
