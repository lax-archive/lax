# Archive environments — plan

Status: proposed 2026-09-04 from the multi-version design discussion
(Jan's decisions recorded under "Decisions"; stage order, caps, and file
names are suggestions). **Stage 0 spike ran 2026-09-04**, verdict GO
(`spike/environments/REPORT.md`: inspector unchanged under v4.33.0, only
the prooftree composer needs a source fix). **Stage 1 landed 2026-09-04**: the table, selection
from the manifest, per-environment provisioning and inspector cache key,
pins as functions, the per-version literals module, and the build freshness
fix — one row (`v4.30.0`) and no author-visible change; see the spec-notes
entry of that date. Stages 2 to 6 are open. The investigation this
rests on covered every consumer of the pins module, the database and
resolution code, the inspector's Lean-version coupling, and the website's
version surfaces; the file:line references below were verified that day and
the ones stage 1 touched have since moved.

## Goals (Jan, 2026-09-04)

- **One recommended version, moved once a year.** Authors coordinate on
  it by default so the citation graph stays connected. It is called the
  **epoch**.
- **Straying is allowed, monthly, and nudged.** An author who needs a
  newer mathlib may submit against any admitted mathlib release, after
  confirming they understand the consequence: only submissions in that
  same environment can cite the work.
- **Old environments stay valid forever.** A record never becomes
  invalid because the epoch moved. Porting is a new submission that
  supersedes the old one.
- **No new author vocabulary beyond "epoch".** The manifest schema, the
  database layout, and the container image are unchanged.

## Vocabulary

- **Environment** — what the spec calls the archive environment, made
  plural: a Lean toolchain plus the mathlib commit it builds. Identified
  by the Lean version string (`v4.30.0`), which is also the name of the
  mathlib release tag whose commit it records. One environment per Lean
  minor version, pinned at mathlib's `vX.Y.0` tag. Verified 2026-09-04:
  mathlib tags every Lean release, patch tags sit on the matching patch
  toolchain, and the current pin `c5ea003…` is exactly mathlib's
  `v4.30.0` tag.
- **Epoch** — the environment the archive recommends this year. `lax
  init` uses it unless told otherwise. Exactly one at a time.
- **Floor** — the oldest admitted environment, `v4.30.0`. Nothing older
  will be admitted: the package-overrides and artifact-cache behaviour
  the warm store relies on did not exist in earlier Lake versions.
- **Island** — the set of submissions sharing an environment. Cross-island
  citation is impossible, not merely forbidden: an olean built by one
  Lean version cannot be loaded by another, and mixing two mathlib
  closures in one `LEAN_PATH` has no meaning. The resolution gate's
  existing hard rejection of a dependency capture built under other pins
  (`phases/resolution.ts:104-106`) is therefore kept verbatim.

Say "epoch" only for the yearly recommendation and "environment" for
everything else, in the CLI, on the site, and in the docs; otherwise a
`v4.33.0` submission ends up described as "in an epoch" and the nudge
loses its meaning.

## What already fits

The investigation found the code closer to this design than the single
pin suggests. These need no change and nobody should "fix" them:

- The warm store is one directory per (Lean version, mathlib commit)
  (`host/warmstore.ts:51-53`), with a comment saying a pin bump coexists
  with the previous store.
- The capture registry tag hashes the toolchain and mathlib commit into
  its identity (`shared/capture-store.ts:64-77`), so captures at two
  environments never collide.
- Every published record carries the pins twice: `inputs.manifest
  .leanVersion` / `.mathlibVersion` and `capture.leanToolchain` /
  `.mathlibCommit`. The environment id of any record is its
  `manifest.leanVersion`. No record schema change.
- Every validator checks against the threaded `ValidationRuntimeIdentity`
  (`contracts.ts:59-67`), never against the constants directly:
  `validators/manifest.ts:163-166`, `validators/lakefile.ts:116-119`,
  `phases/static.ts:82-85`, `artifact-schema.ts:120-126,237-241,462`.
  Selection is therefore a change in *where the runtime comes from*, not
  in the checks.
- The container image is Lean-agnostic (node + glibc) and the runtime
  mounts land at fixed paths under `/opt/lax` (`config.ts:114-122`).
  One image, per-environment host directories mounted at the same paths;
  the container never learns there are several.
- The paper layer and source fetching have no Lean coupling.

## Design

### The environment table

