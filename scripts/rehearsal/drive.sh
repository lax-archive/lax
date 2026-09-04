#!/usr/bin/env bash
# Drive the four round trips of the pre-release live rehearsal against the
# scratch repositories scripts/rehearsal/setup.sh created, and check the
# evidence history/live-rehearsal.md records for each of them.
#
#   OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/drive.sh
#
# Exits nonzero if any expected outcome is missed. Safe to read the output as
# the rehearsal transcript: every job conclusion is printed as it lands.
set -euo pipefail

OWNER="${OWNER:-}"
PREFIX="${PREFIX:-lax-scratch}"
TITLE="${TITLE:-Even squares}"
ISSUE="${ISSUE:-1}"
# The slowest round trip is the cold validation (~5 min author-visible in the
# 2026-08-06 rehearsal); a cold Actions cache adds the toolchain provision.
RUN_TIMEOUT="${RUN_TIMEOUT:-2400}"
START_TIMEOUT="${START_TIMEOUT:-300}"
POLL="${POLL:-15}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    -h|--help)
      echo "usage: OWNER=<gh-user> [PREFIX=lax-scratch] $0"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OWNER" ] || { echo "OWNER is required" >&2; exit 2; }

command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
CONTROL="$OWNER/$PREFIX-control"
SUBMISSION="$OWNER/$PREFIX-submission"

FAILURES=0
say() { printf '\n== %s\n' "$1"; }
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

for repo in "$CONTROL" "$SUBMISSION"; do
  gh repo view "$repo" >/dev/null 2>&1 || {
    echo "$repo does not exist; run scripts/rehearsal/setup.sh first" >&2
    exit 1
  }
done

# --- run correlation ---------------------------------------------------------
# Runs are correlated by identity, not by timestamp: remember the ids that
# existed before the trigger and wait for one that did not.
run_ids() {
  gh run list --repo "$CONTROL" --limit 60 --json databaseId --jq '.[].databaseId'
}

