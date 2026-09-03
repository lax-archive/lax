#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""The paper web derivation's encode child (paper-web-plan.md, stage 2).

Lax-authored, licensed Apache-2.0 like the rest of this repository: at run
time it *drives* the AGPL ReflowTeX encode modules from the fetched
checkout (see README.md for the licensing posture) and derives from no
ReflowTeX source. Runs inside reflowtex/venv — the hash-pinned environment
— as a capped child of the deriver (src/submission-validation/paper/web.ts):

    venv/bin/python encode_web.py --checkout <dir> --job <dir> --out <dir>
        [--fonts <dir>]

reads the injected lualatex run's `<job>/output.json` (plus `<job>/pics/`
for externalized tikz pictures), and writes into `<out>/`:

  - `stream.json` — the oracle's stream side, taken from the *pristine*
    node list before any transform rewrites glyph codepoints: the
    linearized glyph text of referenced content, every marker instance in
    referenced content (`at: paragraph|stream`), and each unreferenced
    paragraph with its text and trapped markers (the `\\marginpar`
    diagnostic; the glyphless hoist leaves marker-only ones here too);
  - `blocks/000.pb` — the encoded document, after the fork's proven
    transform order (convert_pictures, strip_unsupported_nodes, the two
    font normalisations, deterministic serialization);
  - `fonts/` — the provisioned, cmap-patched font files the document used;
  - `encode.json` — the block size and the {original -> served} font map.

