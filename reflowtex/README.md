# The ReflowTeX fork (paper web view)

This directory is stage 1 of `paper-web-plan.md`: the consumer side of our
fork of [ReflowTeX](https://github.com/radek-p/reflowtex) — the LuaTeX
node-list serializer and the Python encode pipeline — that derives the
reflowable HTML view of a declared paper. The fork itself lives at
[`lax-archive/reflowtex`](https://github.com/lax-archive/reflowtex); its
`lax` branch is upstream at 36f8365 plus one commit per changed file, and
its `FORK.md` describes them. In short, the fork adds exactly what the
stage-0 spike (`spike/paper/reflow/REPORT.md`) proved necessary:

- **Marker capture at three sites** (`src/extract/serializer.lua`):
  in-paragraph whatsits as `marker` nodes, shipout-walk whatsits as
  `marker` stream items (stock code silently drops every vertical-mode
  marker), the glyphless-resumed-paragraph hoist, and `last_flow`
  transparency so markers never perturb the walk's display-spacing logic.
- **Marker forms in the wire schema** (`src/schema/latex.proto`): a
  `marker` NodeType and a `marker` ItemKind, each with `side`/`n` — stock
  `encode_pb` dies with `KeyError: 'marker'` on a stream marker.
- **Encode hardening** (`src/encode/encode_pb.py`): prefer the
  fetch-regenerated `latex_pb2.py`, a loud error on unknown enum values,
  and `serialize_document()` with explicit deterministic serialization.
- **Transforms** (`src/encode/transforms.py`): markers survive
  `strip_unsupported_nodes`; every converted picture passes an
  element/attribute-allowlist SVG sanitizer (the web compile runs
  `-shell-escape` for tikz externalization, so a paper can emit arbitrary
  SVG through dvisvgm-raw specials — CSP is defense in depth, not the
  only wall), and the allowlist admits an `image` element whose
  `href` is an inline `data:` PNG or JPEG whose decoded bytes carry the
  matching magic number, so a raster `\includegraphics` can be shown;
  the dvisvgm invocation is injectable per call (`REFLOWTEX_DVISVGM`),
  which the trusted path uses to pin it *shut* — conversion happens
  inside the pinned TeX image right after the compile and the encode
  host has no converter at all; and a pre-converted `<src>.svg` is
  consumed as-is, with or without a PDF beside it (a plain
  `\includegraphics` has none), the sanitizer still applied to every
  consumed SVG.
- **Map-aware, injectable Type1 lookup** (`src/encode/t1_convert.py`):
  `find_outline` resolves a legacy 8-bit face the way the engines do,
  through its `pdftex.map` line — the outline plus, for a re-encoded
  face, its encoding vector (`ec-lmr10`, every lmodern/lipics paper's
  text face, is `lmr10.pfb` through `lm-ec.enc`; there is no
  `ec-lmr10.pfb`), and the conversion addresses slots by that vector. With
  `REFLOWTEX_PFB_DIR` set (read per call), `<name>.pfb` plus an optional
  `<name>.enc` in that directory are the only source — the trusted path
  exports both from the pinned image under the TeX name
  (`web-container.ts`), and a host tree must never silently substitute
  for a missed export; without it, kpsewhich as stock, but a host without
  kpsewhich yields the metric-box fallback instead of an uncaught crash
  (`fonts.provision` too, which also skips the serializer's `unknown`
  placeholder).
- **No run-time writes into the checkout** (`src/encode/pipeline.py`):
  `_ensure_pb2` only verifies — `latex_pb2.py` is regenerated at fetch
  time into `checkout/build/`, never into the (possibly read-only,
  digest-pinned) vendored tree. The stock mtime trigger rewrote it on a
  fresh clone.

## Usage

```sh
npm run reflowtex:fetch     # == node reflowtex/fetch.mjs
```

obtains the fork at the rev pinned in
`src/submission-validation/pins.ts` (`REFLOWTEX_URL` / `REFLOWTEX_REV` —
the single source of truth; `fetch.mjs` parses that module), installs the
hash-pinned Python environment into `venv/` from
`requirements.lock` (`pip install --require-hashes`; the venv is reused
while the lock is unchanged), regenerates `checkout/build/latex_pb2.py`
from the patched schema with grpcio-tools' bundled `protoc` (no apt
protoc), verifies the result — the marker forms present in the generated
module, which stock upstream lacks — and finally downloads the pinned
**PyMuPDF** wheel (`pins.ts`, `PYMUPDF_*`), checks its sha256 before
unpacking it into `pymupdf/lib/`, and leaves it there.

That last one is not part of the encode environment: it is the picture
converter the trusted export step bind-mounts read-only into the pinned TeX
image (`paper/web-container.ts`), because nothing in that image can read a
PDF without rasterizing it — dvisvgm needs a Ghostscript older than the one
it ships, and the Ghostscript detour that worked around that flattens every
transparent picture. So it is a `linux/amd64` wheel matching the image
rather than the machine that fetched it, it never enters `venv/`, and
`LAX_PYMUPDF_WHEEL=<path>` (read per call) substitutes a local copy of the
identical file, hash still enforced.

`LAX_REFLOWTEX_SOURCE=<path>` (read per call) substitutes a local git
checkout for the clone source — the pinned rev must exist in it; tests
use the reference clone this way. After a fetch, the consumable surfaces
are `checkout/src/extract/serializer.lua` (copied into each compile's job
directory — `assets/tex/laxreflow.sty` loads it with `dofile`),
`checkout/src/encode/` driven through `pipeline.Pipeline` or the
transforms/encode modules directly, `checkout/build/latex_pb2.py`, and
`pymupdf/lib/` (mounted into the export container, never imported here).

## Licensing posture

- ReflowTeX is **AGPL-3.0-or-later**. **No fork source file is committed
  to this repository**; the fetched `checkout/` (and `venv/`, and
  `pymupdf/`) are gitignored and exist only on the machine that ran the
  fetch. Our changes live as commits in the public fork, each carrying
  `SPDX-License-Identifier: AGPL-3.0-or-later` and naming the upstream
  rev it derives from. Everything here (`fetch.mjs`, `encode_web.py`,
  `requirements.lock`, this README) is lax-authored under the repository
  license.
- The npm tarball is unaffected: `package.json`'s `files` allowlist does
  not include `reflowtex/`, so **no AGPL bytes enter the Apache-labeled
  package**. `assets/tex/laxreflow.sty` does ship, but it is lax-authored
  and only *loads* the serializer at run time; it derives from no
  ReflowTeX source.
- Until 2026-09-03 the fork did not exist and this directory carried the
  changes as a `patches/` series applied over upstream at fetch time; the
  fork's `lax` branch is that series as commits, and `patches/` is gone.

## requirements.lock

The hash-pinned closure for the encode environment: `protobuf` (runtime),
`fonttools` (cmap patching), `grpcio-tools` (+ `grpcio`,
`typing-extensions`) supplying `protoc` deterministically. Hashes cover
every wheel and sdist PyPI publishes for the pinned versions, so the lock
holds across platforms. On a bump, re-pin the versions and regenerate the
hash lists from PyPI's per-file sha256 digests.
