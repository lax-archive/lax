#!/usr/bin/env python3
"""Test driver for the patched ReflowTeX encode pipeline (run inside
reflowtex/venv — see test/e2e/reflowtex-fork.test.ts).

Given a job directory holding the output.json of an injected lualatex run
(plus pics/*.pdf for externalized tikz pictures), this replays the encode
half of Pipeline.compile — convert_pictures, strip_unsupported_nodes, the
two font normalisations, deterministic protobuf serialization — writes
nodelist.pb beside the input, then decodes the blob back through the
regenerated latex_pb2 and reports what the wire form actually carries:
both marker forms (in-paragraph nodes and stream items), picture nodes,
and the sanitized SVG payloads. Constructing a Pipeline also exercises the
fork's verify-only _ensure_pb2 (never a write into the checkout).
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkout", required=True, help="the fetched, patched reflowtex checkout")
    ap.add_argument("--build", required=True, help="job dir with output.json (and pics/)")
    ap.add_argument("--fonts", required=True, help="where provisioned fonts go")
    ap.add_argument("--stats", required=True, help="where to write the JSON report")
    args = ap.parse_args()

    checkout = Path(args.checkout).resolve()
    sys.path.insert(0, str(checkout / "src" / "encode"))
    from pipeline import Pipeline  # noqa: E402 (checkout import)
    import encode_pb  # noqa: E402
    import transforms  # noqa: E402

    build = Path(args.build).resolve()
    pipe = Pipeline(build_root=build / "_build", fonts_dir=args.fonts)

    data = json.loads((build / "output.json").read_text())
    n_pictures = transforms.convert_pictures(data, build)
    n_stripped = transforms.strip_unsupported_nodes(data)
    n_legacy = transforms.normalise_legacy_font_addressing(data, pipe.fonts)
    n_rewritten = transforms.normalise_glyph_addressing(data, pipe.fonts)
    blob = encode_pb.serialize_document(data)
    (build / "nodelist.pb").write_bytes(blob)

    import latex_pb2 as L  # noqa: E402 (resolved from checkout/build via encode_pb)

    doc = L.Document.FromString(blob)
    node_markers: list[list] = []
    picture_nodes = 0

    def walk(nodes) -> None:
        nonlocal picture_nodes
        for n in nodes:
            if n.HasField("type") and n.type == L.NodeType.Value("mark"):
                node_markers.append([n.side, n.n])
            if n.HasField("picture"):
                picture_nodes += 1
            walk(n.children)
            walk(n.pre)
            walk(n.post)
            walk(n.replace)
            if n.HasField("leader"):
                walk([n.leader])

    for para in doc.paragraphs:
        walk(para.nodes)
    stream_markers: list[list] = []
    for item in doc.content:
        if item.kind == L.ItemKind.Value("marker"):
            stream_markers.append([item.side, item.n])
        if item.HasField("box"):
            walk(item.box.children)

    stats = {
        "pb_bytes": len(blob),
        "pb_sha256": hashlib.sha256(blob).hexdigest(),
        "node_markers": node_markers,
        "stream_markers": stream_markers,
        "picture_nodes": picture_nodes,
        "pictures": [{"svg": p.svg, "vb_w": p.vb_w, "vb_h": p.vb_h} for p in doc.pictures],
        "converted": n_pictures,
        "stripped": n_stripped,
        "legacy": n_legacy,
        "rewritten": n_rewritten,
    }
    Path(args.stats).write_text(json.dumps(stats))
    print(f"encoded {len(blob)} bytes: {len(node_markers)} node marker(s), "
          f"{len(stream_markers)} stream marker(s), {len(doc.pictures)} picture(s)")


if __name__ == "__main__":
    main()
