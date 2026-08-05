# Spec amendment notes

Proposed amendments to [spec.md](spec.md), written while implementing — one
entry per change, with the implemented behavior and the reason it diverges
from or refines the current text. To be folded into the spec manually; this
file is not normative. (Entries of earlier milestones were folded into
spec.md on 2026-07-22 and removed here.)

## Multiple statements per concept (implemented, 2026-08-06)

**Supersedes "One statement per concept" below**, which is now history. A
concept module may declare any number of axioms; every one of them is a
statement of that concept, with its own id, and each may independently be
the `conclusion` of a proof or appear in an `assumptions` set. The
`one-statement` violation kind no longer exists. Reason (rewrite.md,
"multiple statements per concept"): the bound existed for the website —
one concept, one status — and Jan has a presentation for several
statements per concept (anonymous per-statement indices in the proof
network and proof list), so the backend constraint is no longer bought by
anything. That presentation is lax-website work; nothing in this
repository presents statements.

The `type`-frontmatter consistency questions one-axiom-plan.md raised
(theorem/lemma/proposition/corollary ⇒ exactly one axiom, definition ⇒
zero) stay **deliberately punted**, per rewrite.md: `type` remains a
required key with a free prose value and nothing mechanical hangs off it.

Record schema unchanged — `statements` was always an array, and the
trusted artifact parser's cap on it (previously 1) is now just a size
bound — so no `specVersion` bump and no re-verdict machinery.

Spec touchpoint: **none, and that is the point.** The superseded entry's
amendment was never folded in: spec.md §Concept packages still reads
"The statements of a concept are the axioms whose module of origin it
is" (plural, no cardinality), which is exactly the restored rule. The
cardinality sentence that entry proposed must simply not be added.

## GitHub Actions rewrite: control plane and auth model (implemented, 2026-08-05)

This repository is the rewrite of the archive onto GitHub Actions (charter:
rewrite.md + rewrite-plan.md). Spec-relevant deviations of the new
architecture, recorded here until the spec is reconciled:

- **The archive server is gone.** GitHub issues are the control surface:
  the issue number permanently determines the id (`#42` → `lax-42`), `/lax`
  issue comments request state changes, and trusted Actions jobs publish
  them. The database is the public `lax-archive/lax-database` repository,
  written through the GitHub API with a non-forced ref update
  (compare-and-swap) instead of the spec's single-writer server lock;
  dependency captures are published as immutable GitHub Releases.
- **Auth model changed.** The CLI authenticates with a GitHub App user
  access token (`ghu_`) obtained via the App device flow; refresh tokens
  rotate in `~/.lax/credentials.json`. This supersedes the OAuth-App
  device flow + `LAX_GITHUB_TOKEN` fallback recorded in the "Go-live"
  entry below — PATs and generic OAuth tokens are now rejected, and a
  `LAX_GITHUB_TOKEN` override is intentionally unsupported
  (`LAX_GITHUB_APP_USER_TOKEN` exists for non-interactive use). App
  private keys and installation tokens exist only in trusted workflow
  jobs, never in the CLI.
- Spec touchpoints: the server/Actions sections, the auth paragraphs, and
  the single-writer/locking language. README.md documents the full trust
  model; rewrite-plan.md lists the further planned deviations (sibling
  path requires removed, multiple statements per concept, single
  validation job).

## spec.md edited by the rewrite: continuous preview (needs reconciliation, 2026-08-05)

Commit `01e4700` inserted a subsection "Continuous preview while authoring"
into this repo's spec.md (after the ~line-1026 serve/build material) —
an agent edit, contrary to the do-not-edit rule, flagged here for Jan to
bless in place or strip. Its substance, so stripping loses nothing: keep
`lax serve` running in one terminal and run `lax build` after each
completed proof in another; a successful full build atomically replaces
`build-output.json` and regenerates the preview, while failures and
`--only concepts|proofs` builds deliberately leave the preview at the last
validated milestone. The behavior is implemented and uncontroversial; only
its normative placement needs the call.

## Concept dialect: second draft, advisory model (proposed, 2026-07-29)