`src/submission-validation/environments.ts`, beside `pins.ts`. The Lean
pins leave `pins.ts` (which keeps the image, TeX, ReflowTeX, and PyMuPDF
pins and `LAYOUT_VERSION`); `MATHLIB_URL` stays a single constant because
only the canonical repository is ever allowed.

```ts
export interface ArchiveEnvironment {
  /** Lean version and mathlib tag name: "v4.30.0". The only author-facing id. */
  id: string;
  /** "leanprover/lean4:v4.30.0" — mathlib's own lean-toolchain at the tag. */
  leanToolchain: string;
  /** The commit mathlib's tag pointed to when admitted. Tags can move; this cannot. */
  mathlibCommit: string;
  /** ISO date of admission (the environments.yml run, or the go-live pin). */
  admittedAt: string;
  /** Inspector source directory under src/submission-validation/lean/. */
  inspector: "inspector" | string;
  /** Measured overrides of DEFAULT_LIMITS (leanThreads, memoryBytes). */
  limits?: Partial<Pick<ValidationLimits, "leanThreads" | "memoryBytes">>;
  /** Lever, unused at first: after this date new drafts are refused here. */
  closedAt?: string;
}
export const EPOCH = "v4.30.0";
export function environments(): readonly ArchiveEnvironment[];
export function environment(id: string): ArchiveEnvironment | undefined;
export function epoch(): ArchiveEnvironment;
```

Functions, not constants: the test seam (`LAX_MATHLIB_URL`/`LAX_MATHLIB_REV`,
plus a new `LAX_TEST_ENVIRONMENTS` JSON list that adds fake environments
sharing the installed toolchain) is read at call time, which also
removes the "importing src/ freezes the env" fragility the test
comments apologise for (`test/paths.ts:11-13`, `test/fake-mathlib.ts:8-10`).

The table only grows. An entry is never edited except to add `limits` or
`closedAt`. The trusted workflow reads the table at its own commit, and
the CLI compiles it in, so a new environment reaches authors with the
next release and a record in an environment the installed CLI does not
know says exactly that ("update lax").

### Selection

`ValidationRuntimeIdentity` gains `environment: string`. The manifest's
`leanVersion` selects it: the manifest validator runs first in the static
phase, looks the value up, and an unknown id is a `manifest` violation
whose message lists the admitted ids and the epoch. From then on the run
carries that environment's runtime; `hostValidationRuntime(env)` and
`configuredRuntime(env)` take it as a parameter. `mathlibVersion`, both
`lean-toolchain` files, and both lakefiles' mathlib `rev` are then
checked against that environment exactly as they are checked against
the single pin today.

Trust rule 2 applies to the id: it arrives from an untrusted manifest and
later from an untrusted report. It is only ever used as a lookup key
into the table; directory names, cache keys, and mount sources derive
from the *entry*, never from the input string. The trusted publisher
re-derives the runtime from the table with the id the report claims and
then runs the existing equality checks, so a report claiming pins that
are not the table's for that id fails as it does today.

### Host provisioning

Per environment, on demand, never all at once:

- `host/setup.ts` `ensureValidationHost({ environment })`: elan once,
  `elan toolchain install <entry.leanToolchain>`, the warm store for the
  entry, the inspector for the entry.
- `host/leanenv.ts`: `toolchainDir(env)`, `toolchainBinDir(env)`,
  `leancheckerBin(env)`, `lakeBinary(env)`, `hostLeanEnv(env, …)`.
- `host/warmstore.ts`: `warmDir(env, base?)`; `buildWarmWorkspace(env)`
  writes the lakefile from the entry. The six zero-argument `warmDir()`
  callers (`sandbox/layout.ts:65`, `pipeline.ts:617`, `cli/build.ts:159`,
  `cli/doctor.ts:788,901,1027`, `warmstore.ts:196`) get the argument.
- `sandbox/layout.ts` `ensureRuntimeLayout(env)`; mount targets unchanged.
- `config.ts`: `limitsFor(env)` = `DEFAULT_LIMITS` merged with
  `entry.limits`. The two-thread replay budget is a measurement of the
  v4.30.0 mathlib's 5.6 GiB import; the admission run records the new
  environment's peak so the entry can carry its own figure.
- The proof-tree composer (`cli/prooftree.ts:581-632`) keys its runtime by
  environment instead of mathlib commit alone (TODO.md already records
  the omission), resolves `lean` through the entry's toolchain bin rather
  than PATH, and refuses captures outside the target submission's
  environment with a message that names both.

