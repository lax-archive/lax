#!/bin/sh
# End-to-end reproduction of the reflow spike (REPORT.md). Needs: lualatex
# (TeX Live 2023+, with tikz/fontspec/amsthm and Latin Modern), node 22 with
# the lax repo built (npm run build), python 3.11, and the reflowtex clone at
# $REFLOWTEX_DIR (default /home/user/radek-p/reflowtex, never written to).
# The playwright render check (shots.mjs) is separate: npm install, then
# `node shots.mjs` after `build/venv/bin/python3 build-site.py`.
set -eu
cd "$(dirname "$0")"

python3 spike.py setup
node rewrite-fixture.mjs fixture build/rw --main body.tex

# P0-3 marker capture: hypothesis run (stock serializer: markers vanish),
# patched run, checker, layout-neutrality diff, and the lift's value.
python3 spike.py extract --src build/rw --content body.tex --out build/out-marked-stock --serializer stock --passes 2
python3 spike.py markers build/out-marked-stock/output.json
python3 spike.py extract --src build/rw --content body.tex --out build/out-marked --passes 2
python3 check_markers.py build/out-marked/output.json build/rw/marks.json
python3 spike.py extract --src fixture --content body.tex --out build/out-unmarked --passes 2
python3 spike.py compare build/out-marked/output.json build/out-unmarked/output.json --strip-markers-a || true
python3 spike.py extract --src build/rw --content body.tex --out build/out-marked-nolift --laxweb nolift --passes 2
python3 spike.py compare build/out-marked-nolift/output.json build/out-unmarked/output.json --strip-markers-a || true

# P0-4 determinism (raw). The pb determinism needs the venv:
#   python3 -m venv build/venv && build/venv/bin/pip install protobuf fonttools
python3 spike.py extract --src build/rw --content body.tex --out build/out-det1 --passes 2
python3 spike.py extract --src build/rw --content body.tex --out build/out-det2 --passes 2
cmp build/out-det1/output.json build/out-det2/output.json && echo "raw output.json deterministic"

# Transparent derivation: injected standalone main.tex, then amsart.
python3 spike.py inject --src build/rw --out build/inj --passes 2
python3 check_markers.py build/inj/output.json build/rw/marks.json
python3 spike.py compare build/inj/output.json build/out-marked/output.json --drop-leading-a 4 --ignore-fonts || true
python3 spike.py inject --src build/rw --out build/inj-amsart --replace-class amsart --passes 2
python3 spike.py markers build/inj-amsart/output.json

# P1 edges.
python3 spike.py extract --src build/rw --content body.tex --out build/out-geometry --extra-preamble '\usepackage[margin=1in]{geometry}' --passes 2
python3 spike.py compare build/out-geometry/output.json build/out-marked/output.json --ignore-bands || true
python3 spike.py extract --src build/rw --content body.tex --out build/out-setspace --extra-preamble '\usepackage{setspace}\onehalfspacing' --passes 2
python3 spike.py extract --src fixture --content variants/marginpar.tex --out build/out-marginpar --laxweb off --passes 1
python3 spike.py stream build/out-marginpar/output.json
node rewrite-fixture.mjs fixture/variants build/rw-inc --main body-include.tex --only body-include.tex,chapter.tex
cp fixture/preamble.tex build/rw-inc/
python3 spike.py extract --src build/rw-inc --content body-include.tex --out build/out-inc --passes 2
python3 spike.py markers build/out-inc/output.json
python3 spike.py extract --src build/rw-inc --content body-include.tex --out build/out-inc-excl --extra-preamble '\includeonly{nosuch}' --passes 2
python3 spike.py markers build/out-inc-excl/output.json
python3 spike.py extract --src build/rw --content body.tex --out build/out-11pt --class-options 11pt --passes 2
python3 spike.py extract --src fixture --content variants/bib.tex --out build/out-bib --laxweb off --passes 2
python3 spike.py stream build/out-bib/output.json

echo "run-all: done"
