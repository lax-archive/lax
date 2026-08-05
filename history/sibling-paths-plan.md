# Implementation plan: sibling path requires and batch submit (lax.md v0.2)

Written 2026-07-28, at the end of a design-review session that evaluated
lax.md's "v0.2 sibling path requires" section against the implementation and
settled every open decision with Jan. This document is the complete handoff:
a fresh session should be able to implement from it without re-deriving
anything. The guiding principle Jan set: **the solution with the least new
paths and the least ways to get things wrong** — prefer extending existing
machinery over adding parallel mechanisms.

Do not edit lax.md or spec.md; deviations from lax.md's plan text are
recorded in spec-notes.md when this lands (section "Docs" below).


## 1. Decisions made (with Jan, do not re-litigate)

The review found six issues (H1–H6). Resolutions, all confirmed:

- **H1 — ban in-batch triple references.** Within a batch, any `[[require]]`
  that names a co-member's package must be a path edge; a git-require naming
  a co-member is a Resolution violation. Rationale (worked out, sound): a
  *same-commit* triple onto a co-member is literally unwritable — the
  lakefile would have to contain the hash of the commit containing it — so
  any triple onto a co-member is an older-commit pin, which the same wave's
  commit makes stale-by-construction, and which puts two sources for one
  package name into the dependent's Lake workspace (the root package plus
  the inherited older pin — Lake resolves by name; collision or silent
  unification). Today's invariant "no workspace holds two sources for one
  name" holds by construction; this ban preserves it. Zero false positives.

- **H2 — local statement authority = sibling environment.** Inspect's
  `isStatement` (src/pipeline/inspect.ts:196-201) resolves foreign
  statements against the db build-output (`upstreamStatements`,
  resolution.ts:86-92). A path-required never-submitted sibling has none.
  Server: fresh committed build-outputs (see H3/E). Local: run the inspector
  over the sibling's concept-package inventory and take its axioms — one
  extra inspector invocation (≈ one mathlib env load) per path-required
  concept package of the proof package. Rejected: trusting the sibling's
  `build-output.json` file (staleness footgun), name-prefix-only (diverges
  from server). Scope is narrow: only **concept** packages required by the
  **proof** package need statement sets (concepts are axiom-free; concept→
  concept edges need nothing).

