#!/usr/bin/env python3
"""Assemble the render-check site for the marked fixture (P2-11).

A minimal stand-in for reflowtex's integrations/vanilla/build.py: that script
constructs a stock Pipeline whose _ensure_pb2 would try to regenerate
latex_pb2.py inside the read-only clone (the fresh clone's mtimes make the
committed pb2 look stale), so this drives the same Pipeline through the
spike's wiring instead (spike.make_pipeline) and performs the same page
substitutions against the clone's page template read in place. Output goes to
site/ (gitignored; nothing from the clone is committed).

    build/venv/bin/python3 build-site.py
"""

import base64
import html
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spike import REFLOW, SPIKE, assemble, make_pipeline  # noqa: E402

SITE = SPIKE / "site"
SRC = SPIKE / "build" / "rw"


def main() -> None:
    pipe = make_pipeline(SRC, SITE / "_out")
    preamble, content = assemble(SRC, "body.tex", "", "lift")
    blob = pipe.compile(content, preamble, key="fixture", passes=2)
    pipe.patch_fonts()

    SITE.mkdir(exist_ok=True)
    viewer = REFLOW / "src" / "viewer"
    shutil.copy(viewer / "latex-viewer.js", SITE / "latex-viewer.js")
    shutil.copy(viewer / "protobuf.min.js", SITE / "protobuf.min.js")
    block = f'<div class="latex-block" data-nodelist-b64="{base64.b64encode(blob).decode()}"></div>'
    page = ((REFLOW / "integrations" / "vanilla" / "page.template.html").read_text()
            .replace("{{TITLE}}", "lax reflow spike")
            .replace("{{SCHEMA_B64}}", pipe.schema_b64())
            .replace("{{FONT_MAP_JSON}}", json.dumps(pipe.font_map()))
            .replace("{{SOURCE_URL}}", html.escape("https://github.com/radek-p/reflowtex", quote=True))
            .replace("{{FONTS_BASE}}", "/fonts/")
            .replace("{{BLOCKS}}", block))
    (SITE / "index.html").write_text(page)
    fonts = list((SITE / "_out" / "fonts").glob("*.otf"))
    dest = SITE / "fonts"
    dest.mkdir(exist_ok=True)
    for f in fonts:
        shutil.copy(f, dest / f.name)
    print(f"site: {SITE / 'index.html'}  blob {len(blob)} bytes  "
          f"{len(fonts)} font(s) {sum(f.stat().st_size for f in fonts)} bytes")


if __name__ == "__main__":
    main()
