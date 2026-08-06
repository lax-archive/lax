#!/usr/bin/env bash
# Stand up the three scratch repositories of the pre-release live rehearsal
# recorded in history/live-rehearsal.md. Creates nothing outside the three
# repos it names, refuses to touch any that already exist, and never places
# the credential: the token is yours to install (the commands are printed).
#
#   OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/setup.sh
#
# See scripts/rehearsal/README.md.
set -euo pipefail

OWNER="${OWNER:-}"
PREFIX="${PREFIX:-lax-scratch}"
TITLE="${TITLE:-Even squares}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    -h|--help)
      echo "usage: OWNER=<gh-user> [PREFIX=lax-scratch] [TITLE='Even squares'] $0"
      echo "       $0 --owner <gh-user> [--prefix lax-scratch] [--title 'Even squares']"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OWNER" ]; then
  echo "OWNER is required (e.g. OWNER=jan3er PREFIX=lax-scratch $0)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTROL="$OWNER/$PREFIX-control"
DATABASE="$OWNER/$PREFIX-database"
SUBMISSION="$OWNER/$PREFIX-submission"
CAPTURES="$(printf '%s/%s-captures' "$OWNER" "$PREFIX" | tr '[:upper:]' '[:lower:]')"

say() { printf '\n== %s\n' "$1"; }

# --- preflight ---------------------------------------------------------------
for tool in gh git node; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done
gh auth status >/dev/null || { echo "gh is not authenticated; run: gh auth login" >&2; exit 1; }

# Guard: a rehearsal must start from nothing. Reusing a repo would carry over
# database state, issue numbers, and secrets from the previous run.
for repo in "$CONTROL" "$DATABASE" "$SUBMISSION"; do
  if gh repo view "$repo" >/dev/null 2>&1; then
    echo "refusing to continue: $repo already exists (run scripts/rehearsal/teardown.sh --yes first)" >&2
    exit 1
  fi
done

if [ ! -f "$REPO_ROOT/dist/cli/scaffold.js" ]; then
  echo "dist/ is missing; run 'npm run build' in $REPO_ROOT first" >&2
  exit 1
fi
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  # The staged tree is `git ls-files` taken from the working tree: uncommitted
  # edits to tracked files DO reach the rehearsal, untracked files do NOT.
  echo "note: the working tree is dirty. Uncommitted edits to tracked files are rehearsed;" >&2
  echo "      untracked files are not. Commit first if that distinction matters." >&2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

commit_and_push() {
  # $1 = directory, $2 = owner/repo, $3 = commit message
  git -C "$1" init -q -b main
  git -C "$1" add -A
  git -C "$1" -c user.name="lax rehearsal" -c user.email="rehearsal@localhost" \
    commit -q -m "$3"
  git -C "$1" remote add origin "https://github.com/$2.git"
  # Authenticate through gh for this push only; never touch the user's config.
  git -C "$1" -c credential.helper= -c credential.helper='!gh auth git-credential' \
    push -q -u origin main
}

# --- 1. control repository ---------------------------------------------------
say "staging the scratch control tree"
CONTROL_TREE="$WORK/control"
mkdir -p "$CONTROL_TREE"
# Tracked files only, taken from the working tree: dist/, node_modules/ and
# .build/ are gitignored and must not reach the scratch repo.
( cd "$REPO_ROOT" && git ls-files -z | tar --null --files-from=- --create --file=- ) \
  | tar --extract --file=- --directory="$CONTROL_TREE"

# Deviation (c): the rehearsal exercises the submission control plane only.
rm -f "$CONTROL_TREE/.github/workflows/ci.yml" "$CONTROL_TREE/.github/workflows/release.yml"

# Deviations (a) and (b), derived from the live submission.yml at run time.
node "$REPO_ROOT/scripts/rehearsal/patch-workflow.mjs" \
  --owner "$OWNER" --prefix "$PREFIX" \
  --input "$REPO_ROOT/.github/workflows/submission.yml" \
  --output "$CONTROL_TREE/.github/workflows/submission.yml"

say "creating $CONTROL"
gh repo create "$CONTROL" --public \
  --description "Disposable Lax rehearsal control plane. Not for merge." >/dev/null
commit_and_push "$CONTROL_TREE" "$CONTROL" \
  "Lax rehearsal control plane (patched submission.yml; see its header)"

REPOSITORY_ID="$(gh api "repos/$CONTROL" --jq .id)"
[ -n "$REPOSITORY_ID" ] || { echo "could not read the numeric id of $CONTROL" >&2; exit 1; }
gh variable set LAX_REPOSITORY_ID --repo "$CONTROL" --body "$REPOSITORY_ID" >/dev/null
echo "LAX_REPOSITORY_ID=$REPOSITORY_ID"

# The two protected environments the workflow jobs declare. LAX_SCRATCH_TOKEN
# lives only inside them, mirroring the production credential posture.
for environment in lax-database-publish lax-website-dispatch; do
  gh api --method PUT "repos/$CONTROL/environments/$environment" --silent
  echo "environment $environment created"
done

# --- 2. database repository (also stands in for lax-website) -----------------
say "creating $DATABASE"
DATABASE_TREE="$WORK/database"
mkdir -p "$DATABASE_TREE/.github/workflows"
cat > "$DATABASE_TREE/README.md" <<EOF
# $PREFIX-database

