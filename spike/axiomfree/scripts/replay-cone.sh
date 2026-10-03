#!/usr/bin/env bash
# Task 6: export one declaration's cone and replay it through every bundled kernel.
# usage: replay-cone.sh <Module> <decl> <tag>
set -u
cd "$(dirname "$0")/../project" || exit 2
export PATH=$HOME/.elan/bin:$PATH
MOD=$1; DECL=$2; TAG=$3
LOGS=../logs/replay
mkdir -p "$LOGS"
BIN=$(lake env printenv LEAN_SYSROOT)/bin
EXP=$LOGS/$TAG.export
echo "## [$TAG] export: lake env leanexport $MOD -- $DECL > $EXP"
/usr/bin/time -v -o "$LOGS/$TAG.export.time" lake env leanexport "$MOD" -- "$DECL" > "$EXP" 2> "$LOGS/$TAG.export.stderr"
echo "exit=$?"
echo "bytes/lines: $(wc -c < "$EXP") $(wc -l < "$EXP")"
grep -E 'Elapsed|Maximum resident' "$LOGS/$TAG.export.time"
[ -s "$LOGS/$TAG.export.stderr" ] && { echo "stderr:"; head -5 "$LOGS/$TAG.export.stderr"; }
run() {
  local name=$1; shift
  echo "## [$TAG] $name: $*"
  /usr/bin/time -v -o "$LOGS/$TAG.$name.time" "$@" > "$LOGS/$TAG.$name.out" 2>&1
  echo "exit=$?"
  grep -E 'Elapsed|Maximum resident' "$LOGS/$TAG.$name.time"
  echo "output (last 3 lines):"; tail -3 "$LOGS/$TAG.$name.out"
}
run leanchecker "$BIN/leanchecker" --silent --from-export "$EXP"
run leanchecker-paranoid "$BIN/leanchecker-paranoid" --silent --from-export "$EXP"
run lean4lean "$BIN/lean4lean" --import "$EXP"
printf '{"use_stdin":false,"export_file_path":"%s","permitted_axioms":["propext","Quot.sound","Classical.choice"],"unpermitted_axiom_hard_error":false,"num_threads":4,"nat_extension":true,"string_extension":true}' "$(realpath "$EXP")" > "$LOGS/$TAG.nanoda.json"
run nanoda "$BIN/nanoda_bin" "$LOGS/$TAG.nanoda.json"
run con-leche "$BIN/con-leche" "$EXP"
run con-ron "$BIN/con-ron" "$EXP"
