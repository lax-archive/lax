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
for externalized tikz pictures, and the `<picture>.txt` the trusted export
leaves beside a converted picture's SVG — its page's text, for the oracle
only), and writes into `<out>/`:

  - `stream.json` — the oracle's stream side, taken from the *pristine*
    node list before any transform rewrites glyph codepoints: the
    linearized glyph text of referenced content, every marker instance in
    referenced content (`at: paragraph|stream`), each unreferenced
    paragraph with its text and trapped markers (the `\\marginpar`
    diagnostic; the glyphless hoist leaves marker-only ones here too),
    and under `relocated` each paragraph the serializer moved out of
    page order — footnotes, which the stream carries as endnotes while
    the PDF keeps them at page bottoms — with its text and markers, in
    stream order. A relocated paragraph is referenced content: its text
    is kept out of `text` (the oracle matches it against the PDF on its
    own) but its markers stay counted in `markers`;
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


def decode_glyph(char: int, info: dict | None, text: str | None = None) -> str:
    """A glyph's contribution to the oracle text; '' when undecodable.

    `text` is the serializer's reading of the glyph when its codepoint is
    not its text (a ligature, a small cap, an old-style figure — see the
    serializer's "Glyph text"): for an OpenType face it wins outright, so
    a private-use codepoint that carries text is never dropped. Without
    it a PUA glyph behaves as before — its codepoint is emitted verbatim
    (Plane 0/15 PUA), which the tokenizer discards as neither letter nor
    digit. Legacy 8-bit faces keep their slot tables regardless.
    """
    if info is None or not _is_legacy(info):
        if isinstance(text, str) and text != "":
            return text
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
                out.append(decode_glyph(char, font, n.get("text")))
        elif t == "glue":
            # A glue is a word break when it has natural width, as interword
            # glue does. A zero-width glue is padding — listings' `\hss`
            # around each column-aligned character, `\hfil` alignment fill,
            # `\hspace{0pt}` — whose *set* width pdf.js does not read as a
            # space either (it sets to a fraction of an em at most), so it
            # separates nothing; splitting there read "f o r" for "for".
            if (n.get("width") or 0) > 0:
                out.append(" ")
        elif t == "disc":
            linearize(n.get("replace") or [], fonts, out, markers)
        elif t == "picture":
            # The picture's own text (a tikz label, a vector figure's
            # caption inside the drawing) is in the PDF's text layer but
            # not in the node list; `attach_picture_texts` read it from
            # the export's sidecar. Spaces around it: it is never part of
            # a neighbouring word.
            text = n.get(PICTURE_TEXT_KEY)
            if isinstance(text, str) and text != "":
                out.append(" " + text + " ")
        else:
            children = n.get("children")
            if children:
                linearize(children, fonts, out, markers)


# ── picture text (oracle side only) ────────────────────────────────────────

# The node key the sidecar text is stashed under. Not a schema field, so the
# fork's `fill` drops it on the way into the block (encode_pb.NOT_ENCODED
# style): the rendered SVG already carries the picture, and this text exists
# only to meet the PDF's text layer in stream.json.
PICTURE_TEXT_KEY = "lax_oracle_text"
# What the trusted converter caps a picture's text at (web-container.ts,
# MAX_TEXT_BYTES); read here to the same bound so a planted file cannot
# grow the stream past it.
PICTURE_TEXT_BYTES = 64 * 1024


def read_picture_text(job: Path, src: str) -> str:
    """The `<job>/<src>.txt` the export left beside `<src>.svg`, whitespace
    collapsed, or '' when there is none (a downsampled raster carries no
    text; a picture the converter refused has no sidecar either)."""
    try:
        with open(job / f"{src}.txt", "rb") as handle:
            data = handle.read(PICTURE_TEXT_BYTES)
    except OSError:
        return ""
    return " ".join(data.decode("utf-8", errors="ignore").split())