[spec_conceptdialect_draft.md](spec_conceptdialect_draft.md) is a proposed
replacement for spec_conceptdialect.md, written after the first real corpus
existed (nine submissions, ~4,800 lines of concept source) and revised
twice the same day after two rounds of review. Until Jan reconciles it,
spec_conceptdialect.md stands — **with the security hole of the next
bullet still open in it**. The deltas, in short:

- **The mention rule (list 8), closing a hole both drafts shared.** The
  second review found the safety argument false as written: it claimed
  code runs only where a *name in the source* selects a program, and
  closed each such position with a list of admissible syntax forms.
  `autoParam` breaks that. Its signature in the pin is
  `abbrev autoParam (α : Sort u) (tactic : Lean.Syntax) : Sort u`
  (Init/Tactics.lean, 4.30.0) — the tactic to run is a **data value**, so
  an author can apply the constant to a `Syntax` they assembled from
  ordinary inductive constructors, leave a structure field open, and have
  the elaborator run `run_tac` (hence arbitrary IO) while every node in
  the file's syntax tree is whitelisted. No tree-walk can see it;
  `Lean.reduceBool`, which makes the *kernel* run compiled code, is the
  same shape. The fix is a second axis: a rule over **resolved names** —
  no `autoParam`/`optParam`, and nothing in the `Lean` namespace or whose
  type mentions a type from it. Consequences: the door list gains the
  value-door entry, the term snapshot's generation-time exclusions gain
  name literals (three entries now), the gate gains an identifier-
  resolution check before elaborating each command plus an info-tree
  check afterwards for the spellings that need elaboration to resolve
  (dot-notation, field notation), and the schema file gains a generated
  excluded-name set beside the term snapshot. The after-the-fact half
  reads **source occurrences from the info tree, never the elaborated
  Exprs**: a concept extending a mathlib structure inherits `autoParam`
  and `Lean.Syntax` into its own types without mentioning them, so an
  Expr scan would mislabel legitimate mathematics. Deferring that half is
  sound because applying a constant to a fabricated `Syntax` runs
  nothing; only `autoParam` does, and it is a bare root-level name that
  cannot be dot-notated, so the pre-elaboration check always sees it.
  The invariant the rule actually protects is not "no `autoParam` in a
  concept" (inherited ones and the `(h : P := by simp)` field default are
  both fine) but: every tactic that runs was either chosen by pinned code
  or written out in a `by` block that passed the tactic list.
  Verified: **zero** mentions of any excluded name across the 264
  authored concept files in `~/git/lax-submissions`, so the rule costs
  the corpus nothing. Honest cost to the design: list 8 is a blacklist,
  the only one in the document — a whitelist over names is impossible —
  so its completeness is an audit, mechanized as a generated set whose
  diff is reviewed at each pin bump. The draft now says so in three
  places rather than claiming there are no blacklists.

- **Advisory, not blocking (Jan's call)**: "safe dialect" is a label, a
  moving target fixable later — every submit records an own-package
  verdict (pass/fail + dialectVersion, never a violation), *safe* is
  derived transitively (own pass ∧ all concept deps safe), the website
  displays it, and the CLI warns pre-Compile naming every closure member
  that is not safe (off-dialect concepts, foreign proof packages,
  unknowns) — nothing is ever refused. Replaces the first draft's
  admission gate, the `--allow-foreign-proofs` flag (gone;
  `--require-safe` reserved as strict opt-in), and the entire
  quarantine/verdict-voiding evolution ceremony (any schema change = one
  batch re-verification in dependency order). Anti-forgery rule: the gate
  loads dependency artifacts only when their own verdict is `pass`.
- **Tactics: closers only** (eleven one-step closers + termination
  annotations; no conv sub-language), enabled by restructuring the corpus
  instead of growing the dialect: the survey found the only real tactic
  proofs in Lax3's ScatterChoice witnesses (verification content — moves
  to the proof package; no concept references the witnesses, verified)
  and two off-dialect forms in Lax5 (`@[implicit_reducible]`,
  `deriving Language.IsRelational` — on-dialect substitutions). The
  restructure plan lives in
  `lax-submissions/plans/submission-polish.md`, "Dialect-driven
  restructures"; after it the corpus needs zero tactics in concepts.