Disk: about 7.5 GB per warm store and 2 to 4 GB per toolchain, per author
machine and per runner. Doctor states the cost before provisioning a
second environment.

### The inspector

The inspector is the real per-environment cost. It is four Lean source
files built by lake on each machine with the environment's toolchain and
cached by CLI version plus a hash of the sources (`host/inspector.ts:36-47`).
Four changes:

1. **Generated toolchain file.** `lean/inspector/lean-toolchain` is a
   hand-maintained duplicate of the pin with no test tying it to the pin.
   Delete it; `inspectorBinary(env)` writes it from `entry.leanToolchain`
   into the staging directory and folds the toolchain into the cache key.
2. **Loud drift.** `Main.lean:306-341` reads three persisted extension
   entries (`moduleDocExt`, `declRangeExt`, `Match.Extension.extension`)
   through `unsafeCast`, which misreads memory rather than failing to
   compile when a core type changes shape. Beside each reader, a
   `run_cmd` resolves the entry type's constructor and fails elaboration
   if its signature differs from the text recorded there. The admission
   build then catches drift instead of a golden-test diff or, worse, a
   silent wrong report.
3. **A golden fixture.** `test/fixtures/inspector-golden/`: a small
   package importing only `Init` (so it builds with no mathlib), whose
   expected inspector JSON is committed. `test/e2e/inspector-golden.test.ts`
   builds the inspector for the environment under test and compares.
   This is the output contract every environment's inspector must meet;
   the website relies on the same JSON.
4. **Snapshots at break points.** One source must compile under every
   admitted environment, since old ones stay open forever, and Lean has
   no conditional compilation. When a new release forces a change that
   cannot be written version-agnostically, freeze the old source as
   `lean/inspector-<label>/` and point the older entries' `inspector`
   field at it. The current directory keeps serving new environments.
   The matrix job below keeps every snapshot building.

The same treatment applies to `assets/prooftree/{Main,Verify}.lean`,
which share the `importModules … (loadExts := false)` coupling.

Per-version literals scattered today move into one module keyed by Lean
version, with a single value until a release changes one: the lake
manifest schema `"1.2.0"` (three copies), the core import roots
`["Init","Std","Lean","Mathlib"]` and the background-axiom triple
(duplicated in `phases/inspect.ts:15-16` and `cli/prooftree.ts:21`), elan's
directory mangling, lake's output paths, the leanchecker error regexes
in `failures.ts:114-128`, and doctor's version-banner parsing.

The remaining "verified empirically at v4.30.0" facts in the code
(overrides read after manifest validation, git materialisation without
`lake update`, the artifact-cache override landmine, the capture
companion set `.olean.hash/.ilean/.trace/ir/*.c(.hash)`, the
symlink-blind leanchecker scan, docstring dash stripping, reserved-name
predicates, the precomputed axiom-closure extension) become the
**admission checklist** section of this document. Each is covered by an
existing test where one exists; the ones that are not (artifact-cache
override, companion set) get a fake-mathlib e2e assertion in stage 3.

### Admission: `environments.yml`

A scheduled workflow in this repository. No App keys, no database
access, no author code; it runs mathlib, which is already the trusted
background import the warm store builds. Cron weekly plus
`workflow_dispatch` with a `tag` input.

1. **Discover.** `scripts/environments/discover.mjs` lists mathlib's tags,
   keeps `^v4\.\d+\.0$` at or above the floor and newer than a start date
   recorded in the script (so the backlog `v4.31.0`, `v4.32.0` is skipped:
   nobody needs them and each costs a run), drops the ones already in
   the table, resolves each remaining tag's commit with `git ls-remote`,
   and fetches its `lean-toolchain` to assert it equals
   `leanprover/lean4:<tag>`.
2. **Test**, one job per candidate, with the candidate injected as a
   test environment: install the toolchain, build the inspector (the
   shape guards fire here), run the unit and fake-mathlib e2e suites and
   the golden test under that toolchain, then the docker smoke against
   the real mathlib at the candidate's commit (cold `lake exe cache get`,
   about ten minutes on a hosted runner), recording the replay/inspect
   peak memory from the container's cgroup.
3. **Admit.** On green, `scripts/environments/admit.mjs` appends the entry
   (with `admittedAt`, `limits` from the measurement, `inspector:
   "inspector"`) and the job opens a pull request with the log summary,
   using the workflow's own token with `contents: write` and
   `pull-requests: write`. On red it opens an issue with the log tail,
   because the fix is inspector source work.
