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

/**
 * The image a declared paper is compiled in (paper-plan.md, "Trusted
 * compile"): a full historic TeX Live, so every package an author's own
 * build knows is present and the text layer gets real fonts. Pulled on
 * demand, only for paper-bearing submissions — measured at 93 s on a hosted
 * runner (5.49 GB). It carries no Lean and mounts none of the Lean runtime;
 * the marker package rides in read-only from `assets/tex/`.
 */
export const PAPER_IMAGE_NAME = "texlive/texlive:TL2025-historic";
/** Manifest digest of PAPER_IMAGE_NAME (a single-platform manifest — resolve
 * a new one with `docker manifest inspect` on a pin bump). */
export const PAPER_IMAGE_DIGEST =
  "f25ee2dcd00f58198f918064f4a1c8562410b33e84155bd55b02b419d73d9391";
export const PAPER_IMAGE = `${PAPER_IMAGE_NAME}@sha256:${PAPER_IMAGE_DIGEST}`;

/**
 * The ReflowTeX fork behind the paper web view (paper-web-plan.md stage 1):
 * the node-list serializer and encode pipeline that derive a paper's
 * reflowable HTML bundle. `lax-archive/reflowtex` is our fork of
 * `radek-p/reflowtex`; its `lax` branch carries the marker-capture,
 * schema, sanitizer, and determinism commits (see the fork's FORK.md) on
 * top of upstream 36f8365. Consumed at this rev by `reflowtex/fetch.mjs`
 * (`npm run reflowtex:fetch`) — AGPL bytes never enter the npm tarball; see
 * `reflowtex/README.md`. fetch.mjs parses these two constants, so this
 * module stays the single source of truth.
 *
 * This rev adds the `image` element with magic-number-checked PNG/JPEG
 * data URIs to the sanitizer and lets the encode consume a pre-converted
 * `<src>.svg` with no `<src>.pdf` beside it (the `\includegraphics`
 * slots), plus a comment on what the dvisvgm seam is for now.
 */
export const REFLOWTEX_URL = "https://github.com/lax-archive/reflowtex";
export const REFLOWTEX_REV = "61dc460c117a7ab121d761563bef8e3f91610956";

/**
 * PyMuPDF, the paper web view's picture converter (TODO.md, "Transparency in
 * a tikz picture"): the wheel `reflowtex/fetch.mjs` downloads, verifies, and
 * unpacks beside the fork, and `paper/web-container.ts` mounts read-only into
 * the pinned TeX Live image so the in-image export step can turn every
 * picture PDF straight into vector SVG.
 *
 * The image itself carries no PDF-reading library the conversion can use:
 * dvisvgm's `--pdf` input needs Ghostscript < 10.01 or mutool and the image
 * has Ghostscript 10.07 and no mutool, and the `gs -sDEVICE=eps2write` detour
 * rasterizes every page with transparency (measured 2026-09-03 on lax-65).
 * MuPDF reads the PDF directly and keeps `fill-opacity`/`stroke-opacity`, at
 * a quarter of the flattened output's size.
 *
 * The pin is a *binary* wheel, so it is platform-specific by construction:
 * `manylinux_2_28_x86_64`, matching the single-platform amd64 TeX image it is
 * mounted into. It never enters the fork's venv (that one is the encode
 * host's) and never enters the npm tarball. On a bump, take the URL and the
 * sha256 from PyPI's per-file digests, exactly as `requirements.lock` is
 * regenerated.
 */
export const PYMUPDF_VERSION = "1.28.2";
export const PYMUPDF_WHEEL = "pymupdf-1.28.2-cp310-abi3-manylinux_2_28_x86_64.whl";
export const PYMUPDF_URL = "https://files.pythonhosted.org/packages/c7/06/dace3e27af26690cb20bead80dbac42941b0841eb689b8aabbd67dde16f0/pymupdf-1.28.2-cp310-abi3-manylinux_2_28_x86_64.whl";
export const PYMUPDF_SHA256 = "397d6715c1f0df7548a92d0afd8ce370fc48fa47aeefac16be2bc04a16a8227f";

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