- **Term layer becomes a literal whitelist**: the origin rule
  ("background-registered minus a ban list") is replaced by a generated,
  checked-in snapshot of every term-category syntax kind the pinned
  background registers, with the two capability exclusions (`include_str`,
  syntax quotations) applied at generation time and the snapshot *diff*
  reviewed on every pin bump. Same audit as before; the audited object is
  now an explicit file. Adds a dump mode to the gate executable.
- **Restructured** into an author-facing Part I (readable by a Lean
  non-expert, per the design goal) and a condensed enforcement Part II;
  gate mechanism, capture isolation/provenance, and the non-goals carry
  over unchanged.

## Inline math in authored prose (implemented, 2026-07-29)

Abstracts and concept/proof annotation prose render inline expressions
delimited by either `$...$` or backticks through KaTeX. Backticks are a
site-level shorthand on these author-authored surfaces only: site-owned
Markdown retains ordinary inline-code semantics, and fenced code blocks
remain code everywhere. Invalid expressions are shown verbatim with the
existing math-error treatment rather than disappearing.

Spec touchpoints: abstract Markdown rendering and the concept/proof annotation
body semantics.

## Submission deletion: `lax delete` and the `deleted` state (implemented, 2026-07-29)

spec.md's Lifecycle lists three states and five transitions, and its Actions
say the CLI has "three write actions". Authors need a way to throw away a
mistake before it is registered, so both grow by one.

- **A fourth state, `deleted`, and two transitions:** `init -> deleted` and
  `draft -> deleted`. `registered` remains terminal and immutable — deletion
  is exactly as impossible there as re-drafting.
- **`deleted` is a tombstone, not a removal.** The record folder survives
  with a `record.json` carrying `{specVersion, id, state, createdAt, owners,
  deletedAt}`: no source triple, and `build-output.json` is deleted. The
  content leaves the archive; the *id* does not come back. This is the whole
  reason the folder stays — the server allocates the next id by counting
  record folders, so removing one would hand a retired id to a different
  submission, and a citation, a store capture or an external link pointing at
  `LaxN` would silently mean something else. A tombstone also lets the
  archive explain an absence rather than 404 into nothing.
- **The delete is `POST /delete` with `{id}`**, one endpoint per write
  action as before, gated by the same allowlist and ownership rules as
  `set-owners`: the actor must be an owner, and the record must be mutable.
  Refusals are 409 for a registered record (as elsewhere) and **410 Gone**
  for one already deleted — a distinct status because "this id will never
  work again" is a different answer from "you may not do this now".
- **Every other write refuses a tombstone through the same gate.** Submit
  (single and every member of a wave), re-submit, set-owners and a second
  delete all fail with the 410 above, because they share `requireMutable`.
  A submit already in flight when its record is deleted fails at the
  trusted half's re-validation under the write lock; the drafted prefix of
  a wave stands, as it does for every other mid-wave failure.
- **The website skips deleted records entirely** — no page, no listing, no
  graph node, not counted in the statistics — keyed on the state rather
  than on the missing build-output, so a stale clone cannot resurrect a
  page.
- **A deleted dependency is named as deleted.** Resolution and the CLI's
  submit pre-flight report "was deleted … its id is retired" instead of
  their generic misses, and deliberately omit the "your database may be
  stale, try `lax update-db`" hint the other misses carry: deletion is
  monotone, so a refresh can never bring the record back. The advice to
  submit both folders together is likewise suppressed for a deleted path
  target, since no wave can resurrect a retired id.
- **Store captures of a deleted submission become garbage** and are
  collected by the ordinary sweep, since no build-output references them
  any more. One refinement was needed there: the pre-keyed-layout spare
  rule now fires only when a build-output exists but names no capture,
  rather than whenever no capture is named — a tombstone has no
  build-output at all, and its legacy entry is as dead as any other.
- **Deletion is irreversible for the content**, so the CLI treats it like
  registration: it names the drafts the deletion strands (read from the
  local database clone, the same reverse walk `lax submit` uses), then
  asks the user to type the id back; `--yes` covers scripts.