wait_for_new_run() {
  # $1 = file holding the ids that existed before the trigger
  local before="$1" deadline id
  deadline=$(( $(date +%s) + START_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    while read -r id; do
      [ -n "$id" ] || continue
      if ! grep -qx "$id" "$before"; then
        echo "$id"
        return 0
      fi
    done < <(run_ids)
    sleep "$POLL"
  done
  echo "timed out after ${START_TIMEOUT}s waiting for a workflow run to start" >&2
  return 1
}

wait_for_completion() {
  local id="$1" deadline status
  deadline=$(( $(date +%s) + RUN_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(gh run view "$id" --repo "$CONTROL" --json status --jq .status)"
    if [ "$status" = "completed" ]; then return 0; fi
    sleep "$POLL"
  done
  echo "timed out after ${RUN_TIMEOUT}s waiting for run $id to complete" >&2
  return 1
}

report_jobs() {
  local id="$1"
  printf '  run https://github.com/%s/actions/runs/%s\n' "$CONTROL" "$id"
  gh run view "$id" --repo "$CONTROL" --json jobs \
    --jq '.jobs[] | "    \(.conclusion // .status)\t\(.name)"'
}

job_conclusion() {
  # $1 = run id, $2 = job display name; prints "" when the job never ran.
  # gh's --jq takes one expression and no --arg, so the name is interpolated;
  # job names are fixed strings from submission.yml and contain no quotes.
  gh run view "$1" --repo "$CONTROL" --json jobs \
    --jq "[.jobs[] | select(.name == \"$2\") | .conclusion][0] // \"\""
}

expect_job() {
  # $1 = run id, $2 = job display name, $3 = expected conclusion
  local actual
  actual="$(job_conclusion "$1" "$2")"
  if [ "$actual" = "$3" ]; then pass "$2 = $3"; else fail "$2 = ${actual:-<absent>}, expected $3"; fi
}

refute_job_success() {
  local actual
  actual="$(job_conclusion "$1" "$2")"
  if [ "$actual" = "success" ]; then fail "$2 must not have succeeded"; else pass "$2 did not succeed (${actual:-absent})"; fi
}

expect_log() {
  # $1 = run id, $2 = job display name, $3 = fixed string its log must carry.
  # Job logs are the only place the per-environment plumbing of
  # environments-plan.md stage 2 is visible: the gate's selection, the cache
  # key the restore step used, the provisioning line, the publisher's lookup.
  local job_id
  job_id="$(gh run view "$1" --repo "$CONTROL" --json jobs \
    --jq "[.jobs[] | select(.name == \"$2\") | .databaseId][0] // \"\"")"
  if [ -n "$job_id" ] && gh run view --repo "$CONTROL" --job "$job_id" --log 2>/dev/null | grep -qF -- "$3"; then
    pass "$2 log: $3"
  else
    fail "$2 log lacks: $3"
  fi
}

# Trigger something, then wait for and report the run it produced. Prints the
# run id on stdout; all human-readable output goes to stderr so the caller can
# capture the id.
drive() {
  # $1 = label, then the command to run as the trigger
  local label="$1"; shift
  local before id
  before="$(mktemp)"
  run_ids > "$before"
  say "$label" >&2
  "$@" >&2
  id="$(wait_for_new_run "$before")"
  rm -f "$before"
  wait_for_completion "$id" >&2
  report_jobs "$id" >&2
  echo "$id"
}

open_issue() {
  local url number
  url="$(gh issue create --repo "$CONTROL" --title "$TITLE" \
    --body "Rehearsal submission. Driven by scripts/rehearsal/drive.sh.")"
  number="${url##*/}"
  printf '  issue %s\n' "$url"
  if [ "$number" != "$ISSUE" ]; then
    echo "the new issue is #$number but the scaffolded submission is lax-$ISSUE" >&2
    exit 1
  fi
}

comment() {
  gh issue comment "$ISSUE" --repo "$CONTROL" --body "$1" >/dev/null
  printf '  posted: %s\n' "${1:0:80}"
}

# --- round trip 1: issue opened -> stub publication --------------------------
RUN1="$(drive "round trip 1/4 -- open the issue" open_issue)"
expect_job "$RUN1" route success
expect_job "$RUN1" publish success

# --- round trip 2: /lax submit -> validation and publication -----------------
COMMIT="$(gh api "repos/$SUBMISSION/commits/main" --jq .sha)"
SUBMIT="/lax submit {\"repository\":\"https://github.com/$SUBMISSION\",\"commit\":\"$COMMIT\",\"folder\":\".\"}"
RUN2="$(drive "round trip 2/4 -- /lax submit" comment "$SUBMIT")"
expect_job "$RUN2" route success
expect_job "$RUN2" Validate success
expect_job "$RUN2" publish-submit success
# The environment the submission names is the one the whole run must serve:
# the gate selects it, the cache restore is keyed on it (hit or miss, the
# cache action prints the key it looked for), setup-vm provisions exactly it,
# and the publisher looks it up before minting. The id is read from the
# submitted manifest itself, not assumed to be the epoch.
ENVIRONMENT="$(gh api "repos/$SUBMISSION/contents/manifest.yaml?ref=$COMMIT" --jq .content \
  | base64 --decode | sed -n 's/^leanVersion: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
[ -n "$ENVIRONMENT" ] || { echo "could not read leanVersion from the submitted manifest" >&2; exit 1; }
expect_log "$RUN2" Validate "lax gate: environment $ENVIRONMENT "
expect_log "$RUN2" Validate "lax-validation-host-v2-Linux-$ENVIRONMENT-"
expect_log "$RUN2" Validate "lax setup: provisioning environment $ENVIRONMENT"
expect_log "$RUN2" Validate "lax setup: ensuring the warm mathlib workspace for $ENVIRONMENT"
expect_log "$RUN2" publish-submit "lax publish: environment $ENVIRONMENT "

# --- round trip 3: /lax register ---------------------------------------------
RUN3="$(drive "round trip 3/4 -- /lax register" comment "/lax register")"
expect_job "$RUN3" route success
expect_job "$RUN3" publish success

# --- round trip 4: the negative probe ----------------------------------------
# A registered record is immutable: the route job must reject the submit before
# anything privileged runs, and say so on the issue.
MARK="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN4="$(drive "round trip 4/4 -- post-registration /lax submit must be rejected" comment "$SUBMIT")"
expect_job "$RUN4" route failure
refute_job_success "$RUN4" Validate
refute_job_success "$RUN4" publish-submit
refute_job_success "$RUN4" publish
if gh api "repos/$CONTROL/issues/$ISSUE/comments?per_page=100" --paginate \
    --jq ".[] | select(.created_at > \"$MARK\") | .body" \
    | grep -qF "is registered and cannot be changed"; then
  pass "the rejection was reported on the issue"
else
  fail "no 'is registered and cannot be changed' comment appeared on the issue"
fi

# --- verdict -----------------------------------------------------------------
say "result"
printf '  database   https://github.com/%s/commits/main\n' "$OWNER/$PREFIX-database"
printf '  dispatches https://github.com/%s/actions\n' "$OWNER/$PREFIX-database"
printf '  captures   https://github.com/%s?tab=packages\n' "$OWNER"
if [ "$FAILURES" -eq 0 ]; then
  echo "  all four round trips matched history/live-rehearsal.md"
  exit 0
fi
echo "  $FAILURES expectation(s) missed" >&2
exit 1
