#!/usr/bin/env bash
# Tasks 3 (comparator/check/paranoid + negative tests), 4, 5, 6 in sequence,
# so the timings do not overlap. Run from anywhere; logs land in logs/.
set -u
cd "$(dirname "$0")/../project" || exit 2
export PATH=$HOME/.elan/bin:$PATH
R=../scripts/run-timed.sh
echo "=== start $(date -Is)"
$R comparator-2-warm   lake comparator --config comparator.json
$R check-1             lake check
$R comparator-3-paranoid lake comparator --config comparator.json --paranoid
echo "=== negative tests"
$R neg-a-defeq         lake comparator --config comparator-defeq.json
$R neg-b-sorry         lake comparator --config comparator-sorry.json
$R neg-c-shadow        lake comparator --config comparator-shadow.json
$R neg-c2-shadowboth   lake comparator --config comparator-shadowboth.json
echo "=== task 4: spec-1 style"
$R spec1-ok            lake comparator --config comparator1.json
$R spec1-ax-not-permitted lake comparator --config comparator1-ax-not-permitted.json
$R spec1-relative      lake comparator --config comparator1-relative.json
echo "=== task 5: module system"
$R mod-build-hidden    lake build ModTest.Hidden
$R mod-use-module      lake build ModTest.UseModule
$R mod-use-legacy      lake build ModTest.UseLegacy
$R mod-noheader        lake build NoHeader
echo "=== task 6: replay cost model"
../scripts/replay-cone.sh Mathlib.Data.Nat.Prime.Infinite Nat.exists_infinite_primes cone1-infinite-primes 2>&1 | tee ../logs/replay-cone1.log
../scripts/replay-cone.sh Mathlib.NumberTheory.Bertrand Nat.exists_prime_lt_and_le_two_mul cone2-bertrand 2>&1 | tee ../logs/replay-cone2.log
../scripts/replay-cone.sh Mathlib.Analysis.Real.Pi.Bounds Real.pi_gt_three cone3-pi-gt-three 2>&1 | tee ../logs/replay-cone3.log
$R check-from-export-cone3 lake check --from-export ../logs/replay/cone3-pi-gt-three.export
echo "=== done $(date -Is)"
df -h ~ | tail -1