4. **Guard.** A separate `inspector-matrix` job in `ci.yml`, on changes
   under `lean/` or to the table and weekly: for every admitted
   environment, install the toolchain (no mathlib), build the inspector
   named by its entry, run the golden test. A dozen entries a year at a
   couple of minutes each.

The merged pull request reaches authors with the next CLI release. A
human reviews one small PR a month; that is the whole manual cost of a
new environment in the common case.

### Trusted workflow

`submission.yml` changes, all in the validate job:

- The static-gate step (already before the lean cache restore,
  `submission.yml:88-96`) additionally writes the selected environment id
  and a cache key to `$GITHUB_OUTPUT`. The key is
  `lax-validation-host-v2-<os>-<id>-<mathlibCommit12>-<inspector source hash>`,
  not a hash of the whole table file, so a monthly admission does not
  evict every environment's cache. No `restore-keys`, as today.
- The cache restore and save use that key; `setup-vm.js --env <id>`
  provisions only that environment. The GitHub Actions cache holds the
  epoch and whatever was used in the last week; anything else provisions
  cold in about ten minutes.
- The publisher (`workflows/submission.ts:537`) looks the report's
  environment id up in the table and passes that runtime to
  `parseSuccessfulValidationArtifacts`; the existing pin equality checks
  do the rest.

`release.yml` and `ci.yml` provision the epoch, as they provision the
single pin today. The live-rehearsal drill (`scripts/rehearsal/`) runs
before this stage ships, per `history/live-rehearsal.md`.

### CLI