Spec touchpoints: "Lifecycle" (the state and its two transitions), "Actions"
(a fourth write action), the CLI command list, and the endpoint list under
"Archive Server". Left unedited pending manual reconciliation.

## Sibling path requires and batch submit (implemented, 2026-07-28)

Implements lax.md's "v0.2 sibling path requires" (design session and full
rationale: sibling-paths-plan.md, written 2026-07-28). A `[[require]]` with
`name`/`path` keys may now point at another submission folder of the same
repository, in both packages; `lax submit` takes several folders of one
repository and submits them as one wave. Deviations and refinements vs.
lax.md's plan text:

- **In-batch triple references are banned (H1).** Within a wave, a git
  require naming a co-member's package is a Resolution violation; sibling
  references must be path edges. Rationale: a *same-commit* triple onto a
  co-member is literally unwritable (the lakefile would have to contain the
  hash of the commit containing it), so any triple onto a co-member is an
  older-commit pin — stale by construction after the wave's commit, and it
  puts two sources for one package name into the dependent's workspace.
  Zero false positives.
- **Batch processing is sequential bottom-up commits plus an atomic
  register flip**, not an in-memory overlay: the wave runs as N ordinary
  submits committed one at a time in dependency order, so when a member
  builds, its co-members are plain database records and the existing
  machinery (trustedDepDirs, upstreamStatements, captures, sweep) needs
  zero changes. Soundness: every prefix of a topological order is a valid
  sequence of individually-admitted single submits. lax.md's "one db
  commit per wave" is therefore softened: a draft wave is one commit per
  member (`draft LaxN by <handle> (wave i/n)`); atomicity is applied where
  it genuinely matters — registration. Registering waves draft every
  member (register-strict resolution, draft commits), then one locked,
  build-free **flip** commit (`register LaxA+LaxB by <handle>`) moves all
  records to registered; any record that moved in between aborts the flip
  and the wave stays drafted (harmless, overwritable, no repins on
  retry). A failure mid-wave leaves only the drafted prefix — a state the
  archive already admits. Consequence: a registering *single* runs through
  the same loop and now commits draft-then-flip (two commits,
  init→draft→registered — both legal transitions).
- **The server is order-agnostic; the CLI topo-sorts.** The plan's rule
  (a) ("member of the same batch") collapses into rule (b) ("the target
  record's current triple is exactly this repo, this commit, that
  folder"), which is the whole server-side gate; a path edge to a
  not-yet-committed co-member simply fails rule (b) with the "list both
  folders in one `lax submit`" message. The CLI orders member folders
  dependencies-first along their path edges (light lakefile parse, Kahn),
  refuses cycles before submitting, and sends the legacy single shape for
  one folder (old-server compatible) or a `members` array for waves.
  Per-member fetches replace lax.md's "one clone" (N shallow fetches of
  one pinned commit are content-addressed and equivalent); per-member
  Compile copies are fresh and pristine — never a shared build tree, since
  an earlier member's Compile runs arbitrary author code that could
  rewrite sibling *sources*.
- **Manifest seeding flattens the closure (empirical checkpoint 1).** The
  plan preferred listing only direct requires per package and letting lake
  resolve transitively through the siblings' own seeded manifests; lake
  refuses that ("dependency … not in manifest" — it materializes every
  workspace dependency from the *root* manifest only). So each member
  package's `lake-manifest.json` carries the flattened sibling closure:
  path entries rebased relative to the package dir plus the closure's git
  requires, deduped by name. Siblings get no seeding of their own — their
  git deps clone into the requiring workspace's `.lake/packages`, their
  sources build in place as path deps (checkpoint 2 confirmed).
- **Local statement authority for path-required siblings (H2)** is the
  sibling environment itself: when Resolution filled no `upstreamStatements`
  entry (local builds — no record checks locally, by design), Inspect
  derives the sibling's concept-package inventory and runs the inspector
  over it, taking its axioms as the statement set. Self-selecting, no mode
  flag: on the server, rule (b) guarantees committed build-outputs and
  Resolution fills the map. The sibling's own layout/annotation problems
  are discarded (its build's violations, not the member's); only an
  inspector *failure* is the member's violation.
