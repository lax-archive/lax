#!/usr/bin/env bash
# Runs `lake comparator` inside the container with lax's run flags plus the two
# security options the bwrap probe needed. The toolchain and the project are
# bind-mounted at their host paths so the comparator's own bwrap can re-bind them.
# usage: comparator-in-docker.sh <label> [extra docker flags...]
set -u
LABEL=$1; shift
TC=$HOME/.elan/toolchains/leanprover--lean4---v4.35.0-rc3
PROJECT=$(cd "$(dirname "$0")/../project" && pwd)
LOG=$PROJECT/../logs/docker-comparator-$LABEL.log
{
  echo "## $(date -Is)"
  echo "## docker run ... $* lax-spike-bwrap:v2 lake comparator --config comparator.json"
  /usr/bin/time -v docker run --rm \
    --read-only --cap-drop=ALL --security-opt=no-new-privileges --user "$(id -u):$(id -g)" \
    --tmpfs=/tmp:rw,nosuid,nodev,size=1073741824 --network=none \
    --memory=8g --memory-swap=8g --cpus=4 --pids-limit=512 \
    --mount "type=bind,src=$TC,dst=$TC,readonly" \
    --mount "type=bind,src=$PROJECT,dst=$PROJECT" \
    -e "HOME=/tmp/home" -e "PATH=$TC/bin:/usr/local/bin:/usr/bin:/bin" \
    --workdir "$PROJECT" "$@" lax-spike-bwrap:v2 \
    sh -c 'mkdir -p /tmp/home /run/user && lake comparator --config comparator.json; echo "comparator exit=$?"'
  echo "## docker exit=$?"
} > "$LOG" 2>&1
grep -v -E 'Average|page faults|context switches|Swaps|File system|Socket|Signals|Page size|unshared|shared text|trace:' "$LOG"