- **`lax init [folder] [--env <id>] [--yes]`.** Default: the epoch, no
  prompt, no network. `--env` naming the epoch: same as default. `--env`
  naming another admitted environment prints a short block — the epoch,
  the chosen environment, the number of registered submissions in each
  (from the local database clone's `manifest.leanVersion` values; "run
  `lax sync` to count" if there is no clone), and the sentence "only
  submissions in <id> can cite this work" — then asks the author to type
  the environment id, through the existing `confirmTyped`
  (`cli/confirm.ts`). Without a terminal it refuses and names `--yes`,
  exactly as register and delete do. An unknown id fails with the
  admitted list and "update lax if the environment is newer than this
  CLI". There is no `latest`. Provisioning the chosen environment
  follows, with the disk cost stated first when it is the machine's
  second environment.
- **`lax build` / `lax submit`** read the environment from the manifest.
  The cached-build freshness check (`cli/build.ts:486`) compares only the
  image digest, which is the constant `"host"` locally; it must also
  compare the environment's commit.
- **`lax doctor`** reports the epoch, the admitted environments, and which
  are installed; the per-submission preflight reads the submission's
  environment and provisions that one. `lax doctor --env <id>`
  pre-provisions.
- **`lax port <lax-N> [folder] [--env <id>]`** (stage 4, the enabler for
  epoch bumps): clones the record's source triple from the local clone at
  its commit into a fresh folder, rewrites both `lean-toolchain` files,
  both lakefiles' mathlib `rev`, and the manifest's two version fields to
  the target environment (default: the epoch), adds `supersedes: lax-N`,
  and repoints every cross-submission require to the dependency's
  registered version in the target environment, found by walking the
  supersedes chain; a dependency with none is left as is with "port
  lax-M first" — ports flow bottom-up like the chain workflow. It is
  scaffolding only; the author still fixes the Lean and submits.
- **`lax print instructions`** (`assets/instructions.md`): "use the default
  environment; pass `--env` only when the human asked for a specific
  one, and expect to confirm it".

### Website (lax-website)

- The site needs one value it cannot derive from records: the epoch.
  `src/config.ts` in lax-website carries it (edited once a year); `lax
  serve` passes its own table's epoch as the third `generateSite`
  argument (`cli/website.ts:629-631` passes two today).
- **Notice**, beside `draftBanner()` (`sitegen/pages/shared.ts:533-537`) on
  the same five page types: "Environment v4.33.0. The archive's epoch is
  v4.30.0; only submissions in v4.33.0 can cite this work." Muted
  styling, the draft banner's palette, no warning icon.
- **Facet and grouping.** `data-env` on listing rows via
  `submissionSearchAttributes()` (`shared.ts:396-409`) and the environment
  folded into `data-tags` so the existing chip filter works unchanged; a
  flat facet is fine at a dozen values a year. Library order: epoch
  first, other environments by version descending, superseded after,
  using the existing `entry-heading` groups (`shared.ts:452-455`). The
  masthead's existing `Lean … · mathlib …` line gains an "epoch" label
  when the record is in it; the version dialog already prints pins per
  version.
- **`index.json` and `environments.json`** at the site root, written by
  `generateSite`: per record `{id, state, environment, title, supersedes,
  supersededBy, concepts: [{id, title, type}], proofs: [id]}`, and
  `{epoch, environments: [{id, registered, drafts}]}`. There is no
  machine-readable output of any kind today; agents clone the database
  or scrape HTML. `contributing.md` links both. Adding a path to the
  CLI's `REQUIRED_RENDERER_PATHS` waits for the renderer release that
  carries it (`cli/website-renderer.ts:12-19`).
- `BuildOutput` in `src/types.ts` declares `capture` so the toolchain
  string is typed rather than reached through the spread.

### Database

Unchanged: flat `lax-N/` with the closed set of three files. Environment
folders were considered and rejected: the `init` record exists before
any manifest names an environment, a draft may change environment
between submits, and every reader resolves by id (resolution snapshot,
tree walks, publisher stale-write checks, port script, site URLs). The
index above answers "what can I cite in environment X" better than a
folder would, and `lax init`'s sharing count reads the local clone.

### Islands, porting, and the epoch bump

A record has exactly one environment for life. Moving work is a new
submission with `supersedes`, which already gives the site a version
chain with per-version pins and already keeps endorsements from carrying
over. Supersedes across environments needs no rule change.

Epoch bump runbook (yearly):

1. Pick the environment a month or two after its release, once the
   month's patch situation is known. Announce it as the next epoch a
   quarter ahead, in README and on the site.
2. Authors port with `lax port`, bottom-up. The old epoch stays open.
3. Flip `EPOCH` in the table and the site config; CLI release; renderer
   release; re-pin the page-builder.
4. Re-measure limits on the new epoch's mathlib and record them in its
   entry. Optionally mirror its warm store to the capture registry as one
   OCI artifact so "frozen forever" does not depend on mathlib's cache
   retention (a dozen environments a year at 7.5 GB each is affordable
   for the epochs alone; the rest can wait until a cache goes missing).
5. `closedAt` on very old epochs is available as a nudge lever; leave it
   unused unless islands proliferate.

## Stages

0. **Spike (half a day).** Build the current inspector source under
   `v4.33.0`; run the fake-mathlib e2e suite under it (the fake's
   toolchain literal changes); list which of the checklist facts break.
   Measure one cold `lake exe cache get` at mathlib `v4.33.0` and the
   replay peak on a hosted runner. Outcome: whether the first admission
   needs a snapshot, and the admission job's expected duration. GO/NO-GO
   for stage 3's shape only; stages 1 and 2 are worth doing regardless.
1. **Table and selection.** `environments.ts`; runtime carries the id;
   per-environment provisioning, layout, inspector cache key and
   generated toolchain file; pins as functions; a second fake environment
   in tests and an island-rejection test; the build freshness fix.
   Single entry, `v4.30.0` as epoch. No author-visible change. Release.
2. **Trusted workflow.** Static gate outputs, per-environment cache key,
   `setup-vm --env`, publisher lookup. Rehearsal drill, then ship.
3. **Admission.** Shape guards, golden fixture, `inspector-matrix`,
   `environments.yml` with discover/admit scripts. First admission is
   whichever `vX.Y.0` is newest when this lands. Release.
4. **CLI.** `init --env` with confirmation, doctor, instructions,
   `lax port`. Release.
5. **Website.** Notice, facet, grouping, epoch config, the two JSON files,
   `lax serve` passing the epoch. Renderer release; re-pin page-builder.
6. **Docs.** spec-notes entry; README status and command table;
   CLAUDE.md architecture paragraph; TODO. History note after the first
   real off-epoch round trip.

Stages 1 to 3 are the feature; 4 and 5 make it usable; 6 closes it.

## Admission checklist

Facts the pipeline relies on that were verified by hand at v4.30.0. Each
new environment either has a test covering the fact (T) or the admission
run's operator confirms it (M) until a test exists.

- (T, e2e) Lake reads `.lake/package-overrides.json` on `lake build` and
  substitutes after manifest validation — `host/warmstore.ts:6-9`.
- (T, e2e) Locked git manifest entries materialise on `lake build` alone,
  no `lake update`, no post-update hook — `warmstore.ts:30-34`.
- (M → T in stage 3) `LAKE_ARTIFACT_CACHE=false` is not overridden by any
  lakefile in the mathlib closure — `warmstore.ts:126-132`.
- (T, e2e) Manifest entry shapes: `inputRev` equals the declared rev;
  `inherited: false` accepted — `warmstore.ts:307-309`.
- (M → T in stage 3) The capture companion set lake needs to consider a
  path dependency fresh — `captures/seal.ts:53-73`, `provision.ts:181-186`.
- (T, e2e) leanchecker's module scan ignores symlinks (hardlinks used) —
  `host/pipeline.ts:647-649`.
- (T, golden) Docstring leading-dash stripping; reserved-name predicates
  incl. private prefix; `Match.Extension` empty under `loadExts := false`;
  precomputed axiom-closure extension deliberately unread; `ppExpr`
  application form — `Main.lean:63-70,150-216,296-300`.
- (T, guards) The three persisted extension entry types' shapes.
- (T, unit) `lake query -J +<mod>:olean` output shape — `host/pipeline.ts:625-645`.
- (M) Replay/Inspect peak memory at two threads fits the 16 GB cap.
- (M) `lake exe cache get` exists and succeeds at the tag.

## Risks and accepted trade-offs

- **A Lean release breaks the inspector.** Caught by admission before
  any author sees it; the fix is manual; snapshots bound the blast
  radius. Accepted: this is the cost of `loadExts := false`, which stays.
- **Environment id as untrusted input.** Only ever a table key; paths
  and cache keys derive from the entry. A test asserts that an id with
  path characters is rejected before any filesystem use.
- **GitHub Actions cache ceiling** (10 GB per repository, 7-day eviction):
  per-environment keys; a lonely environment costs a cold ten minutes.
- **Mathlib cache retention** for old tags: mirror epochs to the registry
  when it becomes a problem; the anchor of the promise is the epoch.
- **Tag mutability**: the commit is recorded at admission and the tag is
  never re-resolved; admission asserts the tag's toolchain.
- **Fragmentation**: nudges and sharing counts; the `closedAt` lever.
- **Concept-dialect snapshot** (spec_conceptdialect_draft.md) is reviewed
  per pin today; it becomes per environment, generated in the admission
  run.
- **Mathlib docs links** on concept pages already drift from the pin;
  with several environments the drift is visible. Upstream docs are not
  versioned; accepted.
- **Author disk**: 10 GB per environment; doctor says so.
- **CLI/table skew**: an old CLI meeting a new environment fails with
  "update lax"; the table only grows, so a new CLI reads every record.

## Spec impact

spec.md is Jan's to reconcile. The entries due:

- "Archive Environment" (spec.md:60-75) becomes a table of environments
  with the epoch marked; the axioms and build options stay archive-wide.
- Manifest fields (spec.md:139-170): `leanVersion` is the environment id
  and selects the environment; `mathlibVersion` must be that environment's
  commit.
- "Pinned toolchain" and the mathlib require rule (spec.md:208-210, 252):
  "the submission's environment" instead of "the archive-wide" pin.
- Dependencies: a required submission must be in the same environment
  (already the effect of the capture-provenance rule; now stated).
- `lax init` gains `--env` and `--yes`; `lax port` is new.

A spec-notes.md entry records the deviation when stage 1 lands, and the
supersedes entry gains a sentence on cross-environment ports.

## Decisions (Jan, 2026-09-04)

- Yearly epoch as the default; monthly straying allowed and nudged.
- Environments are mathlib `vX.Y.0` release tags only, not arbitrary
  commits and not release candidates; patch releases only when added
  deliberately.
- `--env` requires a typed confirmation interactively and `--yes`
  non-interactively; no `--latest`.
- The inspector is built per environment from source shipped in the CLI;
  admission is a scheduled workflow that opens a pull request.
- The database keeps its flat layout; the website emits the index.
- The word is "epoch". "LTS" is wrong because no upstream support exists.

## Open decisions

- Whether to admit the backlog (`v4.31.0`, `v4.32.0`) or only forward from
  stage 3 (recommended: forward only).
- Whether the site's epoch lives in a config file (recommended) or in a
  JSON the admission PR mirrors into lax-website.
- Whether `closedAt` ships in stage 1 as an unused field or is added when
  first needed (recommended: ship the field, never set it).
- Whether to record `environment` explicitly in `build-output.json`
  (recommended: no; `manifest.leanVersion` is the id and the record
  schema stays untouched).