- **H3 — batch architecture = Option E: sequential bottom-up commits + an
  atomic register flip.** Jan chose this explicitly over an in-memory
  overlay ("least new paths"). The batch runs as N *ordinary* submits
  committed one at a time in dependency order. When member M2 builds, M1's
  record and build-output are already committed, so the plan's rule (a)
  ("member of the same batch") collapses into the existing rule (b) ("record
  whose current triple is exactly this repo, this commit, that folder"), and
  `trustedDepDirs`, `upstreamStatements`, captures, and the sweep need
  **zero changes** (store.ts untouched). Soundness: *every prefix of a
  topological order is a valid sequence of individually-admitted single
  submits* (induction up the order), so every intermediate/failure state is
  a state the archive already admits via legitimate user actions.
  Registration is where atomicity genuinely matters (permanent; a
  half-registered wave would force triple repins on the fixed remainder —
  the ceremony this feature exists to kill), so: registering waves run
  every member's pipeline with register-strict external resolution but
  commit each as a **draft**, and only when all members passed does one
  locked, build-free **flip** commit move every record to registered
  atomically. Failure anywhere before the flip leaves only drafts —
  harmless, overwritable, zero repins on retry. Rejected alternatives (do
  not revisit): writing batch state into the working clone incrementally
  (concurrent jobs' Resolution and sitegen read it without the lock;
  `commitAndPushSync` does `git add -A`, so a concurrent init/set-owners
  commit would sweep up dirty batch state); holding the write lock for the
  whole wave (stalls every write for minutes against spec.md "Processing").

- **H4 — Compile's copy unit.** Path edges escape the member folder, so the
  sandboxed Compile copy must include the path-closure siblings at their
  relative positions. **Never share one build tree across members**: an
  earlier member's Compile (arbitrary author code; `initialize` blocks of
  imported proof packages run inside dependents' compiles) could rewrite
  sibling *sources* in a shared tree, breaking "the code the website
  displays is the code that was checked" between members. Fresh pristine
  copy per member; the repeated sibling compile is cost the plan's own Cost
  section accepts.

- **H5 — disjointness/duplicate-id check, defined.** "Submission folder" =
  a folder whose tracked `manifest.yaml` carries a valid Lax id. Scan
  `git ls-files --cached --others --exclude-standard` at the repo toplevel,
  keep basename `manifest.yaml`, exclude any path containing a `.lake/`
  segment (dependency clones contain manifests), parse ids (invalid/missing
  id → ignored, e.g. vendored fixtures). Violations: (i) nesting between two
  valid-id folders (a submission at `.` therefore excludes any second
  submission in that repo — worth a doc sentence), (ii) duplicate ids —
  this implements lax.md's duplicate-id edge case repo-wide. Runs on every
  build when inside a git repo; outside, skip with a warning (same posture
  as the tracked-files check, static.ts:110-112).

- **H6 — realpath containment for member folders and path targets; fixes a
  pre-existing hole.** `runBuildJob` resolves `job.folder` lexically
  (src/server/build.ts:80-81) and then `fs.cpSync` runs *outside* the
  sandbox: a hostile repo containing a symlink escapes the checkout and
  reads host files (pipeline fails afterwards, but the read happened and
  error text can echo fragments). One shared helper: after the lexical
  check, require `realpathSync(target) === resolve(realpathSync(base),
  rel)`. Apply to the member folder in runBuildJob and to every sibling
  package dir in resolution. Jan approved folding this fix in.

- Everything else in lax.md's v0.2 section stands as written, including:
  path edges freeze both ends at the containing commit; pinning by triple
  into one's own repo *at an older commit* stays legal (outside batches);
  the local pipeline checks path edges structurally only (no record/db
  checks locally — rule (b) is submit-time); registering part of a wave
  bottom-up from one commit is legal; the cross-submit acyclicity induction
  was re-verified this session and holds (edges are a function of the
  commit — a same-commit re-submit re-runs the identical lakefile — so a
  cycle can never bootstrap: the first submit from a cycle-carrying commit
  always fails).

Additional confirmed consequences to document, not change: cross-owner path
edges are effectively unusable (the actor must be in every member's owner
set) — same-repo siblings need shared ownership, triples remain for
cross-owner deps. The existing accepted draft race extends: a co-member's
later re-draft swaps its capture under dependents; can surface as a
confusing-but-sound Replay failure on the next wave.


## 2. One unifying check (implements several plan edge cases at once)

Build a map `packageName → source` over: my two packages (source "root"),
my git requires (`git:<url>@<rev>#<subDir>`), my path requires and the
transitive sibling closure's path entries (`path:<realpath'd pkg dir>`),
and the closure's git requires. **Any name with two distinct sources is a
Resolution violation.** This single check subsumes: H1's local analogue (a
closure sibling git-requiring my package name), lax.md's duplicate-id edge
case among involved folders, conflicting pins for one name across sibling
lakefiles, and a sibling path edge pointing back into my own root.
(mathlib is excluded — the validator already pins it.)


## 3. Per-file implementation spec

### src/types.ts
- `PathRequire { name: string; path: string }`.
- `ValidatedLakefile` gains `pathRequires: PathRequire[]` (sibling edges
  only). `hasConceptPathRequire` stays as-is for the own `../concepts` edge.

### src/validators/lakefile.ts (path-require branch, ~lines 87-107)
- Keys exactly `{name, path}`; `path` a string.
- Proofs kind with `path === "../concepts"` (exact string) → own-edge,
  unchanged (name must equal the concept package name).
- Everything else → sibling edge, now allowed in **both** kinds:
  - reject absolute paths (leading `/` or `^[A-Za-z]:`) and any backslash;
  - posix-normalize; last segment must be `concepts` or `proofs`;
  - name/segment consistency: name ends with `Proofs` iff segment is
    `proofs`;
  - kind rules mirroring git requires: concepts lakefile + proofs target →
    violation; proofs lakefile + proofs target → the discouraged warning;
  - push `{name, path}` onto `pathRequires`.

### src/pipeline/siblings.ts (new)
```ts
export interface SiblingEdge {
  name: string;          // required package name
  targetId: string;      // manifest id at the target folder
  kind: "concepts" | "proofs";
  pkgDir: string;        // absolute, realpath-verified
  folder?: string;       // target submission folder, repo-relative posix
                         // ("." for root); undefined outside a git repo
}
export interface SiblingGraph {
  concepts: SiblingEdge[];   // direct edges of my concept package
  proofs: SiblingEdge[];     // direct edges of my proof package
  closure: Map<string, { pkgDir: string; gitRequires: GitRequire[];
                          pathEntries: { name: string; pkgDir: string }[] }>;
}
export function resolveSiblings(root, staticResult, c): SiblingGraph
```
- Toplevel discovery: `git rev-parse --show-toplevel` (pattern of
  static.ts:98-113). Outside a repo: warn once, resolve targets relative to
  the package dir, skip containment/symlink/scan.
- Per direct edge: lexical normalize against the requiring package's
  repo-relative folder; escape (leading `..` after normalize) → violation;
  H6 realpath check; existence of pkg dir + parent `manifest.yaml`;
  `manifestId` (src/client/folder.ts) must equal `name` minus `Proofs`
  suffix; target folder equal to my root → self-reference violation (hint
  the dedicated `../concepts` spelling when applicable).
- Transitive walk over sibling `lakefile.toml`s: light `parseToml` only
  (their own submits do full validation; malformed sibling TOML → violation
  naming the sibling). Follow their path entries — including their own
  `../concepts` edges, resolved against that lakefile's dir — and collect
  their git requires. Note replay.ts:43-79 (`depClosure`) already walks
  exactly this shape generically; reuse or mirror its resolution logic.
- Cycle detection on the walk (DFS, in-stack set); violation lists the
  folder chain.
- The section-2 source-map check.
- The H5 repo scan.
- Rule name for all of it: `"resolution"`.

### src/pipeline/resolution.ts
- Signature: `runResolution(root, staticResult, c, opts)`; opts gains
  `submit?: { repository: string; commit: string }` and
  `batchIds?: Set<string>` beside `forRegister`.
- Calls `resolveSiblings`; `ResolvedDeps` gains `siblings: SiblingGraph`;
  `conceptRequires`/`proofRequires` now include path-edge names (feeds the
  import rule, concept-imports filter, emit).
- Git requires: existing checks, plus (server) H1: a require whose name's
  id-base is in `batchIds` → violation "within one batch, sibling
  references must be path edges".
- Path edges, only when `opts.submit` is present (server): rule (b) —
  `loadRecord(targetId).source` must equal `{repository, commit,
  folder: edge.folder}`; the violation message spells the fix from lax.md:
  "list both folders in one `lax submit`". Draft target under `forRegister`:
  admit iff `targetId ∈ batchIds` (it flips in this wave), else "must be
  registered". Fill `upstreamStatements` for concept-kind path targets from
  `loadBuildOutput` (fresh under E).
- Path edges locally (`opts.submit` absent): structural only; deliberately
  do **not** consult records and do **not** fill `upstreamStatements`
  (Inspect fills from the sibling environment — self-selecting, no mode
  flag).

### src/pipeline/warmstore.ts — seedManifest
- Accept sibling path entries `{name, dir}` (dir relative to the package
  dir, posix) and emit them as additional `type: "path"` entries beside the
  own-concepts one. The manifest lists **direct** requires only; transitive
  resolution flows through the siblings' own seeded manifests — this
  mirrors how `../concepts` works today (the proofs manifest never lists
  the concept package's git requires, and that demonstrably works).
- **Empirical checkpoint 1**: a fake-mathlib test must confirm lake
  resolves a sibling's git requires through the sibling's seeded manifest
  with no `lake update`/network resolution. If lake instead demands a flat
  root manifest, fall back to flattening the closure (path entries rebased
  relative to the workspace root, closure git requires appended, deduped).

### src/pipeline/provision.ts
- After seeding my two packages: seed each closure package's
  `lake-manifest.json` too (from its own git requires + path entries;
  recursive over the closure; idempotent). Do **not** `seedPackages` for
  siblings — git deps clone into the *root* workspace's `.lake/packages`.
- **Empirical checkpoint 2**: sibling builds inside my workspace without
  its own packages dir (fake-mathlib test).

### src/pipeline/replay.ts
- `depClosure`/`materializeOleans`/`depLibDirs` gain an optional
  `extraRoots: {name, dir}[]` param seeding the walk with my direct path
  edges (dir = edge.pkgDir). The transitive walk (lines 61-77) already
  handles nested path and git entries — verified this session.
- Callers (commands/build.ts:75-94, serverPipeline extraction) pass the
  edges from `deps.siblings`.

### src/pipeline/inspect.ts
- Allowed-imports / `requiredConceptPkgs` pick path names up automatically
  from the extended deps lists.
- New, before proof judging: for each required concept package with no
  `upstreamStatements` entry that appears in `siblings.closure`:
  `deriveInventory(parent(pkgDir), "concepts", name, scratchCollector)` +
  `invokeInspector` over it; the statement set = its `kind === "axiom"`
  declarations with module in that inventory. The scratch collector is
  discarded — the sibling's own layout/annotation problems are *its* build's
  violations, not mine; an inspector *failure* is my violation
  ("path-required sibling <name> could not be inspected: …").

### src/pipeline/emit.ts
- `requiredByConcepts`/`requiredByProofs` = git + path require names,
  sorted. The own `../concepts` edge stays excluded (matches the spec's
  example). Nothing else changes; sitegen consumes names and needs no
  changes.

### src/server/serverPipeline.ts
- Pass `{forRegister, submit: {repository, commit}, batchIds}` into
  Resolution (job fields threaded in).
- Copy unit: no path edges → copy just the member folder (today's exact
  path, zero change for existing submissions); with path edges → copy the
  repo checkout wholesale to the build root (cpSync filter skips `.git`),
  compile cwd = `<buildRepo>/<memberFolder>/{concepts,proofs}`. Static,
  inventories, sourceText, and the olean extraction destination stay on the
  pristine `root` — unchanged.
- Seed my two packages (in the build tree) + closure sibling manifests.
- Replay/Inspect LEAN_PATH: `trustedDepDirs(cfg, [...gitRequire names,
  ...path edge names])` — store.ts unchanged; under E the targets'
  build-outputs/captures are committed before the member runs, and the
  `requiredBy*` closure walk works through them.
- Sibling artifacts the member's own Compile produced in the build tree are
  never extracted and never on LEAN_PATH — trust chain unchanged.

### src/server/build.ts (runBuildJob)
- H6: after the lexical containment check on `job.folder`, require
  `realpathSync(root) === resolve(realpathSync(repoDir), folder)`.
- `WorkerJob` gains `batchIds: string[]` (protocol.ts); the per-member
  jobId is suffixed (`${jobId}.${i}`) so per-member jobDirs and captureIds
  stay distinct.
- Fetch stays inside runBuildJob (self-contained per member; N shallow
  fetches of one pinned commit are content-addressed and equivalent —
  spec-notes deviation vs. lax.md's "one clone").

### src/server/submit.ts (runSubmitJob) — the E orchestration
```
members arrive validated (postSubmit); process in the ORDER SENT
for each member i:
  report = executor.run(memberJob(i, batchIds))       // untrusted half
  if !ok: job.failed — violations prefixed [LaxN]; job carries the
          committed-prefix records; remaining members "not attempted"; STOP
  under lock:  requireOwner + requireMutable (re-check),
               record.source = triple, record.state = "draft"   // always
               writeRecord + writeBuildOutput,
               commit "draft LaxN by <handle> (wave i/n)"
if register:
  under one lock (build-free FLIP):
    for each member: re-load record; requireOwner; state === "draft";
      source === wave triple+folder — any mismatch aborts the flip
      (wave stays drafted; job fails with a plain message)
    else: state = "registered" + registeredAt for all, one commit
          "register LaxA+LaxB by <handle>"
ONE safeRegenerate at wave end (not per member)
job.succeeded: records = all members (post-flip)
```
- The server is **order-agnostic**: rule (b) enforces deps-first (a path
  edge to a not-yet-committed co-member fails with the "list both folders /
  order" message). The CLI topo-sorts; no server-side graph code.
- Single submit = wave of 1 through the same loop. A registering single
  therefore commits draft-then-flip (two db commits, init→draft→registered —
  legal transitions; deviation noted in spec-notes). One loop, no special
  case.
- The executor seam stays per-member (WorkerJob in, BuildReport out);
  trusted commits interleave between `executor.run` calls in runSubmitJob.
  Nothing but the report crosses the seam.

### src/server/http.ts (postSubmit)
- Accept `members?: [{id, folder}]` beside the legacy `id`/`folder`
  (normalize legacy to a one-member array). Per member: ID_PATTERN, the
  existing folder shape checks, dup-id and dup/nested-folder lexical
  pre-checks, `requireOwner` + `requireMutable`. `job.submissionId` = ids
  joined with "+".

### src/api.ts
- `SubmitRequest { repository, commit, register, id?, folder?, members? }`.
- `JobResponse` succeeded: keep `record` (= records[0], old-CLI compat for
  singles) and add `records: DbRecord[]`. Failed: add
  `committed?: DbRecord[]` (the drafted prefix). Violation messages carry
  `[LaxN] ` prefixes when the wave has >1 member.

### src/commands/submit.ts + src/index.ts (CLI)
- `lax submit [folders...]` (default `["."]`). All folders must share one
  `git rev-parse --show-toplevel`; one dirty check (repo-wide porcelain),
  one fetch/remote check — refactor `deriveTriple` to derive
  repo+commit+toplevel once and compute folder per member.
- Manifest id per folder; duplicates → error.
- CLI topo-sort: light-parse each member's two lakefiles for path requires,
  normalize each target folder, keep only edges **between member folders**,
  Kahn's algorithm; cycle → error before submitting; edges to non-member
  folders don't affect the order (server rule (b) judges them).
- Send the legacy single shape for one folder (old-server compat), the
  members shape for real waves.
- `--register` prompt: type back the comma-joined id list; `--yes`
  unchanged. Report per-member outcomes; on failure list the drafted
  prefix, the failed member, and the unattempted rest. `--resume` works
  unchanged (one jobId per wave).


## 4. Tests (fast suite, fake mathlib; conventions in test/helpers.ts)

- **unit**: validator — sibling shapes accepted in both kinds; exact-keys,
  absolute/backslash, last-segment, name/segment consistency violations;
  concepts→proofs target violation; proofs→proofs target warning;
  `../concepts` own-edge unchanged.
- **siblings structural** (pipeline or unit with git fixtures): missing
  target folder/manifest; manifest-id mismatch; self-reference (incl.
  `./../concepts`-style spellings normalizing home); escape above toplevel;
  symlink traversal (fixture with a symlinked folder); cycle A→B→A;
  H5 nesting + duplicate-id scan (incl. `.lake/`-exclusion and
  invalid-id manifests ignored); section-2 source conflicts (sibling
  git-pins my name; two siblings pin one name at different revs).
- **local pipeline** (monorepo fixture, two submissions A←B in one repo):
  B concepts path-require A concepts (import compiles; imports listed in
  build-output); B proofs path-require A concepts and conclude an A
  statement — exercises sibling-env statement extraction, axiom hygiene,
  conclusion/defeq; `requiredBy*` contains path names; empirical
  checkpoints 1+2 (sibling with its own git require resolves through the
  sibling manifest, no `lake update`, no own packages dir).
- **server** (harness in test/server-harness.ts): wave of two drafts —
  order as sent, both committed, `wave i/n` commit messages, one site
  regen; register wave — flip commit, both registered, registeredAt set;
  mid-wave failure — prefix drafted + reported, failed member attributed,
  rest unattempted; wrong-order wave — rule (b) message; the lax.md edge
  case: single re-submit at a new commit with a path edge to an unmoved
  sibling fails rule (b) with the "list both folders" message; H1 —
  git-require on a co-member is a violation; H6 — symlinked member folder
  refused; register wave with an out-of-batch draft rule-(b) target →
  "must be registered"; partial registration bottom-up (register upstream
  alone, then downstream alone from the same commit passes rule (b));
  flip-abort when a record moves between draft commits and the flip
  (concurrent re-draft simulation) leaves the wave drafted.
- **cli**: variadic parse, topo order sent, cycle refusal, mixed-toplevel
  refusal, prompt text.

## 5. Docs (last task)

- **spec-notes.md**: one entry "Sibling path requires and batch submit
  (implemented …)" recording each deviation/amendment vs. lax.md's plan
  text: the H1 ban (+ its unwritability rationale); E — draft waves commit
  bottom-up per member (every prefix is an already-admitted state),
  registration atomic via the build-free flip, "one db commit per wave"
  softened, per-member fetches; server order-agnostic + CLI topo-sort
  (rule (b) is the whole gate; rule (a) subsumed); H5 scan mechanics and
  the folder-`.` consequence; H2 local sibling-env statement authority;
  H6 realpath containment (also fixes the pre-existing single-submit
  symlink hole); the section-2 unified source check; registering singles
  now draft-then-flip (two commits, init→draft→registered).
- **TODO.md**: remove the pointer entry to this plan; note follow-ups if
  any surface.
- **README.md** command table (`lax submit` takes several folders of one
  repo); **instructions.md**: short authoring section on sibling path
  requires (when to use them vs. triples, the shared-ownership requirement,
  waves re-submit together).
- **Not** lax.md, **not** spec.md (Jan reconciles those manually).

## 6. Codebase facts verified this session (trust them)

- `isStatement` db-authority: src/pipeline/inspect.ts:196-201; populated at
  src/pipeline/resolution.ts:86-92.
- `depClosure` already walks generic `path` entries in transitive
  lakefiles: src/pipeline/replay.ts:61-77 — only the *root-level* seeding
  is missing.
- Under E, src/server/store.ts needs **zero** changes (trustedDepDirs,
  captures, sweep all work through committed build-outputs).
- Concurrent jobs run in one process without a queue; only db writes are
  serialized (dbrepo.ts `withLock`); `commitAndPushSync` stages `-A` — the
  two facts that kill any dirty-working-clone design.
- Jobs are in-memory and lossy by design (jobs.ts); captures are keyed by
  the worker jobId and referenced by `BuildOutput.captureId`; unreferenced
  captures are garbage collected by `sweepCaptures` past a grace age.
- Owner/mutability are re-checked under the lock at commit time
  (server/submit.ts finishJob) — the E per-member commit and the flip both
  keep doing this.
- The proofs package's seeded manifest today lists only its *direct*
  requires plus the `../concepts` path entry, and lake resolves the concept
  package's own requires through the concept package's seeded manifest —
  the precedent the sibling-manifest seeding follows (checkpoint 1 makes
  this explicit for siblings).
- scaffold (src/scaffold.ts) gitignores `.lake/` — the H5 scan's
  `.lake/`-exclusion is defense against force-adds only.

## 7. Suggested implementation order

1. types + validator (+ unit tests) — self-contained.
2. siblings.ts + resolution wiring (+ structural tests).
3. provision/warmstore/replay wiring; local monorepo build green
   (checkpoints 1+2 decide the manifest-flattening question early).
4. inspect sibling statements; local cross-submission proof green.
5. emit + protocol/api types.
6. server: H6 helper, WorkerJob batchIds, serverPipeline copy unit +
   resolution opts; then runSubmitJob orchestration (loop + flip);
   postSubmit; server tests.
7. CLI submit; cli tests.
8. Docs; full `npm test`; consider one opt-in e2e wave run before release.