def attach_picture_texts(data: dict, job: Path) -> int:
    """Stash each sourced picture node's sidecar text on the node, before
    convert_pictures pops the `file` the sidecar is named after. Returns
    how many pictures carried text."""
    attached = 0

    def walk(nodes) -> None:
        nonlocal attached
        for n in nodes:
            if not isinstance(n, dict):
                continue
            if n.get("type") == "picture":
                src = n.get("file")
                text = read_picture_text(job, src) if isinstance(src, str) and src else ""
                if text:
                    n[PICTURE_TEXT_KEY] = text
                    attached += 1
            for key in ("children", "replace", "pre", "post", "nobreak"):
                if n.get(key):
                    walk(n[key])
            if n.get("leader"):
                walk([n["leader"]])

    for paragraph in data.get("paragraphs", []):
        walk(paragraph.get("nodes", []))
    for item in data.get("content", []):
        box = item.get("box") if isinstance(item, dict) else None
        if isinstance(box, dict):
            walk(box.get("children", []))
    return attached


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
    relocated: list = []
    for item in data.get("content", []):
        kind = item.get("kind")
        if kind == "paragraph":
            index = item.get("para")
            if isinstance(index, int) and 1 <= index <= len(paragraphs):
                paragraph = paragraphs[index - 1]
                para_markers: list = []
                para_pieces: list = []
                linearize(paragraph.get("nodes", []), fonts, para_pieces, para_markers)
                # In-paragraph markers surface in stream order beside the
                # stream items; their intra-paragraph order is preserved.
                # A relocated paragraph's markers are counted the same way
                # — a marker inside a footnote is still a marker instance
                # in referenced content — while its text goes aside.
                for m in para_markers:
                    markers.append({**m, "at": "paragraph"})
                # The serializer marks a footnote's paragraphs with the
                # footnote's ordinal (an earlier serializer said `true`;
                # both read as relocated). A `footnote_ref` node in the
                # body carries no text and falls through `linearize`.
                footnote = paragraph.get("footnote")
                if isinstance(footnote, int) and footnote > 0:
                    relocated.append({
                        "text": "".join(para_pieces),
                        "markers": [[m.get("side"), m.get("n")] for m in para_markers],
                    })
                else:
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

    return {
        "markers": markers,
        "text": "\n".join(pieces),
        "unreferenced": unreferenced,
        "relocated": relocated,
    }


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

    # The fork's proven encode order (stage 1): pictures, strip, legacy
    # fonts, glyph addressing, deterministic serialization.
    # (lax) Unsourced image rules — plain \\includegraphics the template
    # hook never stamped — degrade to width-keeping kerns and are counted;
    # the deriver turns the count into a `web-pictures-dropped` warning.
    dropped_pictures: list = []
    # (lax) The pictures' own text, for the oracle's stream side: read
    # before convert_pictures pops each node's `file`.
    picture_texts = attach_picture_texts(data, job)
    transforms.convert_pictures(data, job, dropped_pictures)
    transforms.strip_unsupported_nodes(data)
    transforms.normalise_legacy_font_addressing(data, pipe.fonts)

    # The oracle's stream side, taken between the two font passes: after
    # the legacy re-addressing, which turns an 8-bit face's slots into the
    # codepoints its glyph names denote through the face's own encoding
    # vector (T1's slot 0xE9 is é, 0x1C the fi ligature — a table keyed on
    # a font's name cannot know that), and before the glyph-index pass
    # rewrites the OpenType faces' codepoints to PUA addresses. A face no
    # outline converted keeps its slots and decode_glyph's name-keyed
    # fallback.
    (out / "stream.json").write_text(json.dumps(stream_report(data)))

    transforms.normalise_glyph_addressing(data, pipe.fonts)
    blob = encode_pb.serialize_document(data)
    (out / "blocks" / "000.pb").write_bytes(blob)

    # Cmap-patch the served fonts against everything this document
    # addresses, then record the {original -> served} map for index.json.
    pipe.patch_fonts([data])
    # (lax) A legacy face no outline converted keeps the serializer's
    # 'unknown' placeholder as its filename; the viewer draws its glyphs as
    # metric boxes and there is no file to serve, so it leaves the map.
    font_map = {k: v for k, v in pipe.font_map().items() if k != "unknown"}
    (out / "encode.json").write_text(json.dumps({
        "pbBytes": len(blob),
        "fonts": font_map,
        "droppedPictures": len(dropped_pictures),
    }))
    print(f"encoded {len(blob)} bytes; {len(font_map)} font(s); "
          f"{picture_texts} picture text(s) folded into the oracle stream")


if __name__ == "__main__":
    main()