- **One unified source-map check** subsumes several plan edge cases: over
  my two packages ("root"), my git and path requires, and the closure's
  git requires and path entries, every package name must have exactly one
  source — catching a closure sibling git-pinning my name, duplicate ids
  among involved folders, conflicting pins for one name across sibling
  lakefiles, and a sibling path edge pointing back into my own root.
- **Repo-wide submission scan (H5).** A "submission folder" is a folder
  whose `git ls-files --cached --others --exclude-standard` manifest.yaml
  carries a valid Lax id (`.lake/` segments excluded; invalid/missing ids
  ignored — vendored fixtures). Nesting between two such folders and
  duplicate ids are violations, on every build inside a git repository.
  Consequence worth a doc sentence: a submission at the repository root
  excludes any second submission in that repo.
- **Realpath containment (H6)** for the member folder and every sibling
  package dir: after the lexical check, the target's realpath must equal
  the lexical resolution against the realpath'd base. This also fixes a
  pre-existing single-submit hole: `runBuildJob` resolved `folder`
  lexically and then copied *outside* the sandbox, so a hostile repo
  containing a symlink could make the copy read host files.
- **Documented consequences, unchanged behavior:** cross-owner path edges
  are effectively unusable (the actor must be in every member's owner
  set) — same-repo siblings need shared ownership, triples remain for
  cross-owner deps. The accepted draft race extends to waves: a
  co-member's later re-draft swaps its capture under dependents and can
  surface as a confusing-but-sound Replay failure on the next wave.

- **Submit pre-flight over the database clone (added 2026-07-28, after the
  first real wave).** The CLI holds the same records rule (b) consults, so
  `lax submit` now answers the two record-level questions before the
  upload: it quietly fast-forwards `~/.lax/db` and (i) refuses a wave whose
  path edge targets a folder outside it whose record is not at exactly
  (this repository, this commit, that folder) — the refusal the server
  would issue after minutes of building; (ii) warns about the reverse
  case the server never sees: draft records *outside* the wave that
  require a moved member (path or pin, read from their build-outputs) and
  are stranded at their old commit. Refusals demand a freshly pulled
  clone; when the pull fails the findings demote to warnings and the
  server stays the authority. `lax doctor` now also compares the clone's
  HEAD against the remote instead of blessing any directory.

Spec touchpoints: Packages (the path-require whitelist grows the sibling
shape), Resolution (rule (b), H1), lax submit (several folders, the wave),
Processing (per-member commits + flip), Archive Server (whole-checkout
Compile copy when path edges are present).

## Concept `type` is required (implemented, 2026-07-27)

