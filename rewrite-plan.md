# rewrite-plan.md — answers and plan for rewrite.md

Companion to rewrite.md. Based on a full read of both repos (old: `../lax`,
7.4k LOC src + 5.9k tests; this repo, 11.3k LOC src + 6.1k tests + 809 lines
of workflow YAML; "old lax"/"laxnew" below refer to those two). Written
2026-08-05 in the old repo and copied here; this copy is canonical. Stage
status lives in TODO.md ("The rework").

## Running the plan (orchestrator protocol)

Jan kicks off a fresh session with just **"continue the rework"** — no more
is needed. That session acts as the orchestrator:

1. Read CLAUDE.md, rewrite.md, and this file; find the first unfinished
   stage in TODO.md's order of attack.
2. Launch one worker agent for that stage, isolated in a git worktree, with
   a targeted prompt: the relevant sections of this plan, the file pointers,
   and the stage's done-when criteria below. A large stage may be split into
   sequential worker runs; never run two workers whose areas overlap.
   Workers obey CLAUDE.md's rules (especially: no spec edits).
3. The orchestrator reviews the worker's diff itself — against this plan and
   against rewrite.md's constraints (keep: CAS write path, credential-free
   preflight, container hardening + watchdog, URL narrowing, temp+rename
   writes; do not reintroduce: custom runtime image, multi-job validation,
   sibling machinery) — and runs `npm run check` before accepting.
4. Land the stage as one commit on main ("Stage N: <title>"), tick it off in
   TODO.md, report what changed and what is next, then stop for Jan's go.
   "go" is a sufficient answer.
5. If implementation reveals this plan is wrong somewhere, stop the worker,
   record the deviation in this file (and spec-notes.md if spec-relevant),
   and put it in the report — never silently diverge.

Done-when per stage:

- **Stage 2 (seams + local build)**: starts with the package-overrides
  spike (red-team addendum, point 5) — its outcome decides how local build
  shares mathlib; do not rebuild the hardlink farm. Then: `lax build` runs
  without docker on the host toolchain, incrementally, with streamed
  transcripts; `pipeline.ts` accepts an injected runner; fake-mathlib and
  fake-GitHub seams exist with at least one subprocess-level test using
  each; `npm run check` green.
- **Stage 3 (pipeline collapse)**: gated on the replay-memory measurement
  (red-team addendum, point 1). submission.yml has one read-only
  validation job; all three phases (Compile, Replay, Inspect) run
  sequentially through the same container runner and stock pinned image;
  validation-runtime.yml and the custom Containerfile are
  gone; pins live in `src/constants.ts` (or equivalent); toolchain +
  `lake exe cache get` install on the VM with actions-cache; ghcr cache
  keyed (repo, folder, commit, proof|concept) plus the toolchain/mathlib
  pin, digest-verified per addendum point 2, read in Provision and written
  by the publish job; smoke fixtures pass on the new layout; **a live
  rehearsal** (scratch control repo + scratch database repo) has run a
  real issue → validation round trip (addendum point 3).
- **Stage 4 (write path)**: publish behavior unchanged (CAS + preflight,
  fail-closed immutable-release check); **CAS-only, no concurrency group**
  unless queueing semantics are positively verified (addendum point 4);
  no inline JS in YAML; routing/publish logic lives in TS with behavioral
  tests replacing the YAML string assertions; the live rehearsal covers
  publish and website dispatch end to end.
- **Stage 5 (test port)**: the Tests-section triage executed area by area;
  fast suite green without docker; opt-in real-mathlib E2E documented and
  run once.
- **Stage 6 (follow-ups)**: independent items (siblings removal, statement
  cardinality, package-overrides spike, CLI polish) — one worker each,
  each with its own commit.

## Verdict in one paragraph

