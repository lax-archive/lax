#!/usr/bin/env python3
"""Assert the P0-3 verdict on a patched-serializer output.json of the fixture:
every mark from the rewriter's table surfaces exactly once per side, in the
expected global stream order, adjacent to the expected words.

    python3 check_markers.py build/out-marked/output.json build/rw/marks.json
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spike import load, stream_items  # noqa: E402

# The fixture's ground truth: global order (document order, nesting explicit)
# and, per instance, a substring the decoded context must end with (before)
# or start with (after). None = that side is at a capture boundary.
EXPECTED = [
    ("b", 1, "notion of", "proper vertex colorings"),
    ("e", 1, "proper vertex colorings", "as introduced"),
    ("b", 2, "2 Treewidth", "Definition 1 (Treewidth)"),
    ("e", 2, "tree decompositions of G.", "The subtree condition"),
    ("b", 3, "connected region of the tree.", "Theorem 1."),
    ("b", 4, "G is a forest.", "Proof."),
    ("e", 4, "a contradiction.", "3 Two displays"),
    ("e", 3, "a contradiction.", "3 Two displays"),
    ("b", 5, "its vertex count:", None),
    ("e", 5, "(display)", "Equality holds"),
    ("b", 6, "agree on every clique:", None),
    ("e", 6, None, "so the bound is tight."),
    ("b", 7, "builds on", "the flagship colorings development"),
    ("e", 7, "the flagship colorings development", "and reuses"),
]


def main() -> None:
    out_json, marks_json = sys.argv[1], sys.argv[2]
    data = load(out_json)
    marks = json.loads(Path(marks_json).read_text())
    found = stream_items(data)
    failures = []

    if len(found) != 2 * len(marks):
        failures.append(f"count: {len(found)} instances for {len(marks)} table marks")
    for m in marks:
        for side in ("b", "e"):
            k = sum(1 for f in found if f["n"] == m["n"] and f["side"] == side)
            if k != 1:
                failures.append(f"mark {m['n']} ({m['id']}): {side} appears {k} times, want 1")

    got_order = [(f["side"], f["n"]) for f in found]
    want_order = [(s, n) for s, n, _, _ in EXPECTED]
    if got_order != want_order:
        failures.append(f"order: got {got_order}, want {want_order}")

    by_key = {(f["side"], f["n"]): f for f in found}
    for side, n, before, after in EXPECTED:
        f = by_key.get((side, n))
        if f is None:
            continue
        if before is not None and not f["before"].endswith(before):
            failures.append(f"{side}{n}: before context {f['before']!r} !endswith {before!r}")
        if after is not None and not f["after"].startswith(after):
            failures.append(f"{side}{n}: after context {f['after']!r} !startswith {after!r}")

    if failures:
        print("FAIL")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    stream = sum(1 for f in found if f["at"].startswith("stream"))
    print(f"OK: {len(found)} marker instances ({stream} in the stream, "
          f"{len(found) - stream} inside paragraphs), order and adjacency as expected")


if __name__ == "__main__":
    main()
