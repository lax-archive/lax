#!/usr/bin/env bash
# Lax paper-layer build spike.
#
#   ./build.sh [engine ...]     default: pdflatex lualatex xelatex
#
# For each engine:
#   out/<engine>/run1  rewritten copy, compiled with the injected package
#   out/<engine>/run2  second fresh copy, same compile (determinism check)
#   out/<engine>/plain the author's own build: fixture verbatim, no rewrite,
#                      no -pretex (markers stay comments)
set -uo pipefail

SPIKE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$SPIKE/fixture"
IMAGE="texlive/texlive:TL2025-historic"

export SOURCE_DATE_EPOCH=1700000000
export FORCE_SOURCE_DATE=1

latexmk_flag() {
  case "$1" in
    pdflatex) echo "-pdf" ;;
    lualatex) echo "-lualatex" ;;
    xelatex)  echo "-xelatex" ;;
    *) echo "unknown engine: $1" >&2; exit 2 ;;
  esac
}

# compile <engine> <dir> <pretex:0|1>
compile() {
  local engine="$1" dir="$2" pretex="$3"
  local flag; flag="$(latexmk_flag "$engine")"
  local args=(-"${flag#-}" -interaction=nonstopmode -halt-on-error)
  [ "$pretex" = 1 ] && args+=(-usepretex "-pretex=\\RequirePackage{laxmark}" "-jobname=%A")
  args+=(main.tex)

  if [ "$engine" = xelatex ]; then
    docker run --rm --network=none -v "$SPIKE:/work" -w "/work/${dir#$SPIKE/}" \
      -u "$(id -u):$(id -g)" \
      -e SOURCE_DATE_EPOCH -e FORCE_SOURCE_DATE -e TEXINPUTS="/work:" \
      -e HOME=/tmp \
      "$IMAGE" latexmk "${args[@]}"
  else
    ( cd "$dir" && TEXINPUTS="$SPIKE:" latexmk "${args[@]}" )
  fi
}

run_engine() {
  local engine="$1"
  echo "=================================================================="
  echo "== $engine"
  echo "=================================================================="
  local base="$SPIKE/out/$engine"
  rm -rf "$base"; mkdir -p "$base"

  for run in run1 run2; do
    node "$SPIKE/rewrite.mjs" "$FIXTURE" "$base/$run" \
      --main main.tex --table "$base/$run/marks.json" > "$base/$run.marks.json" || return 1
  done
  cp -r "$FIXTURE" "$base/plain"

  local ok=1
  for run in run1 run2; do
    echo "--- compile $engine/$run (rewritten, -pretex)"
    compile "$engine" "$base/$run" 1 > "$base/$run.build.log" 2>&1 || { ok=0; echo "FAILED (see $base/$run.build.log)"; }
  done
  echo "--- compile $engine/plain (author build, no rewrite, no pretex)"
  compile "$engine" "$base/plain" 0 > "$base/plain.build.log" 2>&1 || { ok=0; echo "FAILED (see $base/plain.build.log)"; }

  echo
  echo "-- bibliography"
  grep -oE "Running 'bibtex[^']*'|Running 'biber[^']*'" "$base/run1.build.log" | sort -u
  [ -f "$base/run1/main.bbl" ] && echo "main.bbl written: $(grep -c bibitem "$base/run1/main.bbl") \\bibitem entries"
  echo "undefined citations in main.log: $(grep -c "Citation.*undefined" "$base/run1/main.log" 2>/dev/null; true)"
  if [ -f "$base/run1.txt" ] || pdftotext -layout "$base/run1/main.pdf" "$base/run1.txt" 2>/dev/null; then
    grep -qE '^\[1\]' "$base/run1.txt" && echo "citations resolved: yes (numbered bibliography present)" || echo "citations resolved: NO"
  fi

  echo
  echo "-- determinism"
  if [ -f "$base/run1/main.pdf" ] && [ -f "$base/run2/main.pdf" ]; then
    sha256sum "$base/run1/main.pdf" "$base/run2/main.pdf"
    if [ "$(sha256sum < "$base/run1/main.pdf")" = "$(sha256sum < "$base/run2/main.pdf")" ]; then
      echo "byte-identical: YES"
    else
      echo "byte-identical: NO"
      cmp -l "$base/run1/main.pdf" "$base/run2/main.pdf" | head -20
    fi
  fi

  echo
  echo "-- layout diff (rewritten vs author build)"
  if [ -f "$base/run1/main.pdf" ] && [ -f "$base/plain/main.pdf" ]; then
    p1=$(pdfinfo "$base/run1/main.pdf" | awk '/^Pages/{print $2}')
    p2=$(pdfinfo "$base/plain/main.pdf" | awk '/^Pages/{print $2}')
    echo "pages: rewritten=$p1 plain=$p2"
    pdftotext -layout "$base/run1/main.pdf" "$base/run1.txt"
    pdftotext -layout "$base/plain/main.pdf" "$base/plain.txt"
    if diff -q "$base/run1.txt" "$base/plain.txt" >/dev/null; then
      echo "pdftotext -layout: IDENTICAL"
    else
      echo "pdftotext -layout: DIFFERS"
      diff -u "$base/plain.txt" "$base/run1.txt" | head -40
    fi
  fi

  echo
  echo "-- extract"
  node "$SPIKE/extract.mjs" "$base/run1/main.pdf" "$base/run1/marks.json" | tee "$base/extract.json.txt"
  return 0
}

engines=("$@")
[ ${#engines[@]} -eq 0 ] && engines=(pdflatex lualatex xelatex)
for e in "${engines[@]}"; do run_engine "$e"; done