Amends the decision recorded below ("type stays free prose-level
metadata"): the *presence* of the `type` frontmatter key is now enforced —
an "annotation" violation at Inspect, in both `lax build` and the server
pipeline — while the *value* remains free prose (no vocabulary, and still
no consistency check against the axiom count). Rationale: the website
leans on the badge as the concept's visual marker, and an "untyped"
fallback state is one more thing every legend and filter must explain;
requiring the key removes the state instead of styling it. Sitegen fails
fast on pre-gate records without a type (same posture as the
one-statement throw); the db conformance scan in TODO.md now covers both.
Spec touchpoint: the concept-annotation frontmatter table, `type` moves
from optional to required.

## One statement per concept (implemented, 2026-07-27)

A concept module declares at most one axiom: it is either a
definition-concept (zero statements, contributing vocabulary) or a
claim-concept (exactly one, and the concept *is* that claim). The
**cardinality bound is all that is enforced** — consistency between the
`type` frontmatter key and the axiom count (theorem/lemma/proposition/
corollary ⇒ exactly one, definition ⇒ zero) was proposed in the plan but
deliberately dropped on Jan's call: `type` stays free prose-level
metadata, and nothing mechanical hangs off it. Full rationale in
[one-axiom-plan.md](one-axiom-plan.md); the
2026-07-27 survey of `~/git/lax-submissions` found all 28 existing
concept modules already conform, so there is no migration. Spec
touchpoint: Concept packages, "The statements of a concept are the
axioms whose module of origin it is" gains the cardinality (not a type
table). Record schema unchanged (`statements` stays an array, length
≤ 1); no `specVersion` bump. Enforced as an Inspect-phase violation in
both `lax build` and the server pipeline; never checked on foreign
content at resolution time, since the server enforces it at submit. The
companion website rewrite that this enables is
[`lax-website/old-logic/website-plan.md`](https://github.com/lax-archive/lax-website/blob/main/old-logic/website-plan.md).

As implemented (`src/pipeline/inspect.ts`, after the concept declaration
loop): violation kind `one-statement`, message `concept <module> declares
<n> statements (<axiom names>); a concept module declares at most one
axiom (none for a definition-concept, one for a claim-concept)`. Test
fixtures that carried several axioms per concept module (pipeline
`Lax2`/`Lax23`, edge `Lax6`) were split one-axiom-per-module rather than
exempted — they were pre-rule shorthand, not counterexamples. The db
conformance scan over live records is still open (TODO.md).

## Build-keyed store captures (implemented, 2026-07-26; survives the 2026-07-27 revert)

Introduced for the front/worker deployment split
(history/front-worker-split.md, since reverted) but **kept**: reference-then-GC is a sounder store contract than
overwrite-under-lock even on one machine, and the live store already uses
it. Original rationale follows. Submission captures
move from `store/submissions/<id>` to `store/submissions/<id>/<captureId>`
(the job id), the build-output records the `captureId`, and dependency
resolution (`trustedDepDirs`) reaches the store through it. Promotion then
happens on the worker *before* the front commits the record — safely,
because an entry the db never references is garbage (swept by the worker
past a grace age), not a record/store disagreement. Today's design instead
promotes under the db write lock to keep entry and record atomic, which
cannot span two machines. Spec touchpoint: the Archive Server's store and
"Processing" wording that ties capture promotion to the commit; the
guarantee is unchanged — the artifacts Replay checked are exactly what the
record's build-output points at — but the mechanism becomes reference-
then-GC instead of overwrite-under-lock. Re-drafts stop overwriting
in place; each build is a fresh entry.

As implemented: `BuildOutput.captureId` is optional and server-set, so
records written before this change keep resolving to the unkeyed
`store/submissions/<id>` path and no migration of the live store was
needed. The sweep (`lax-server sweep`, and every `serve` startup) deletes
capture entries no build-output references past a grace age, sparing the
unkeyed layout and anything younger than the grace window.

## Two-machine processing: the untrusted half moves off the archive (implemented 2026-07-26, **reverted 2026-07-27**)

**Reverted**: the split ran in production for one day and was retired
(history/front-worker-split.md, "The revert"); the remote executor code is deleted as of
0.1.8. No spec amendment is needed anymore — the single-server "Processing"
text is once again literally what runs. The build/submit seam the split
introduced remains in the code as an internal boundary. Original entry
kept below for the record.

Also for the split. spec.md's "Processing" describes one server that
fetches, builds, validates and commits. The pipeline and the trust chain
are unchanged, but the *machine boundary* is now part of the design and
worth stating: the front holds the database, the write lock, the
allowlist and every secret, and never executes author code; the worker
executes author code and holds nothing but a per-boot token — it receives
`(id, repository, commit, folder, register)` and answers with a build
report. Author GitHub tokens are verified on the front and never travel.
Two failure edges the spec's single-process model does not have — no
worker takes the job, the worker dies mid-build — surface as ordinary job
failures ("worker lost"), which is the same lossy-restart contract jobs
already carry. Spec touchpoint: "Archive Server"/"Processing" gain the
split as a deployment shape, with `local` (one machine) remaining
conformant.

## Write allowlist on the archive server (implemented, 2026-07-26)

spec.md's Authentication says the server verifies a GitHub token and
checks ownership. The live archive additionally gates *who may write at
all*: an operational allowlist (`ops.sqlite` on the server, deliberately
outside the public `db.git`) checked right after token verification, so
`init`, `set-owners` and `submit` refuse accounts that were not granted
access, with a message saying how to ask. Reading, cloning the database
and `lax build` are untouched. This is deployment policy rather than
protocol — a self-hosted archive can seed it open — but the refusal is
visible to clients, so it belongs in the spec's error surface.

## Go-live UX: device-flow login, doctor, update-db, register confirmation (implemented, 2026-07-26)

Deployment-simplification pass; four spec touchpoints:

- **Authentication** — *superseded: folded into spec.md on 2026-07-26*
  (CLI preamble, the new `lax login`/`lax logout` entry, Archive Server
  "Authentication", the shell-out list, and ``LAX_GITHUB_TOKEN``).
  The primary login is now `lax login`, a GitHub
  OAuth **device flow with zero scopes** — the archive learns only the
  user's identity and the `gh` CLI is not involved at all. Resolution
  chain: ``LAX_GITHUB_TOKEN`` → the token stored by `lax login`
  (``~/.lax/credentials.json``). There is deliberately no `gh auth token`
  fallback: silently borrowing a full-scope `gh` token gave the CLI
  credentials far broader than the zero-scope one it asks for, and made
  `lax doctor` report a login the user never granted lax. The server side
  is unchanged (it verifies whatever bearer
  token arrives). The OAuth app's public client id lives in
  `src/constants.ts` (empty until the app is registered — see TODO.md);
  ``LAX_GITHUB_OAUTH_URL``/``LAX_GITHUB_API_URL`` are test seams faking
  github.com.
- **`lax pull-db` renamed `lax update-db`** (spec.md ~1070) — pairs with
  `lax update`; `pull-db` stays as an alias.
- **Registration confirmation**: `lax submit --register` now prompts
  (type the submission id back) since registration is the archive's one
  irreversible action; `--yes` skips the prompt, and non-interactive use
  without it is refused. The spec's Actions section doesn't prescribe CLI
  interaction, so this is a refinement, not a deviation.
- New commands outside the spec's command list: `lax login`, `lax logout`,
  `lax doctor` (environment checks with fixes). ``~/.lax`` gains
  ``credentials.json``.

## First-run warm build: fatal `cache get`, progress notes (implemented, 2026-07-24)

Field feedback: a first `lax init` looked hung — the warm mathlib build's
long silent stretches (the clone prints no progress into a pipe, then the
chmod and hardlink passes are quiet) plus the implicit hours-long
build-mathlib-from-source fallback when `lake exe cache get` fails. Changes:

- A failed `lake exe cache get` now **fails the warm build** with a clear
  message instead of silently compiling mathlib from source; the fallback
  is opt-in via `--build-from-source` on `lax init`, `lax build`, and
  `lax-server warm`.
- The first-run notice states an expected duration, and one-line status
  markers precede each quiet phase (artifact fetch, read-only chmod pass,
  package linking).
- Client HTTP requests to the archive get a 30 s timeout (`AbortSignal`);
  every endpoint answers quickly by design (submit is polled), so a
  stalled connection now errors instead of hanging.

Spec touchpoint: the Provision paragraph's "on a fresh machine" sentence
(spec.md ~725) — the one-time warm build is no longer allowed to degrade
to a source build without an explicit flag.

## Annotations — heading-split sections and a `type` key (proposed, 2026-07-23)

Two backward-compatible extensions to the annotation format, motivated by
the website (lax.md):

- **Heading-split sections** (concepts *and* proofs): the markdown body of
  an annotation is split at top-level ATX headings (`# Name`; headings
  inside fenced code blocks don't count). A body without headings is the
  description verbatim — today's behavior. With headings, the description
  is the text before the first heading *or* a section titled `description`
  (case-insensitive); providing both non-empty is an `annotation`
  violation, as are duplicate section titles. All other sections land in
  the build output as an ordered `sections: [{title, markdown}]` list —
  the one list that keeps source order rather than being sorted, since the
  order is authorial intent (and deterministic). The website renders each
  section as its own block (e.g. `# Review notes`).
- **`type` frontmatter key** (concepts only): an optional scalar beside
  `title`, an arbitrary string (`theorem`, `definition`, …). The website
  compresses it to a 3-letter sidebar badge; it carries no semantics in
  the pipeline. Missing `type` is fine (neutral badge).

Spec touchpoints: the concept-annotation and proof-annotation format
paragraphs (frontmatter key lists, body semantics) and the build-output
determinism sentence.
