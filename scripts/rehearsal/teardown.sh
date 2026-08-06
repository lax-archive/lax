#!/usr/bin/env bash
# Delete the three scratch repositories of a live rehearsal. Destructive and
# irreversible: requires --yes. The two things this cannot do for you — rotate
# the token and delete the ghcr package — are printed at the end.
#
#   OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/teardown.sh --yes
set -euo pipefail

OWNER="${OWNER:-}"
PREFIX="${PREFIX:-lax-scratch}"
CONFIRMED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --yes) CONFIRMED=1; shift ;;
    -h|--help)
      echo "usage: OWNER=<gh-user> [PREFIX=lax-scratch] $0 --yes"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$OWNER" ] || { echo "OWNER is required" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }

CONTROL="$OWNER/$PREFIX-control"
DATABASE="$OWNER/$PREFIX-database"
SUBMISSION="$OWNER/$PREFIX-submission"
CAPTURES="$(printf '%s/%s-captures' "$OWNER" "$PREFIX" | tr '[:upper:]' '[:lower:]')"

if [ "$CONFIRMED" -ne 1 ]; then
  cat >&2 <<EOF
This permanently deletes, with everything in them:

  $CONTROL
  $DATABASE
  $SUBMISSION

Re-run with --yes to proceed.
EOF
  exit 2
fi

# Deleting a repository needs the delete_repo scope, which gh does not request
# by default. Say so before the first failure rather than after it.
gh auth status >/dev/null || { echo "gh is not authenticated" >&2; exit 1; }

for repo in "$CONTROL" "$DATABASE" "$SUBMISSION"; do
  if gh repo view "$repo" >/dev/null 2>&1; then
    gh repo delete "$repo" --yes
    echo "deleted $repo"
  else
    echo "skipped $repo (does not exist)"
  fi
done

cat <<EOF

Two things remain, and neither is scriptable from here:

  1. Rotate LAX_SCRATCH_TOKEN. It was a real personal token with write access
     to the scratch database repository; deleting the environments that held
     it does not revoke it.
       https://github.com/settings/tokens

  2. Delete the capture package ghcr.io/$CAPTURES. Packages outlive the
     repository that published them, and this one is public.
       https://github.com/$OWNER?tab=packages

If gh refused to delete a repository, it lacks the delete_repo scope:
  gh auth refresh -h github.com -s delete_repo
EOF
