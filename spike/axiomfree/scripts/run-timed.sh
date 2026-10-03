#!/usr/bin/env bash
# usage: run-timed.sh <tag> <cmd...>   (run from project/; logs to ../logs/<tag>.log)
# Records wall-clock timestamps per output line, /usr/bin/time -v, and the exit code.
set -u
TAG=$1; shift
LOG=../logs/$TAG.log
{
  echo "## $(date -Is) cwd=$(pwd)"
  echo "## cmd: $*"
  echo "## df before: $(df -h ~ | tail -1)"
} > "$LOG"
START=$(date +%s.%N)
/usr/bin/time -v -o "../logs/$TAG.time" "$@" 2>&1 | python3 -u -c '
import sys, time
t0 = time.time()
for line in sys.stdin:
    sys.stdout.write("[%8.2fs] %s" % (time.time() - t0, line)); sys.stdout.flush()
' >> "$LOG"
RC=${PIPESTATUS[0]}
END=$(date +%s.%N)
{
  echo "## exit=$RC wall=$(python3 -c "print(round($END-$START,2))")s"
  echo "## $(grep -E 'Elapsed|Maximum resident' "../logs/$TAG.time" | tr -s ' \t' ' ' | tr '\n' ';')"
  echo "## df after: $(df -h ~ | tail -1)"
} >> "$LOG"
echo "[$TAG] exit=$RC wall=$(python3 -c "print(round($END-$START,2))")s $(grep -E 'Maximum resident' "../logs/$TAG.time" | tr -s ' \t' ' ')"