The rewrite is better than feared and worse than hoped. Its trusted write
path is genuinely good (credential-free re-validation before token minting,
immutable releases, compare-and-swap branch advance), its resource limits
close the biggest open item from the OOM postmortem, and it resolved two open
security TODOs. But it is over-staged (three Actions jobs where one would do,
~250 lines of YAML + multi-GB tarball handoffs + three pulls of an ~11 GB
image existing only because Compile/Replay/Inspect are separate jobs), it
bakes mathlib into a custom container image with its own build/promotion
workflow (the exact review surface rewrite.md wants to avoid), its local
`lax build` is Docker-mandatory and non-incremental (the opposite of what we
want), it has no fake-mathlib/fake-GitHub/E2E test seams (the old suite's
main strength), and it silently dropped TODO.md, history/, and several
load-bearing rationale comments. The plan below keeps its wins and unwinds
the rest.

## Build pipeline

The proposed two-runner design in rewrite.md is strictly simpler than what
laxnew built, and nothing in laxnew's code argues against it. Concretely,
collapsing validation into **one read-only runner job** deletes:

- the Compile→Replay/Inspect stage-handoff machinery (`run.ts` StageState,
  stage-state.json, resume checks): the workspace tarball is packed, uploaded,
  and unpacked twice per submission;
- three separate pulls of the runtime image on three fresh runners;
- the pass-through `validation_request` job output and the `validation-result`
  job whose real work is one `echo` (both exist only for DAG cosmetics);
- 8× repeated checkout/setup-node/npm-ci/build prologues (32 steps).

Replay and Inspect lose their parallelism, but they were already serialized
behind Compile and each paid an image pull plus tarball unpack; on one runner
they can still run as two concurrent processes if it ever matters.

### Sandbox: docker with a plain image — agreed, with the evidence

- **bwrap**: hosted `ubuntu-latest` (24.04) restricts unprivileged user
  namespaces via AppArmor by default, so non-setuid bwrap needs a sysctl or
  profile tweak per run. It works, but it is exactly "flaky to set up," and we
  would be re-testing that assumption on every runner-image update. Docker is
  preinstalled, first-class, and what every other Actions user exercises
  daily. Verdict: docker.
- **No custom Dockerfile**: laxnew's image is a 102-line Containerfile + 240
  lines of in-image .mjs helpers + a lock file + a separate build workflow
  (`validation-runtime.yml`) + manual digest promotion + a runtime-manifest
  equality check. All of that exists to bake mathlib+toolchain into the image.
  If instead the runner installs elan/lake/lean and runs `lake exe cache get`
  on the VM (as rewrite.md proposes) and the container is a stock pinned image
  (e.g. `node:22-bookworm-slim@sha256:…`) with read-only mounts of the
  toolchain, mathlib, and workspace, the entire custom-image surface
  disappears. Pins go back where old lax kept them: `src/constants.ts`.
  Cost comparison: `cache get` downloads roughly what the image pull
  downloaded anyway; per-run wall time is a wash, and with an actions-cache of
  the elan+mathlib tree it is likely faster. Making the case for Dockerfiles
  honestly: the baked image gives an immutable, smoke-tested artifact and a
  warm layer cache. That is real, but it costs a second trusted-build
  pipeline, a promotion ceremony, and image-vs-code version skew — not worth
  it for us.
- **Keep from laxnew's container invocation** (it is good and small,
  ~200 lines): `--read-only --cap-drop=ALL --no-new-privileges
  --network=none --memory --cpus --pids-limit --tmpfs`, allowlist-only mounts,
  env allowlist, output byte-cap, timeout→SIGKILL, and the 250 ms workspace
  size/entries/free-disk watchdog. Also keep the fail-closed pattern where the
  in-sandbox entry refuses to run if `LEAN_NUM_THREADS` is missing (the
  `--clearenv` OOM lesson, now enforced in code).
