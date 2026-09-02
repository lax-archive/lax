#!/usr/bin/env python3
"""Driver for the reflowtex marker spike (see REPORT.md).

Subcommands:
  setup      prepare build/: the patched serializer (clone copy + serializer.patch)
             and an old-mtime latex.proto copy (so the clone's _ensure_pb2 never
             tries to regenerate latex_pb2.py inside the read-only clone).
  extract    substitute the clone's template.tex + run lualatex; keeps the RAW
             output.json (no transforms -- marker nodes survive only here).
  pipeline   full reflowtex Pipeline.compile (transforms + protobuf + fonts).
  markers    print marker instances found in an output.json, in stream order.
  stream     compact content-stream dump of an output.json (for diffing).
  compare    structural diff of two output.json files.

The reflowtex clone is read-only reference material; nothing here writes into
it. Override its location with REFLOWTEX_DIR.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # let `| head` cut dumps quietly

SPIKE = Path(__file__).resolve().parent
BUILD = SPIKE / "build"
REFLOW = Path(os.environ.get("REFLOWTEX_DIR", "/home/user/radek-p/reflowtex"))
TEMPLATE = REFLOW / "src" / "extract" / "template.tex"
SERIALIZER = REFLOW / "src" / "extract" / "serializer.lua"
PROTO = REFLOW / "src" / "schema" / "latex.proto"
LIGATURES = {0xFB00: "ff", 0xFB01: "fi", 0xFB02: "fl", 0xFB03: "ffi", 0xFB04: "ffl"}


# ── setup ────────────────────────────────────────────────────────────────────

def setup() -> None:
    BUILD.mkdir(exist_ok=True)
    patched = BUILD / "patched"
    patched.mkdir(exist_ok=True)
    shutil.copy(SERIALIZER, patched / "serializer.lua")
    subprocess.run(
        ["patch", "--quiet", str(patched / "serializer.lua"), str(SPIKE / "serializer.patch")],
        check=True)
    proto_dir = BUILD / "proto"
    proto_dir.mkdir(exist_ok=True)
    shutil.copy(PROTO, proto_dir / "latex.proto")
    # Old mtime: pipeline._ensure_pb2 regenerates latex_pb2.py (into the clone!)
    # whenever the proto is newer than the committed pb2; a fresh clone has
    # near-identical mtimes, so hand it a copy that is definitely older.
    os.utime(proto_dir / "latex.proto", (0, 0))
    print(f"setup: {patched / 'serializer.lua'} (patched), {proto_dir / 'latex.proto'} (mtime 1970)")


# ── compiling ────────────────────────────────────────────────────────────────

def template_text(class_options: str | None) -> str:
    text = TEMPLATE.read_text()
    if class_options:
        needle = "\\documentclass{article}"
        assert text.count(needle) == 1, "template no longer has a plain \\documentclass"
        text = text.replace(needle, f"\\documentclass[{class_options}]{{article}}")
    return text


def assemble(src: Path, content: str, extra_preamble: str, laxweb: str) -> tuple[str, str]:
    preamble = (src / "preamble.tex").read_text()
    if laxweb == "lift":
        preamble += "\n\\usepackage{laxweb}\n"
    elif laxweb == "nolift":
        preamble += "\n\\usepackage[nolift]{laxweb}\n"
    if extra_preamble:
        preamble += extra_preamble + "\n"
    return preamble, (src / content).read_text()


def tex_env(src: Path) -> dict:
    env = dict(os.environ)
    # Non-recursive, trailing colon keeps the system tree: the rewritten fixture
    # (for \input/\include) and this directory (laxweb.sty).
    env["TEXINPUTS"] = f"{src}:{SPIKE}:"
    return env


def run_extract(args) -> None:
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "pics").mkdir(exist_ok=True)
    preamble, content = assemble(src, args.content, args.extra_preamble, args.laxweb)
    tex = (template_text(args.class_options)
           .replace("%%PREAMBLE%%", preamble)
           .replace("%%CONTENT%%", content))
    (out / "input.tex").write_text(tex)
    serializer = {"patched": BUILD / "patched" / "serializer.lua", "stock": SERIALIZER}[args.serializer]
    shutil.copy(serializer, out / "serializer.lua")
    env = tex_env(src)
    times = []
    for _ in range(args.passes):
        t0 = time.monotonic()
        r = subprocess.run(["lualatex", "-shell-escape", "-interaction=nonstopmode", "input.tex"],
                           cwd=out, env=env, capture_output=True, text=True)
        times.append(time.monotonic() - t0)
    log = out / "input.log"
    if not (out / "output.json").exists():
        detail = log.read_text(errors="replace") if log.exists() else r.stdout + r.stderr
        sys.exit(f"extract: lualatex produced no output.json:\n{detail[-3000:]}")
    # Same semantics as pipeline._run_lualatex: nonstopmode repairs the document,
    # so any '! ' line means the node list is silently wrong.
    errors = [l for l in log.read_text(errors="replace").splitlines() if l.startswith("! ")]
    if errors and not args.allow_errors:
        sys.exit("extract: TeX error(s):\n" + "\n".join(errors[:10]))
    print(f"extract: {out / 'output.json'}  passes: " + " ".join(f"{t:.2f}s" for t in times))


def run_inject(args) -> None:
    """Transparent derivation: compile an unmodified standalone main.tex with
    the hooks injected pretex-style (no wrapper template)."""
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "pics").mkdir(exist_ok=True)
    main_text = (src / args.main).read_text()
    if args.replace_class:
        needle = "\\documentclass{article}"
        assert main_text.count(needle) == 1, "main has no plain \\documentclass{article}"
        main_text = main_text.replace(needle, f"\\documentclass{{{args.replace_class}}}")
    (out / "main.tex").write_text(main_text)
    shutil.copy(BUILD / "patched" / "serializer.lua", out / "serializer.lua")
    env = tex_env(src)
    # The job dir must win for main.tex (a --replace-class copy lives there;
    # the src dir keeps its own main.tex for \input resolution of the rest).
    env["TEXINPUTS"] = f".:{env['TEXINPUTS']}"
    times = []
    for _ in range(args.passes):
        t0 = time.monotonic()
        r = subprocess.run(
            ["lualatex", "-shell-escape", "-interaction=nonstopmode", "--jobname=main",
             "\\RequirePackage{laxreflow}\\input{main.tex}"],
            cwd=out, env=env, capture_output=True, text=True)
        times.append(time.monotonic() - t0)
    log = out / "main.log"
    if not (out / "output.json").exists():
        detail = log.read_text(errors="replace") if log.exists() else r.stdout + r.stderr
        sys.exit(f"inject: lualatex produced no output.json:\n{detail[-3000:]}")
    errors = [l for l in log.read_text(errors="replace").splitlines() if l.startswith("! ")]
    if errors and not args.allow_errors:
        sys.exit("inject: TeX error(s):\n" + "\n".join(errors[:10]))
    print(f"inject: {out / 'output.json'}  passes: " + " ".join(f"{t:.2f}s" for t in times))


def make_pipeline(src: Path, out: Path):
    """A reflowtex Pipeline wired to the spike: patched serializer, old-mtime
    proto copy, fixture TEXINPUTS, and stream marker items dropped before
    protobuf encoding (the stock schema has no content-item kind for markers,
    so encode_pb KeyErrors on them; the spike verifies markers on the raw
    output.json in extract mode, and a production fork extends the schema
    instead -- markers must reach the browser as anchors)."""
    sys.path.insert(0, str(REFLOW / "src" / "encode"))
    os.environ.update(tex_env(src))
    from pipeline import Pipeline  # noqa: E402
    import transforms  # noqa: E402
    stock_strip = transforms.strip_unsupported_nodes

    def strip_plus_stream_markers(data):
        n = stock_strip(data)
        before = len(data.get("content", []))
        data["content"] = [it for it in data["content"] if it.get("kind") != "marker"]
        return n + (before - len(data["content"]))

    transforms.strip_unsupported_nodes = strip_plus_stream_markers
    return Pipeline(build_root=out / "_build", fonts_dir=out / "fonts",
                    serializer=BUILD / "patched" / "serializer.lua",
                    proto=BUILD / "proto" / "latex.proto")


def run_pipeline(args) -> None:
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    preamble, content = assemble(src, args.content, args.extra_preamble, args.laxweb)
    pipe = make_pipeline(src, out)
    t0 = time.monotonic()
    blob = pipe.compile(content, preamble, key=args.key, passes=args.passes)
    dt = time.monotonic() - t0
    pipe.patch_fonts()
    fonts = sorted((out / "fonts").glob("*.otf"))
    print(f"pipeline: {out / '_build' / args.key / 'nodelist.pb'}  blob {len(blob)} bytes  "
          f"{dt:.2f}s  fonts {sum(f.stat().st_size for f in fonts)} bytes in {len(fonts)} file(s)")


# ── reading output.json ──────────────────────────────────────────────────────

def load(path: str) -> dict:
    return json.loads(Path(path).read_text())


def glyph_char(nd: dict) -> str:
    c = nd.get("char", 0)
    if c in LIGATURES:
        return LIGATURES[c]
    if c < 0x20 or c >= 0xF0000:
        return "?"
    return chr(c)


def linearize(nodes: list, out: list) -> None:
    """Depth-first text linearization: ('text', piece) and ('marker', side, n)."""
    for nd in nodes:
        t = nd.get("type")
        if t == "marker":
            out.append(("marker", nd.get("side"), nd.get("n")))
        elif t == "whatsit":
            out.append(("whatsit",))  # a bare, unidentified whatsit (stock serializer)
        elif t == "glyph":
            out.append(("text", glyph_char(nd)))
        elif t == "glue":
            out.append(("text", " "))
        elif t == "disc":
            linearize(nd.get("replace", []), out)
        else:
            if "children" in nd:
                linearize(nd["children"], out)


def collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def para_text(data: dict, ref: int) -> str:
    out: list = []
    linearize(data["paragraphs"][ref - 1]["nodes"], out)
    return collapse("".join(p[1] for p in out if p[0] == "text"))


def stream_items(data: dict):
    """Global marker sequence with context: yields dicts, one per marker,
    in content-stream order (markers inside a paragraph at that paragraph's
    position, in node order)."""
    content = data["content"]

    def item_text(i: int) -> str:
        if i < 0 or i >= len(content):
            return "(edge)"
        it = content[i]
        if it["kind"] == "paragraph":
            return para_text(data, it["para"])
        if it["kind"] == "display":
            return "(display)"
        if it["kind"] == "marker":
            return f"(marker {it.get('side')}{it.get('n')})"
        return f"({it['kind']})"

    def neighbour(i: int, step: int) -> str:
        j = i + step
        while 0 <= j < len(content) and content[j]["kind"] in ("marker", "vspace"):
            j += step
        return item_text(j)

    found = []
    for ci, it in enumerate(content):
        if it["kind"] == "paragraph":
            lin: list = []
            linearize(data["paragraphs"][it["para"] - 1]["nodes"], lin)
            for k, entry in enumerate(lin):
                if entry[0] != "marker":
                    continue
                before = collapse("".join(p[1] for p in lin[:k] if p[0] == "text"))[-60:]
                after = collapse("".join(p[1] for p in lin[k + 1:] if p[0] == "text"))[:60]
                found.append({"side": entry[1], "n": entry[2], "at": f"para@{ci}",
                              "before": before, "after": after})
        elif it["kind"] == "marker":
            found.append({"side": it.get("side"), "n": it.get("n"), "at": f"stream@{ci}",
                          "before": neighbour(ci, -1)[-60:], "after": neighbour(ci, +1)[:60]})
    return found


def count_bare_whatsits(data: dict) -> int:
    n = 0

    def walk(nodes):
        nonlocal n
        for nd in nodes:
            if nd.get("type") == "whatsit":
                n += 1
            for k in ("children", "pre", "post", "replace"):
                if k in nd:
                    walk(nd[k])

    for p in data.get("paragraphs", []):
        walk(p.get("nodes", []))
    for it in data.get("content", []):
        if "box" in it:
            walk(it["box"].get("children", []))
    return n


def run_markers(args) -> None:
    data = load(args.json)
    found = stream_items(data)
    for f in found:
        print(f"{f['side']}{f['n']:<3} {f['at']:<10} …{f['before']!r} ⟂ {f['after']!r}…")
    print(f"{len(found)} marker instance(s); {count_bare_whatsits(data)} bare whatsit node(s) in captures")


# ── stream dump & compare ────────────────────────────────────────────────────

def run_stream(args) -> None:
    data = load(args.json)
    for it in data["content"]:
        k = it["kind"]
        if k == "paragraph":
            p = data["paragraphs"][it["para"] - 1]
            print(f"para   band={p.get('indent', 0)}+{p.get('width')} bls={p.get('baselineskip')} "
                  f"align={p.get('align') or '-'} \"{para_text(data, it['para'])[:72]}\"")
        elif k == "display":
            print(f"display box={it['box'].get('width')}x{it['box'].get('height')} "
                  f"band={it.get('display_indent')}+{it.get('display_width')} "
                  f"shift={it.get('display_shift')} below={it.get('below_skip')}")
        elif k == "vspace":
            print(f"vspace {it.get('amount')}")
        elif k == "marker":
            print(f"marker {it.get('side')}{it.get('n')}")
        else:
            print(k)


def canonical(data: dict, ignore_bands: bool, strip_markers: bool) -> dict:
    def clean(nodes):
        out = []
        for nd in nodes:
            nd = dict(nd)
            if strip_markers and nd.get("type") == "marker":
                continue
            for k in ("children", "pre", "post", "replace"):
                if k in nd:
                    nd[k] = clean(nd[k])
            if "leader" in nd:
                nd["leader"] = clean([nd["leader"]])
            out.append(nd)
        return out

    stream = []
    for it in data["content"]:
        k = it["kind"]
        if k == "paragraph":
            p = dict(data["paragraphs"][it["para"] - 1])
            p.pop("index", None)
            p["nodes"] = clean(p["nodes"])
            if ignore_bands:
                p.pop("width", None)
                p.pop("indent", None)
            stream.append({"kind": "paragraph", "para": p})
        elif k == "display":
            d = dict(it)
            d["box"] = dict(d["box"])
            d["box"]["children"] = clean(d["box"].get("children", []))
            if ignore_bands:
                for f in ("display_width", "display_indent", "display_shift"):
                    d.pop(f, None)
            stream.append(d)
        elif k == "marker" and strip_markers:
            continue
        else:
            stream.append(it)
    return {"fonts": data.get("fonts"), "stream": stream}


def deep_diff(a, b, path: str, out: list, limit: int) -> None:
    if len(out) >= limit:
        return
    if type(a) is not type(b):
        out.append(f"{path}: type {type(a).__name__} != {type(b).__name__}")
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: only in B ({b[k]!r:.60})")
            elif k not in b:
                out.append(f"{path}.{k}: only in A ({a[k]!r:.60})")
            else:
                deep_diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            deep_diff(x, y, f"{path}[{i}]", out, limit)
    elif a != b:
        out.append(f"{path}: {a!r:.60} != {b!r:.60}")


def run_compare(args) -> None:
    a = canonical(load(args.a), args.ignore_bands, args.strip_markers_a)
    b = canonical(load(args.b), args.ignore_bands, args.strip_markers_b)
    if args.drop_leading_a:
        a["stream"] = a["stream"][args.drop_leading_a:]
    if args.ignore_fonts:
        a.pop("fonts", None)
        b.pop("fonts", None)
        for side in (a, b):
            def scrub(nodes):
                for nd in nodes:
                    nd.pop("font", None)
                    for k in ("children", "pre", "post", "replace", "leader"):
                        if k in nd:
                            scrub(nd[k])
            for it in side["stream"]:
                if it["kind"] == "paragraph":
                    scrub(it["para"]["nodes"])
                elif it["kind"] == "display":
                    scrub(it["box"]["children"])
    diffs: list = []
    deep_diff(a, b, "", diffs, args.limit)
    if not diffs:
        print("IDENTICAL (canonicalized)")
        return
    print(f"{len(diffs)} difference path(s) (limit {args.limit}):")
    for d in diffs:
        print("  " + d)
    sys.exit(1)


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")

    def compile_args(p):
        p.add_argument("--src", required=True, help="dir with preamble.tex and the content files")
        p.add_argument("--out", required=True)
        p.add_argument("--content", default="body.tex")
        p.add_argument("--extra-preamble", default="")
        p.add_argument("--laxweb", choices=["lift", "nolift", "off"], default="lift")
        p.add_argument("--passes", type=int, default=2)

    p = sub.add_parser("extract")
    compile_args(p)
    p.add_argument("--serializer", choices=["patched", "stock"], default="patched")
    p.add_argument("--class-options", default=None)
    p.add_argument("--allow-errors", action="store_true")

    p = sub.add_parser("pipeline")
    compile_args(p)
    p.add_argument("--key", default="fixture")

    p = sub.add_parser("inject")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--main", default="main.tex")
    p.add_argument("--replace-class", default=None)
    p.add_argument("--passes", type=int, default=2)
    p.add_argument("--allow-errors", action="store_true")

    p = sub.add_parser("markers")
    p.add_argument("json")

    p = sub.add_parser("stream")
    p.add_argument("json")

    p = sub.add_parser("compare")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--ignore-bands", action="store_true")
    p.add_argument("--strip-markers-a", action="store_true")
    p.add_argument("--strip-markers-b", action="store_true")
    p.add_argument("--drop-leading-a", type=int, default=0)
    p.add_argument("--ignore-fonts", action="store_true")
    p.add_argument("--limit", type=int, default=40)

    args = ap.parse_args()
    {"setup": lambda a: setup(), "extract": run_extract, "pipeline": run_pipeline,
     "inject": run_inject, "markers": run_markers, "stream": run_stream,
     "compare": run_compare}[args.cmd](args)


if __name__ == "__main__":
    main()