Disposable stand-in for \`lax-archive/lax-database\` during a Lax pre-release
rehearsal (see \`history/live-rehearsal.md\` in the lax repository). It also
stands in for \`lax-archive/lax-website\`: the workflow below receives the
\`lax-db-updated\` repository dispatch so the Website rebuild request is
visible. Production \`lax-database\` carries no workflow files at all.

Delete this repository once the rehearsal has been reviewed.
EOF
# Careful: no ": " inside a plain YAML scalar anywhere below. An invalid
# receiver produced a phantom failed run for every lax-publish/<sha> staging
# ref push during the first rehearsal.
cat > "$DATABASE_TREE/.github/workflows/website-dispatch-receiver.yml" <<'EOF'
name: website dispatch receiver
on:
  repository_dispatch:
    types: [lax-db-updated]
jobs:
  receive:
    runs-on: ubuntu-latest
    steps:
      - name: Record the received dispatch
        env:
          PAYLOAD: ${{ toJSON(github.event.client_payload) }}
        run: printf '%s\n' "$PAYLOAD" >> "$GITHUB_STEP_SUMMARY"
EOF
gh repo create "$DATABASE" --public \
  --description "Disposable Lax rehearsal database and website-dispatch receiver." >/dev/null
commit_and_push "$DATABASE_TREE" "$DATABASE" "Rehearsal database root commit and dispatch receiver"

# --- 3. submission repository ------------------------------------------------
say "creating $SUBMISSION"
SUBMISSION_TREE="$WORK/submission"
mkdir -p "$SUBMISSION_TREE"
# Issue #1 in the fresh control repo owns lax-1, so scaffold for that number.
# LAX_MATHLIB_* are test seams: unset them so the scaffold pins the real
# mathlib the trusted validation will build against.
env -u LAX_MATHLIB_URL -u LAX_MATHLIB_REV \
  SUBMISSION_TREE="$SUBMISSION_TREE" \
  SUBMISSION_TITLE="$TITLE" \
  SUBMISSION_OWNER="$OWNER" \
  SCAFFOLD_MODULE="$REPO_ROOT/dist/cli/scaffold.js" \
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { scaffoldSubmission } = await import(pathToFileURL(process.env.SCAFFOLD_MODULE).href);
    scaffoldSubmission(
      process.env.SUBMISSION_TREE,
      1,
      process.env.SUBMISSION_TITLE,
      process.env.SUBMISSION_OWNER,
    );
  '

# The even-squares content, shaped like test/e2e/real-mathlib.test.ts.
cat > "$SUBMISSION_TREE/abstract.md" <<'EOF'
The square of an even natural number is even. A rehearsal submission: the
smallest statement that still exercises a mathlib import in the concept
package and a real tactic proof in the proof package.
EOF
printf 'import Lax1.Squares\n' > "$SUBMISSION_TREE/concepts/Lax1.lean"
cat > "$SUBMISSION_TREE/concepts/Lax1/Squares.lean" <<'EOF'
import Mathlib.Algebra.Group.Even

/-!
---
title: Even squares
type: theorem
---
The square of an even natural number is even.
-/

namespace Lax1.Squares

/-- if n is even, so is n * n -/
axiom evenSquare : ∀ n : ℕ, Even n → Even (n * n)

end Lax1.Squares
EOF
printf 'import Lax1Proofs.Basic\n' > "$SUBMISSION_TREE/proofs/Lax1Proofs.lean"
cat > "$SUBMISSION_TREE/proofs/Lax1Proofs/Basic.lean" <<'EOF'
import Lax1.Squares
import Mathlib.Tactic.Ring

namespace Lax1Proofs

/--
---
conclusion: Lax1.Squares.evenSquare
---
unfold evenness and close with ring
-/
theorem even_square : ∀ n : ℕ, Even n → Even (n * n) := by
  rintro n ⟨r, rfl⟩
  exact ⟨(r + r) * r, by ring⟩

end Lax1Proofs
EOF

gh repo create "$SUBMISSION" --public \
  --description "Disposable lax-1 rehearsal submission (even squares)." >/dev/null
commit_and_push "$SUBMISSION_TREE" "$SUBMISSION" "lax-1: even squares"
SUBMISSION_COMMIT="$(git -C "$SUBMISSION_TREE" rev-parse HEAD)"

# --- what is left for you ----------------------------------------------------
cat <<EOF

== Scratch repositories created

  control     https://github.com/$CONTROL   (LAX_REPOSITORY_ID=$REPOSITORY_ID)
  database    https://github.com/$DATABASE   (also the website-dispatch receiver)
  submission  https://github.com/$SUBMISSION  @ $SUBMISSION_COMMIT
  captures    ghcr.io/$CAPTURES  (created on the first push by the workflow)

== Credential step -- yours to run, this script never places a token

Create a short-lived personal access token that can write contents to
$DATABASE and send it a repository dispatch (a classic token with the "repo"
scope, or a fine-grained token limited to $DATABASE with Contents write).
Then put it in BOTH environments, and nowhere else:

  gh secret set LAX_SCRATCH_TOKEN --repo $CONTROL --env lax-database-publish
  gh secret set LAX_SCRATCH_TOKEN --repo $CONTROL --env lax-website-dispatch

(each command prompts for the value; do not pass it on the command line)

== Round trips

  OWNER=$OWNER PREFIX=$PREFIX scripts/rehearsal/drive.sh

That opens issue #1, then drives /lax submit, /lax register, and the
post-registration rejection probe, reporting per-job conclusions. Local build
of the submission first, if you want the fast failure:

  npm run lax -- build <clone of $SUBMISSION>

== Teardown

  OWNER=$OWNER PREFIX=$PREFIX scripts/rehearsal/teardown.sh --yes
EOF
