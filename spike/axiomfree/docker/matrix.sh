#!/usr/bin/env bash
# Runs the bwrap probe under docker with different security options.
# Usage: matrix.sh > ../logs/bwrap-docker.log
IMG=lax-spike-bwrap:v1
PROBE='bwrap --ro-bind / / --tmpfs /tmp --unshare-all --die-with-parent -- /bin/true; echo "exit=$?"'
run() {
  local label="$1"; shift
  echo "### $label"
  echo "docker run --rm $* $IMG sh -c '$PROBE'"
  docker run --rm "$@" "$IMG" sh -c "$PROBE" 2>&1
  echo
}
run "defaults (root)"
run "defaults, --user 1000:1000" --user 1000:1000
run "lax flags: --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 --tmpfs /tmp" --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 --tmpfs=/tmp:rw,nosuid,nodev,size=1073741824
run "seccomp=unconfined" --security-opt seccomp=unconfined
run "apparmor=unconfined" --security-opt apparmor=unconfined
run "seccomp=unconfined + apparmor=unconfined" --security-opt seccomp=unconfined --security-opt apparmor=unconfined
run "cap-add SYS_ADMIN" --cap-add SYS_ADMIN
run "cap-add SYS_ADMIN + seccomp=unconfined" --cap-add SYS_ADMIN --security-opt seccomp=unconfined
run "cap-add SYS_ADMIN + apparmor=unconfined" --cap-add SYS_ADMIN --security-opt apparmor=unconfined
run "cap-add SYS_ADMIN + seccomp=unconfined + apparmor=unconfined" --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined
run "seccomp=unconfined + apparmor=unconfined, --user 1000:1000" --security-opt seccomp=unconfined --security-opt apparmor=unconfined --user 1000:1000
run "lax flags + seccomp=unconfined + apparmor=unconfined" --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 --tmpfs=/tmp:rw,nosuid,nodev,size=1073741824 --security-opt seccomp=unconfined --security-opt apparmor=unconfined
run "--privileged" --privileged
