# Admin tool plan

Status: designed 2026-08-14; the issue-scoped verbs (`revalidate`,
`delete`, `reset-draft`, `owners`) and a local driver landed 2026-09-04
(spec-notes entry of that date; `scripts/admin/README.md` is the manual).
What landed differs from the text below in three places, recorded here
rather than rewritten so the reasoning stays legible:

- **There is a local tool after all — but it writes nothing.**
  `npm run admin -- <verb>` (`scripts/admin/`) posts the `/lax admin`
  comments and follows them with the maintainer's own `gh` token, exactly
  as `scripts/port-db/` did for the port. The "no standalone tool" rule
  below was about direct database writes and App keys; a driver that only
  comments keeps both doctrines and removes the copy-paste.
- **The typed confirmation lives in the driver**, as it does for
  `lax delete`, instead of the server-side two-phase
  `/lax admin confirm` below. The route job still posts the preview, so
  the issue thread records what was about to happen.
- **No `admin.yml` yet.** `rebuild-website` is a `repository_dispatch`
  the maintainer's token may already send to lax-website; `sweep` is
  `revalidate --all`, ordered dependencies-first by the driver. `verify`,
  `gc-captures`, and `undelete` are not built (TODO.md).

Also decided at implementation: `reset-draft` refuses a record that a
*registered* successor claims (the supersedes caveat below), and a
revalidation must reproduce the recorded supersedes claim — same source,
same manifest — rather than re-admitting it, since the maintainer need not
own the target. The file closes into `history/` once the remaining verbs
land or are struck.

The original design follows.

## Shape: no standalone tool, no direct writes

A local admin tool that writes `lax-database` directly is ruled out by the
secrets doctrine (a maintainer's laptop holds nothing) and by the publisher
invariants: every mutation must go through the schema checks, the
compare-and-swap ref update, and the Website rebuild dispatch. Any direct
push habit eventually skews the database. The same rules out an
`npx admin` script in this repo.

Instead, admin actions reuse the two trusted trigger surfaces that already
exist:

1. **Issue-scoped actions** are `/lax admin <verb>` comments on the
   submission's issue, routed through `submission.yml`'s existing
   route → publish path. The issue thread is the public audit log.
2. **Repo-wide actions** are a new `admin.yml` `workflow_dispatch`
   workflow whose jobs run in the `lax-database-publish` environment,
   triggered from the Actions UI or `gh workflow run`.

`lax admin` CLI sugar can come later, but is deliberately not first:
dispatching workflows needs `Actions: write`, which would broaden the
`lax-cli-publisher` App's power for every CLI user. The Actions "Run
workflow" button plus issue comments cover everything.

## Authorization

Admin = a hardcoded numeric-id allowlist in `src/shared/constants.ts`
(the `GITHUB_ACTIONS_BOT_ID` pattern), checked in route and repeated
credential-free in the trusted publisher per trust rule 2. The list
changes only by reviewed PR to `main` — exactly what the
`lax-database-publish` environment deploys from. No org-membership API
checks; the static list matches the numeric-owner-pair philosophy.

What the admin gate bypasses, relative to ordinary commands
(`control-plane.ts` routeComment): the owner check, the `init`/`draft`
state gate, and the open-issue gate (registered and deleted submissions
live on closed issues — precisely the ones admin must reach).

## Commands

Issue-scoped (`/lax admin <verb>`):

- **`admin delete`** — tombstone regardless of state, including
  `registered`. This is the takedown power; it ties into the open abuse-
  stance item in TODO.md. Keep tombstone fields minimal and neutral —
  moderation *rationale* belongs in the issue comment, not the public
  record (lesson recorded in `history/front-worker-split.md`).
- **`admin reset-draft`** — `registered` → `draft`, for wrongly registered
  records. Dependents keep building (cross-submission edges are rev-pinned
  git requires), but the preview must say so. **Supersedes caveat:** the
  acyclicity of supersedes chains is *proved by* registered-record
  immutability (a claim binds only against an already-registered target, so
  registration order strictly decreases along any chain — see the
  2026-08-23 spec-notes entry). reset-draft breaks that premise: demote B,
  re-submit it claiming its own successor A, and every one-hop check passes
  at re-registration while A↔B is now a cycle. When this verb lands, its
  re-registration path must additionally walk the target's chain and refuse
  a claim that reaches the claimant — or reset-draft must refuse records
  that are a supersedes target or claimant. (An `admin delete` of a
  superseded target is fine as-is: the site generator drops deleted records
  from the model, so the successor's claim dangles harmlessly and the chain
  dissolves.)
- **`admin undelete`** — restore the pre-tombstone record from git
  history. "Deletion is permanent" stays true for authors; admin undo of a
  mistake is what this tool is for.
- **`admin revalidate`** — re-run the full validate pipeline against the
  recorded source and republish artifacts; the per-record version of the
  port-db sweep, and the main tool after pipeline changes.
- **`admin owners [...]`** — replace the owner list without the
  retain-the-commenter rule, to recover orphaned submissions.

Repo-wide (`admin.yml`, one `action` input):

- **`rebuild-website`** — dispatch the site rebuild with no database
  change.
- **`sweep`** — revalidate every record bottom-up in dependency order
  (generalize `scripts/port-db/`, which already knows the shape).
- **`verify`** — read-only integrity audit: schema-check every record,
  capture digests resolvable in ghcr, issue bindings intact, dependency
  closure sound. An archive-level `lax doctor`; needs no confirmation.
- **`gc-captures`** — delete ghcr capture artifacts no live record
  references (tags are documented as mutable and GC-fodder).

Deliberately absent: partial builds. The pipeline is Compile → Replay →
Inspect sequential in one container with nothing persisted between runs,
so server-side "re-run just Inspect" buys little and adds artifact
plumbing; partial iteration is local `lax build`'s job. `revalidate` is
the right server-side granularity.

## Destructive-action workflow

Two-phase confirm on the existing preview/marker machinery
(`src/shared/workflow-comments.ts`):

1. Admin comments `/lax admin delete`.
2. Route validates (admin id, schema) and the bot posts a preview:
   current state, stranded dependents (already computed for
   `deletePreview`), consequences, and the exact confirm command —
   `/lax admin confirm <preview-comment-id>`.
3. Admin posts the confirm; route matches it against the bot preview
   marker; the publish job executes in `lax-database-publish`; result
   comment lands and the Website rebuild is dispatched.
4. Non-destructive verbs (`revalidate`, `verify`, `rebuild-website`) skip
   the confirm.

For `admin.yml` the protection stack is: the environment deploys only
from `main` (only reviewed code runs) plus the in-job allowlist check on
the numeric actor id. Required reviewers on `lax-database-publish` would
add a second pair of eyes per run but would also gate every ordinary
publish — not yet.

## Spec impact

Admin verbs are a deliberate deviation from spec.md's lifecycle:
registered-is-forever and delete-is-permanent each gain the asterisk
*except by maintainer action, publicly logged on the submission issue*.
Record this in spec-notes.md when implementation lands, alongside the
abuse-stance decision it partially implements.