- **Replay/Inspect: containerized, same as Compile** — decided by Jan
  2026-08-05, superseding rewrite.md's "outside docker, on the vm" line
  after the analysis in addendum point 8: placement doesn't change the
  integrity model either way, and since the stock image and container
  runner exist for Compile anyway, containerizing costs no new review
  surface while buying defense-in-depth (a partial leanchecker exploit
  must be fully weaponized and lie within the report schema instead of
  rewriting the report on the host) and per-phase memory/pids caps. Run
  them with `--network=none`, read-only mounts of toolchain, mathlib, and
  the sealed capture, and a writable mount only for the output. The two
  old-lax trust rules carry unchanged into the container: never
  `lake env` (compose `LEAN_PATH` by hand from what the *runner*
  installed plus verified capture contents, never from anything Compile
  wrote), and realpath every `LEAN_PATH` entry (leanchecker's module scan
  is symlink-blind — this rationale survives in old
  `src/pipeline/leanenv.ts:66` and must not be lost again). This is the
  trusted CI path only: **local** `lax build` stays docker-free, with
  opt-in `--replay` running the host leanchecker as before.

### Olean cache on ghcr keyed (repo, folder, commit, proof|concept) — agreed

laxnew stores captures as immutable GitHub Releases keyed
`(submissionId, sha256(capture.tar))`, discovered by reading the dependent's
`build-output.json` out of a database checkout. The proposed key is better:
it is derivable *before* any build from Resolution's output alone, so
"provide cache" is a pure lookup with no database join. Push/pull via `oras`
(or `docker`-compatible artifact push) to ghcr; tag = a sanitized encoding of
the tuple; record the digest in `build-output.json` as belt-and-suspenders.

What to cut from laxnew's ~960-line capture machinery: the hand-rolled USTAR
block parser (`capture-archive.ts`, 197 lines) and the triple re-verification
(the same inventory is hashed at seal, at publish, and per-file at
materialize). Keep: deterministic tar flags, one sha256 over the tarball,
one full inventory verification at consume time, read-only chmod + mtime
touch after extraction. That is ~⅓ the code for the same guarantee.

### Write runner and concurrency (the "parallelism" question)

Better idea than "make the second runner atomic": **keep laxnew's optimistic
compare-and-swap and drop everything else.** The mechanism
(`archive.ts:writeFiles`) is: re-read head → re-validate → build commit on
that head → advance the ref with `force: false` (GitHub rejects non-fast-
forward, which *is* an atomic CAS) → on conflict, loop. That is ~100 lines,
already written, correct under any interleaving, and needs no lock service.
Two adjustments:

1. Put all write-runner invocations in **one global** Actions concurrency
   group (not per-issue) so the CAS loop almost never spins. Caveat to verify
   before relying on it: classic Actions `concurrency` keeps only one
   *pending* run and cancels older pending ones — that would silently drop
   queued submissions. laxnew writes `queue: max`, which our own test suite
   only string-asserts; confirm the semantics actually exist on GitHub's side.
   Even if queueing works, the CAS loop stays as the correctness mechanism;
   the group is just an optimization.