`--fonts` names a directory of exported font files searched *before*
kpsewhich (fonts.py's `local_dir`): the trusted path compiles in the
pinned TeX image and exports the font bytes the run used into the job,
because the encode host has no TeX installation to resolve them from.

Legacy 8-bit fonts (filename "unknown") carry slot codepoints, not
Unicode; the linearizer decodes the token-relevant subset — OT1 text
ligatures/letters, OML (cmmi) greek and punctuation, capital letters of
the symbol fonts — and drops the rest, mirroring what the TypeScript
tokenizer keeps. Everything here treats the compile's output as data.
"""

import argparse
import json
import sys
from pathlib import Path

# ── legacy 8-bit font decoding (token-relevant subset only) ────────────────

OT1_LOW = {
    0x00: "Γ", 0x01: "Δ", 0x02: "Θ", 0x03: "Λ",
    0x04: "Ξ", 0x05: "Π", 0x06: "Σ", 0x07: "Υ",
    0x08: "Φ", 0x09: "Ψ", 0x0A: "Ω",
    0x0B: "ff", 0x0C: "fi", 0x0D: "fl", 0x0E: "ffi", 0x0F: "ffl",
    0x10: "i", 0x11: "j",
    0x19: "ß", 0x1A: "æ", 0x1B: "œ", 0x1C: "ø",
    0x1D: "Æ", 0x1E: "Œ", 0x1F: "Ø",
}

OML_GREEK = {
    0x0B: "α", 0x0C: "β", 0x0D: "γ", 0x0E: "δ",
    0x0F: "ε", 0x10: "ζ", 0x11: "η", 0x12: "θ",
    0x13: "ι", 0x14: "κ", 0x15: "λ", 0x16: "μ",
    0x17: "ν", 0x18: "ξ", 0x19: "π", 0x1A: "ρ",
    0x1B: "σ", 0x1C: "τ", 0x1D: "υ", 0x1E: "φ",
    0x1F: "χ", 0x20: "ψ", 0x21: "ω", 0x22: "ε",
    0x23: "θ", 0x24: "π", 0x25: "ρ", 0x26: "σ",
    0x27: "φ",
}

SYMBOL_FONT_PREFIXES = (
    "cmsy", "cmex", "cmbsy", "msam", "msbm", "lasy", "wasy", "stmary",
    "line", "lcircle", "manfnt",
)


def _is_legacy(info: dict) -> bool:
    filename = str(info.get("filename", "") or "")
    return not filename.lower().endswith((".otf", ".ttf"))


def decode_glyph(char: int, info: dict | None) -> str:
    """A glyph's contribution to the oracle text; '' when undecodable."""
    if info is None or not _is_legacy(info):
        if 0x20 <= char < 0xF0000:
            return chr(char)
        return ""
    name = str(info.get("name", "") or "").lower()
    if name.startswith(SYMBOL_FONT_PREFIXES):
        # Pure symbol fonts: only the capital slots carry letters
        # (calligraphic/fraktur alphabets); everything else is a symbol the
        # tokenizer would drop on the PDF side too.
        return chr(char) if 0x41 <= char <= 0x5A else ""
    if name.startswith(("cmmi", "cmmib")):
        if char in OML_GREEK:
            return OML_GREEK[char]
        if char == 0x3A:
            return "."
        if char == 0x3B:
            return ","
        if 0x30 <= char <= 0x39 or 0x41 <= char <= 0x5A or 0x61 <= char <= 0x7A:
            return chr(char)
        return ""
    # OT1-shaped text fonts (cmr, cmbx, cmti, cmss, cmtt, ...).
    if char in OT1_LOW:
        return OT1_LOW[char]
    if 0x20 <= char <= 0x7E:
        return chr(char)
    return ""


# ── pristine linearization ─────────────────────────────────────────────────

def linearize(nodes, fonts, out, markers):
    """Walk a node list in order: glyph text, glue as spaces, the unbroken
    (`replace`) branch of discretionaries, markers as instances."""
    for n in nodes:
        t = n.get("type")
        if t == "marker":
            markers.append({"side": n.get("side"), "n": n.get("n")})
        elif t == "glyph":
            char = n.get("char")
            font = fonts.get(str(n.get("font", "")))
            if isinstance(char, int):
                out.append(decode_glyph(char, font))
        elif t == "glue":
            out.append(" ")
        elif t == "disc":
            linearize(n.get("replace") or [], fonts, out, markers)
        else:
            children = n.get("children")
            if children:
                linearize(children, fonts, out, markers)


def fonts_table(data: dict) -> dict:
    fonts = data.get("fonts", {})
    return fonts if isinstance(fonts, dict) else {}


def stream_report(data: dict) -> dict:
    fonts = fonts_table(data)
    paragraphs = data.get("paragraphs", [])
    referenced = set()
    for item in data.get("content", []):
        if item.get("kind") == "paragraph" and isinstance(item.get("para"), int):
            referenced.add(item["para"])

    markers: list = []
    pieces: list = []
    for item in data.get("content", []):
        kind = item.get("kind")
        if kind == "paragraph":
            index = item.get("para")
            if isinstance(index, int) and 1 <= index <= len(paragraphs):
                para_markers: list = []
                para_pieces: list = []
                linearize(paragraphs[index - 1].get("nodes", []), fonts, para_pieces, para_markers)
                # In-paragraph markers surface in stream order beside the
                # stream items; their intra-paragraph order is preserved.
                for m in para_markers:
                    markers.append({**m, "at": "paragraph"})
                pieces.append("".join(para_pieces))
        elif kind == "marker":
            markers.append({"side": item.get("side"), "n": item.get("n"), "at": "stream"})
        elif "box" in item:
            box_markers: list = []
            box_pieces: list = []
            linearize(item["box"].get("children", []), fonts, box_pieces, box_markers)
            for m in box_markers:
                markers.append({**m, "at": "paragraph"})
            pieces.append("".join(box_pieces))

    unreferenced = []
    for index, paragraph in enumerate(paragraphs, start=1):
        if index in referenced:
            continue
        para_markers: list = []
        para_pieces: list = []
        linearize(paragraph.get("nodes", []), fonts, para_pieces, para_markers)
        unreferenced.append({
            "text": "".join(para_pieces),
            "markers": [[m.get("side"), m.get("n")] for m in para_markers],
        })

    return {"markers": markers, "text": "\n".join(pieces), "unreferenced": unreferenced}


# ── main ───────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkout", required=True, help="the fetched, patched reflowtex checkout")
    ap.add_argument("--job", required=True, help="the web compile's job dir (output.json, pics/)")
    ap.add_argument("--out", required=True, help="where blocks/, fonts/, stream.json, encode.json go")
    ap.add_argument("--fonts", help="optional dir of exported font files searched before kpsewhich")
    args = ap.parse_args()

    checkout = Path(args.checkout).resolve()
    job = Path(args.job).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "blocks").mkdir(exist_ok=True)

    sys.path.insert(0, str(checkout / "src" / "encode"))
    from pipeline import Pipeline  # noqa: E402 (checkout import)
    import encode_pb  # noqa: E402
    import transforms  # noqa: E402

    # Constructing the Pipeline runs the fork's verify-only _ensure_pb2 —
    # the generated latex_pb2.py must already exist in checkout/build/.
    # local_fonts_dir is fonts.py's local_dir injection point: provisioning
    # copies from it before it ever tries kpsewhich.
    pipe = Pipeline(build_root=out / "_build", fonts_dir=out / "fonts",
                    local_fonts_dir=args.fonts)

    data = json.loads((job / "output.json").read_text())

    # The oracle's stream side, from the pristine node list — before the
    # transforms rewrite glyph codepoints to PUA addresses.
    (out / "stream.json").write_text(json.dumps(stream_report(data)))

    # The fork's proven encode order (stage 1): pictures, strip, legacy
    # fonts, glyph addressing, deterministic serialization.
    # (lax) Unsourced image rules — plain \\includegraphics the template
    # hook never stamped — degrade to width-keeping kerns and are counted;
    # the deriver turns the count into a `web-pictures-dropped` warning.
    dropped_pictures: list = []
    transforms.convert_pictures(data, job, dropped_pictures)
    transforms.strip_unsupported_nodes(data)
    transforms.normalise_legacy_font_addressing(data, pipe.fonts)
    transforms.normalise_glyph_addressing(data, pipe.fonts)
    blob = encode_pb.serialize_document(data)
    (out / "blocks" / "000.pb").write_bytes(blob)

    # Cmap-patch the served fonts against everything this document
    # addresses, then record the {original -> served} map for index.json.
    pipe.patch_fonts([data])
    (out / "encode.json").write_text(json.dumps({
        "pbBytes": len(blob),
        "fonts": pipe.font_map(),
        "droppedPictures": len(dropped_pictures),
    }))
    print(f"encoded {len(blob)} bytes; {len(pipe.font_map())} font(s)")


if __name__ == "__main__":
    main()
