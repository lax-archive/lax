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
  only wall); the dvisvgm invocation is injectable per call
  (`REFLOWTEX_DVISVGM`) so the trusted path can route conversion through
  the pinned TeX container; and a pre-converted `<src>.svg` beside a
  picture's PDF is consumed as-is (stage 3 converts inside the pinned
  image right after the compile — the encode host has no dvisvgm), with
  the sanitizer still applied to every consumed SVG.
- **Injectable Type1 lookup** (`src/encode/t1_convert.py`): with
  `REFLOWTEX_PFB_DIR` set (read per call), `find_pfb` resolves outlines
  from that directory and nowhere else — the trusted path exports the
  `.pfb` outlines legacy 8-bit faces need (plain lualatex math: cmmi10,
  cmsy10, …) from the pinned image, and a host tree must never silently
  substitute for a missed export; without it, kpsewhich as stock, but a
  host without kpsewhich yields the metric-box fallback instead of an
  uncaught crash.
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
protoc), and verifies the result — the marker forms present in the generated
module, which stock upstream lacks.

`LAX_REFLOWTEX_SOURCE=<path>` (read per call) substitutes a local git
checkout for the clone source — the pinned rev must exist in it; tests
use the reference clone this way. After a fetch, the consumable surfaces
are `checkout/src/extract/serializer.lua` (copied into each compile's job
directory — `assets/tex/laxreflow.sty` loads it with `dofile`),
`checkout/src/encode/` driven through `pipeline.Pipeline` or the
transforms/encode modules directly, and `checkout/build/latex_pb2.py`.

## Licensing posture

- ReflowTeX is **AGPL-3.0-or-later**. **No fork source file is committed
  to this repository**; the fetched `checkout/` (and `venv/`) are
  gitignored and exist only on the machine that ran the fetch. Our
  changes live as commits in the public fork, each carrying
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