2. Keep the structural rule that made laxnew's publish path trustworthy: the
   write runner re-validates artifacts **credential-free first** and only then
   mints the short-lived write token. Also keep: immutable-releases-enabled
   fail-closed check, and cache append (ghcr push) only after the database
   commit succeeds — promoting early leaves garbage, never inconsistency
   (same principle as old lax's keyed captures + sweep).

One thing to delete outright: `report-workflow-failure`'s ~55 lines of inline
untyped JS in the YAML that duplicates typed, tested TS. All logic lives in
TS entry points; YAML stays a thin dispatcher (this also makes the workflow
testable, see Tests).

### Profiling

laxnew already has the span-tree profiler (`--profile`,
`validation-profile.json`, echoed into step summaries) and it matches the
wish list. With a single validation job it gets simpler (no `actions: read`
grants, no per-job stitching). Add spans for VM setup: elan install, `cache
get`, image pull, npm install. Keep the rule that nothing authenticating a
publication reads the profile.

## Sibling paths — fully forbid: cheap and already half-done

laxnew never implemented batch submit, so only the sibling *require*
machinery remains: deleting it removes `phases/siblings.ts` (480 lines) + its
test (229 lines), ~60 lines of sibling arms in provision, ~23 in resolution —
and, notably, the only two places the validator executes `git` on the host
against an untrusted checkout, outside any container. The own-package
`proofs → ../concepts` edge is separate machinery and stays. The
commit-then-patch-hash chain workflow and the `lax submit A B C` macro are
CLI-only, later; the discoverability hook is: wherever Static/Resolution
rejects a path-require or an unknown dependency commit, the error text walks
the user through the chain workflow. (Per rewrite.md: no deeper design now.)

## Multiple statements per concept

Backend cost is small: the cardinality gate is one violation in
`phases/inspect.ts` (per one-axiom-plan.md), and statement ids already exist
as first-class data (resolution compares them). Removing the gate re-opens
one-axiom-plan.md's questions only insofar as `type` semantics — punt, per
rewrite.md. Anonymous per-statement indices are purely lax-website work.
(No deeper design now.)

## Local build — the biggest single divergence to fix

laxnew's local `lax build`: hard-requires docker *and* a `LAX_VALIDATION_IMAGE`
env var (no default baked in — a fresh install fails with an env-var error),
copies the whole repo to a temp dir **excluding `.lake`** (twice, once per
package), so every build recompiles from scratch and discards what the
author's own `lake build` already produced, then flattens Lean error
transcripts to a single truncated line. Old lax: host elan/lake, builds in
the author's own folders (incremental), streams the transcript live.

Plan: restore the old-lax local mode via a **runner seam**. Today
`pipeline.ts:336` hard-instantiates `ContainerRunner`; make the runner
injectable (`HostRunner` locally, `ContainerRunner` in CI, fake runner in
tests). Static/Resolution are already pure and shared. This one seam fixes
local build, kills the docker requirement locally, and unlocks the test
plan below. Local replay stays opt-in `--replay` (host leanchecker).

## Tests — port, after adding three seams

laxnew has more tests (201 vs 172) and is stricter on trusted-boundary
parsing, but it traded every "real Lean, real process, real wire" test for
fake-runner contract tests and ~45 string assertions against workflow YAML.
There is no full-pipeline E2E in vitest at all; the only executable proof the
system works is 6 smoke fixtures that CI runs only when runtime sources
change. The old tests are portable once three seams exist:

1. **Fake mathlib** (`LAX_MATHLIB_URL`/`LAX_MATHLIB_REV`): trivially returns
   once pins live in `constants.ts` again instead of a container lock file —
   a direct consequence of the no-custom-image decision. Port
   `test/fake-mathlib.ts`, `global-setup.ts`, `paths.ts` (`~/.cache/lax-test`
   shared cache), and the 600 s timeout config wholesale.
2. **Fake GitHub reachable from subprocesses**: `LAX_GITHUB_API_URL` already
   exists in laxnew's constants but nothing uses it. Build a small local
   fake-GitHub HTTP server (successor of `LAX_FAKE_GITHUB` +
   `LAX_FAKE_GITHUB_USERS`, now also faking the App device flow, issues,
   Actions runs, Releases). This unlocks porting `test/cli.test.ts` (25
   tests), the full author journey, and gives `lax doctor` its first test.
3. **Runner injection** (same seam as local build) for fast full-pipeline
   tests against fake mathlib, plus real-container smoke kept for CI.

Port targets, triaged: pipeline/edge/replay tests → port onto seams 1+3;
cli/server-e2e author journeys → re-derive onto seam 2 (issue flow instead of
server HTTP); siblings/wave tests → moot (feature dropped); warm-store
hardlink tests → moot if package-overrides land (below), warm-build tests
stay; sitegen/DAG tests → belong to lax-website. Additionally: lift the
routing/publish orchestration fully into `src/workflows/submission.ts`-style
TS entry points so `workflow-definition.test.ts`'s YAML string-matching can
become behavioral tests of the TS.

## Local CLI

Parity is mostly real (build keeps `--profile --replay --only
--build-from-source`; serve, delete, register, set-owners, update-db fine;
login/logout are richer). Gaps to fix in the plan:

- **`--resume` is gone entirely.** If `lax submit`'s polling is interrupted,
  the only recovery is the browser. The new equivalent is cheap and *better*
  than old lax's job-ids: the durable job record is the Actions run, so
  `lax submit --resume` (no argument needed) can re-derive the correlated
  run from the issue + command comment and re-attach `follow`. Print that
  exact recovery command on any transport failure, like old lax did.
- **`lax update` name collision**: old lax's `update` upgraded the CLI; new
  `update` is the explicit source-triple submit. Rename the new one (e.g.
  fold into `submit --repository/--commit`) or accept the break consciously —
  decide at write time, but don't ship the collision silently.
- `--build-from-source` changed meaning (was: compile mathlib from source
  when `cache get` fails; now: build the runtime image). With the no-image
  design the old meaning returns; keep `cache get` failure **fatal** by
  default (hiccups lesson: never silently fall into an hours-long source
  build).
- Old `init --id` offline allocation is gone (id now requires opening an
  issue). Probably fine; note it in instructions.md.

## Institutional knowledge — consolidation plan

Facts: all spec files are byte-identical copies **except** laxnew's spec.md,
where an agent inserted one subsection ("Continuous preview while authoring",
after old line 1026) — in violation of the don't-edit rule; review and either
bless it into spec.md or move it to spec-notes.md. `spec_conceptdialect_draft.md`
and `one-axiom-plan.md` exist identically in both repos already. laxnew's
CLAUDE.md keeps the don't-edit-specs rule and adds 7 good trust rules, but
its step 1 points at a file that exists nowhere ("lax repository and workflow
overview.md"), and its README is one commit stale (still describes the
removed disk-reclaim step).

Consolidation: the new repo's CLAUDE.md = old repo's structure (document
roles, architecture, test seams, commands) + laxnew's trust rules
(3/4/5/6/7, updated to the simplified design); fix the dangling pointer.
Port `history/` verbatim and add a rewrite record for the front/worker→
Actions arc. Recreate TODO.md by triaging the old one against the rewrite
(many items are now resolved or moot — see next section for the survivors).
spec-notes.md needs a new entry: the auth model changed from OAuth device
flow + `LAX_GITHUB_TOKEN` (which spec-notes still records as the decision) to
GitHub App user tokens with `LAX_GITHUB_TOKEN` intentionally unsupported.
Re-home the lost rationale as code comments where the behavior lives:
symlink-blind leanchecker, why `lake update` never runs / `post_update` never
fires, the `--clearenv` env-delivery lesson, the notation-unexpander
rendering note from the old README.

## Open-users notice

Per rewrite.md this is settled and not for discussion here; the only work
item is the user-facing sentence in instructions.md/README that cloning and
building other people's submissions is at the user's own risk.

## Anything else — pain points the rewrite missed (and wins to not lose)

Missed / regressed, worth carrying into the new TODO.md:

- **Shallow-fetch gap carried over verbatim**: `fetch --depth 1 origin
  <commit>` → `fetch --depth 1 origin` fallback still misses valid historical
  commits not at a ref tip; the TODO that tracked it was lost.
- **Memory numbers are unmeasured**: Compile hardcodes `LEAN_NUM_THREADS=4`,
  Replay/Inspect use 2, inside a hard 16 GiB cap with **no swap** (the old
  box's 32 GiB swap once absorbed a 17.3 GiB replay overflow). The old
  "re-measure Replay, confirm rather than assume" item is homeless; revive it
  before trusting the caps.
- **Author frictions unchanged and their record lost**: Apache-2.0-only
  license gate (salvaged MIT code has no path), `Batteries.*` imports still
  rejected (and the new violation message no longer lists what *is*
  importable), flat-concepts/namespace-ownership still blocks faithful
  multi-module ports. All three predate the rewrite; re-file them.
- **Violation messages** still cite no spec section and show no offending
  line (old TODO item), though laxnew's 25 distinct violation kinds (vs 9)
  are a real improvement to build on.
- Local compile errors flattened to one truncated line (fixed for free by
  the host-runner local mode with streamed output).

Wins in laxnew that the simplification must preserve: credential-free-first
publish preflight; immutable-release fail-closed check; container resource
caps + workspace watchdog; env allowlist with fail-closed consumers;
source-URL narrowing to canonical `https://github.com/owner/repo` (closed
two old SSRF/local-mount TODOs); repo-wide symlink rejection in fetched
sources; temp+rename for every local write; follow.ts's live job/step
polling UX; doctor's docker/daemon/db-freshness checks.

## Other todos from rewrite.md

- **Package overrides instead of the hardlink farm**: neither repo uses Lake
  package overrides today. Plan: `lax init` writes a gitignored overrides
  file pointing mathlib (and later, dependency captures) at one shared local
  checkout; `lax build`'s Static phase rejects a checked-in overrides file
  (it would corrupt reproducibility); this also becomes the recommended
  two-drafts-in-parallel workflow. **Needs a spike first**: confirm Lake
  reuses the override's `.lake/build` artifacts (oleans) rather than just
  its sources, and how overrides interact with our always-lax-generated
  `lake-manifest.json`. If the spike passes, `warmstore.ts`'s linkFarm/repair
  machinery (~150 lines) and its tests die; the warm checkout itself (scaffold
  + `cache get` + read-only chmod + ready marker) survives as the override
  target.
- **No silent waits**: every command prints a line immediately. Known silent
  spots in laxnew to fix: build's spinner only updates on phase *start*
  (30-min compile looks frozen — stream `lake build` output like old lax);
  `lax login` polls with zero output; capture downloads show one static line.
  The silent implicit multi-GB `docker pull` under a 60 s timeout disappears
  with the no-custom-image design.
- **Progressive doctor**: print each check as it completes instead of
  buffering all (~60 s worst-case silence today: 3 tool probes, docker info,
  2 GitHub calls, `git ls-remote` at 30 s, image inspect, statfs). Trivial
  restructure of the `checks[]` loop; applies to both repos' doctors.

## Suggested order of attack (when we start writing)

1. Doc consolidation (CLAUDE.md, TODO.md triage, history/, spec-notes entry) —
   cheap, and it fixes the ground truth everything else refers to.
2. Runner seam + local build restoration + fake-mathlib/fake-GitHub seams —
   this is the enabling move for everything else and for porting tests.
3. Pipeline collapse to one validation job + plain pinned image + VM
   toolchain install + ghcr tuple-keyed cache.
4. Write path: keep CAS, global concurrency group, thin YAML, delete inline JS.
5. Port the test suite area by area.
6. Sibling removal, statement-cardinality relaxation, package-overrides spike,
   CLI polish (--resume, naming, progressive doctor) as independent follow-ups.

## Red-team addendum (2026-08-05)

An adversarial pass over this plan after it was written. Where the addendum
contradicts earlier sections, the addendum wins.

1. **Replay memory is a go/no-go gate for the whole architecture, measure
   it before stage 3.** history/oom.md: a full replay peaked at 14.7 GiB
   RAM + 17.3 GiB swap at 4 threads. A standard hosted runner has 16 GB
   total, no swap, OS and Node included (laxnew's `--memory=16GiB`
   container cap exceeds the VM's usable RAM and never actually bound).
   If mathlib-scale replay doesn't fit at 1–2 threads, the options are
   paid larger runners or self-hosted ones — either changes the
   architecture's economics. Measure with a real big submission first.
   Corollary: do **not** run Replay and Inspect concurrently on one
   runner — two mathlib environment imports in 16 GB is the oom.md
   failure mode; the "two concurrent processes" remark in the Build
   pipeline section is retracted.
   **Measured 2026-08-05 — GO.** Heaviest real submission (word-ram, 148
   proof modules, 96k LOC): leanchecker peak RSS **10.78 GiB at
   LEAN_NUM_THREADS=2**, 5 min wall, inside a 14 GiB swapless cgroup
   emulating the runner; fresh compile of the same submission peaked at
   only 3.84 GiB at 4 threads (compile is not the constraint). The
   mechanism: leanchecker replays only modules matching the target
   prefix, one task per module, each holding its own imported
   environment — one full-mathlib environment import is ~5.6 GiB, so
   memory ≈ 5.5–6 GiB × concurrent tasks: t=1 ≈ 6–7 GiB, t=2 ≈ 11–12 GiB
   worst case (fits), t=4 ≈ ~21 GiB (matches the oom.md incident; never
   fits). Design consequences: replay/inspect run at **2 threads max**
   on hosted runners, never concurrently with each other, and a third
   mathlib-scale environment import must never coexist with them.
2. **The tuple cache key — corrected after Jan's pushback; the original
   version of this point overclaimed.** The original mutable-draft attack
   ("one tuple can map to different oleans over time") is wrong: every
   cross-submission require is an exact (url, rev) pin in the dependent's
   lakefile, so a submission's commit transitively pins its entire source
   closure — updating a draft dependency forces a lakefile edit and hence
   a new commit in every dependent (this is the chain workflow's own
   mechanic). Given that invariant, capture content is a function of
   (repo, folder, commit, proof|concept) plus the global toolchain/
   mathlib pin. What survives: (a) **include the pin in the key**, else a
   pin bump silently serves incompatible oleans; (b) ghcr tags are
   mutable, so **digest-verify** each downloaded blob against the digest
   recorded in the dependency's build-output.json — nearly free, since
   Resolution reads that record anyway (which also means the "no database
   join" advantage claimed in the Build pipeline section was never real);
   (c) the soundness invariant is *requires are rev-pinned in source* —
   sibling path requires violate it, so the sibling removal is
   load-bearing for this key, and a package-overrides file must never
   reach a server build (the planned checked-in-overrides rejection is a
   soundness check, not a courtesy). With those three, the tuple key is
   sound and preferred over laxnew's content-addressed Releases scheme.
3. **Nothing in the plan executes the Actions side before trusting it.**
   Stage 3/4 acceptance was local (`npm run check`, smoke), but the
   deliverable is remote workflow behavior, and this project's hardest
   lesson (history/front-worker-split.md) is that everything written but
   never run was broken. Stages 3 and 4 require a live rehearsal: a
   scratch control repo + scratch database repo where a real
   issue → validation → publish → website-dispatch round trip runs.
4. **CAS-only is the default; the global concurrency group is retracted.**
   Classic Actions concurrency keeps one pending run and cancels older
   pending ones — under a burst, publish jobs would be cancelled after
   successful validation, silently losing work. laxnew's `queue: max` is
   only string-asserted by tests. Use the CAS retry loop alone unless
   real queueing semantics are positively verified.
5. **Ordering: the package-overrides spike moves into stage 2.**
   "Restore old-lax local build" naively means restoring the warm-store
   hardlink farm, which rewrite.md wants dead. The spike's outcome decides
   what stage 2 builds; running it in stage 6 risks building the farm to
   delete it.
6. **Dropping the baked image is an availability trade, sanctioned but
   real.** With the image, a submission needed ghcr up; with
   toolchain-on-VM it needs the elan endpoint, the Lean release CDN, and
   mathlib's cache CDN up and still serving the pinned artifacts, at
   submission time. If that bites, the sanctioned fallback is a warm
   *tarball* (toolchain + mathlib tree) published to ghcr by a small
   trusted workflow — data, not a reviewed executable image; the
   review-surface argument survives, the third-party dependence doesn't.
7. **The real price of forbidding siblings is atomicity.** Waves gave
   all-or-nothing registration; the chain workflow serializes each member
   on a full publication round trip, and a mid-chain failure during
   bottom-up registration leaves earlier members registered forever with
   the top never landed. Name this cost in the eventual design
   (registration ordering, what a stranded half-chain means) instead of
   rediscovering it.
8. Smaller, for the record: the bwrap/AppArmor-on-ubuntu-24.04 claim in
   the Sandbox section is unverified — check it if it ever becomes
   load-bearing. On host-vs-container for Replay/Inspect (analyzed
   2026-08-05): both consume attacker-controlled olean bytes through a
   loader that is not a hardened boundary, and whoever owns the replay
   process owns the verdict — a compromised *containerized* replay lies
   through its report just as effectively, so the placement does not
   change the integrity model. What host-straight actually forgoes is
   defense-in-depth (a partial exploit on the host can rewrite the report
   directly; in a container it must be fully weaponized and lie within
   schema) and per-process resource caps; what it exposes is only a
   read-scoped token, public data, and an ephemeral VM. Since the same
   stock image and container runner exist for Compile anyway,
   containerizing Replay/Inspect costs no new review surface — on that
   basis Jan decided 2026-08-05 to **containerize both** (recorded in the
   Build pipeline section); the analysis stays here so nobody later
   un-containerizes them believing it was a security-critical choice
   rather than a cheap-hardening one. Separately, the single-job
   collapse itself means a docker escape during Compile owns the VM
   before Replay runs, so the Compile container boundary is load-bearing
   for verdict integrity (same posture as old lax's one box); the
   systemic backstop is that records and captures are public and anyone
   can re-run leanchecker offline, so a forged verdict is detectable
   rather than silently permanent. `--resume` must handle the CLI dying before
   it learns whether its command comment posted, so run correlation
   cannot rely on a stored comment id. And the file:line pointers in this
   plan come from exploration-agent reports that were not independently
   re-verified — workers should trust the tree over the plan and invoke
   the deviation rule when they disagree.

## Stage 3 execution notes (2026-08-05, deviation record)

- **Capture tag**: an escaped tuple cannot fit OCI's 128-char/`[A-Za-z0-9._-]`
  tag rules, so the tag is `cap-<commit12>-<sha256(JSON [repo, folder,
  commit, toolchain, mathlibCommit])>` — injective serialization hashed,
  pin included per addendum 2a. The proof|concept axis is not in the key:
  this tree seals one capture per submission covering both subtrees.
- **Ordering**: blob push → manifest+tag → HEAD verify → database CAS
  commit. The tag lands *before* the commit because only a manifest
  reference gives a ghcr blob durable retention; a tag orphaned by a
  failed commit is identifiable garbage, never inconsistency.
- **Immutable-release fail-closed check (stage 4 done-when wording) is
  superseded** with the Releases store itself, per this addendum's point
  2 conclusion: the successor invariants, enforced fail-closed in code,
  are (a) consumers fetch captures only by the digest recorded in the
  database record, never by tag, and (b) the publisher never writes a
  record whose capture digest it did not itself hash, push, and verify.
- **Live rehearsal (point 3) is still owed** for stages 3+4 together:
  scratch-repo creation hit a sandbox permission wall mid-campaign; the
  validate/publish rehearsal must run before any of this is trusted live.
- The cache save in the validate job runs *between* host setup and
  submission-code execution — the post-job save of stock actions/cache
  would let a sandbox escape poison the warm store for later runs.
