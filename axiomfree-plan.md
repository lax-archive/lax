# Axiom-free archive — plan

Status: proposed 2026-10-03 as a program charter; collapsed the same evening
into this stage list after the spike report (`spike/axiomfree/REPORT.md`),
the outside review (`spike/axiomfree/codex-review-20261003.md`), and the
common-sense review (`spike/axiomfree/commonsense-review-20261003.md`).
The shape follows `history/environments-plan.md`: Jan's decisions on top,
stages released to `main` one by one behind the rehearsal gate, this file
retiring to `history/` with the round-trip note. Nothing here edits
spec.md: the spec-2 text is a draft Jan reconciles.

## Decisions (Jan, 2026-10-03; 7–9 confirmed the same evening)

1. Spec version 2 is the rule of the next epoch, `v4.35.0`. `v4.33.0`
   stays spec 1 and closes to new records at the epoch flip. The two
   proof networks never interact, because environments never depend on
   each other.
2. A statement is `@[lax_statement] def X : Prop := …` in a concept
   package; a proof assumes statements as hypotheses, `theorem Q (hA : A)
   : C`; nothing in the archive declares an axiom. "Axiom-free" means no
   axiom beyond the background three (`propext`, `Classical.choice`,
   `Quot.sound`).
3. Proofs carry no `conclusion`/`assumptions` keys; proof-hood is
   structural (a theorem whose type is a chain of statement constants).
4. **The marker is the attribute, and `LaxCore` is one more pinned
   library.** An environment pins its libraries as a set — mathlib, CSLib,
   `LaxCore` — in one table and under one rule; by "one, two, many" a
   third pinned library adds no conceptual complexity once there are two.
   `LaxCore` (`lax-archive/lax-core`) declares the `lax_statement` tag
   attribute with a validation hook; one commit serves every environment
   (it imports only `Lean`); the row pins it like mathlib. Statement-hood
   is declared at the definition site, where a reviewer reads it (Lean
   refuses a tag attribute from another module). The library's
   `initialize laxStatementAttr` declaration name is interface: the
   inspector reads the extension by that name (stage 0 confirmation 2).
   A header-less file exports a tagged `private` definition too, so the
   hook rejects `private` and the inspector re-judges it from the name.
5. The judge is the toolchain's `lake comparator`, frozen with the
   environment. The certificate bundle is independent of which kernels
   ran: production runs the kernel set the environment's setting names
   (Lean's kernel alone to start), the record notes which ran, and a later
   run with more kernels is the same command on the same bundle, published
   as a new attestation beside the old one. Memory scales with that list,
   not with the archive.
6. Replay stays. The comparator is added beside it, never instead of it:
   Replay is what makes the whole-package axiom walk kernel-grade, and the
   comparator replays only the named edges' cones.
7. Spec-2 files keep spec-1 style: ordinary `import`, no
   `module` header, no `public`/`@[expose]`. The spike showed a header-less
   file builds against the v4.35 mathlib and sees everything; the module
   system would have dragged in visibility rules, capture sidecars, and a
   conflict with the concept dialect.
8. Per-record certification only, for now. Records and
   environments are immutable and the judge is frozen, so a scheduled rerun
   of the same evidence yields nothing new; a whole-environment bundle is
   a concatenation of per-record bundles when someone asks. With
   per-record Challenges a submission imports only the concept packages it
   chose to depend on, so "concept authors you depend on are trusted, as
   today" is the honest wording and the concept dialect stays its own
   project.
9. Stages ship to `main` one by one behind `npm run check` and
   the rehearsal gate, as the environments work did. The `axiomfree`
   branch exists only while a stage is unreleasable on its own.

## Design

### Content rules (spec 2)

Concept package. A **statement** is a definition-kind declaration carrying
`@[lax_statement]` whose stored type is literally `Sort 0` (raw
`Expr.sort .zero`, metadata stripped, no reduction), with no binders
(parameters go inside with `∀`) and no `private`. Universe parameters are
allowed. A `Prop`-valued definition without the marker is an auxiliary:
ordinary content, never an edge endpoint. The attribute's hook in
`LaxCore` rejects a non-definition, a non-`Sort 0` type, binders, and
`private` at the author's elaboration with a clear message; the validator
re-judges every rule from the inspector's facts and never trusts the hook.
The marker in a proof package is a violation. `def AimpC : Prop := A → C`
is a statement like any other; a proof of it is the edge `{} → AimpC`.

Proof package. A **proof** is a theorem-kind declaration whose stored type,
metadata stripped, is a chain of zero or more `forallE` nodes ending in a
`const`, where every domain and the conclusion are `const` expressions
naming statements of a concept package the proof package requires, or of
its own concept package (transitive reachability does not qualify, as in
spec 1). Binder info is irrelevant to proof-hood and is recorded so the
generator applies the proof with `@`. Edge `{S₁..Sₖ} → C`; duplicates
collapse in the graph but keep their positions in the telescope; `k = 0`
is unconditional; a self-edge grounds nothing. **Universe rule**: every
statement constant in the chain is instantiated with the proof's own
universe variables, never a concrete level, and the conclusion's level
arguments are pairwise distinct (a proof of `C.{u,u}` proves a special
case, not `C`); hypotheses may repeat a variable. Every edge is then
universally quantified over universes and name-only composition is sound;
the generated Challenge theorem copies the proof's level parameters. Anything
else of theorem kind is a helper; a helper carrying docstring frontmatter
is a violation (a spec-1 habit must fail loudly). Unused hypotheses are
assumptions; section variables the elaborator dropped are not binders.

Hygiene, both packages. The `axiom` declaration kind is a violation. The
axiom set of every declaration is a subset of the background three:
`sorryAx` and the native-computation axioms are not background. This is
the existing walk (`phases/inspect.ts`) with the "statements of required
packages" branch deleted, run over Replay-authenticated oleans as today.

### Environment libraries

`environments.ts` rows gain `specVersion: 1 | 2` and, for spec-2 rows,
`libraries`: the pinned set `{ mathlib (required), CSLib (allowed), LaxCore
(required) }`, each a repository URL from `pins.ts` plus the commit the
row pins. The warm workspace (`host/warmstore.ts`) requires the whole set,
so provisioning, package overrides, and the seeded manifest cover the
three libraries with the mechanism that covers mathlib today. The
lakefile validator's mathlib rule ("the package must require it directly,
at the pinned repository and revision, no `subDir`") becomes the
libraries rule, keyed by the table: required libraries must be required,
allowed ones may be, every other git require is a submission. The
manifest's `specVersion` is the string `"1"` or `"2"` and must equal the
row's; the archive JSON schemas keep their own `specVersion: "1"` —
content spec and archive schema are different versions and this program
bumps only the former. `environments.json` on the website carries
`specVersion`.

### Inspector

Core-only as today, no `initialize` block. It reads `LaxCore`'s attribute
as data: the exported entries of the tag attribute's persistent extension,
looked up by the extension's name in each module's `ModuleData.entries`.
Per declaration it adds `laxStatement`, `isProp` (raw `Sort 0`),
`levelParams`, and `telescope` (ordered binders, each the constant name,
its level instantiation, and binder info; the conclusion constant; or
`null`), plus the pretty-printed body of every tagged definition for the
website. Environment reads only, no kernel work. One inspector source for
both specs; the invocation passes the spec version; the golden fixture
gains a spec-2 case. `build-output.json` proof entries gain `telescope`;
`conclusion` and `assumptions` are derived from it so lax-website and
`selectProofTree` keep working; concept `statements` list the tagged
definitions.

### Certify

A fourth phase after Compile, Replay, Inspect, in spec-2 rows, in the
existing docker runner with the existing mounts and limits:

1. lax generates, from the telescopes and canonical names (every name
   emitted escaped from a `Lean.Name`, never interpolated from a reported
   string): `lakefile.toml` (the libraries at the row's pins; every concept
   and proof package involved at the record's source triple, or the
   submission's own capture per submit), `lake-manifest.json` (the sandboxed
   comparator refuses a project without one), `Challenge.lean` (imports
   concept modules only; per edge `theorem Cert.<proof-id>.{us} (h₁ : S₁)
   … : C := sorry` with the proof's level parameters), `Solution.lean`
   (imports proof modules; bodies `@<proof>.{us} h₁ … hₖ` in the proof's
   own binder order), `comparator.json` (`theorem_names`,
   `definition_names = []` always, `permitted_axioms` = the background
   three). Zero edges: nothing runs, the record says "no edges".
2. Container A mounts the concept captures and the warm store read-only,
   never the proof package, builds the Challenge and exports it with
   `leanexport` to `challenge.export`.
3. Container B mounts `challenge.export` **read-only** beside the proof
   capture and runs `lake comparator --challenge-from-export
   challenge.export --inadvisably-no-sandbox`, with the kernel set the
   environment's setting names (`--paranoid` or a named subset; Lean's
   kernel alone to start). Exit 0 is the verdict; exit 1 is a violation
   reported by edge; exit 2 is a pipeline failure. A compile error in the
   Solution is also exit 1 and is told apart by phase. The build cannot
   touch the Challenge export or the toolchain, which is the whole of the
   "judge shares nothing with the build" requirement; a third clean
   container comparing both `--*-from-export` files is the belt-and-braces
   variant and is how a published bundle is rerun anyway.
4. The five generated files are pushed to the capture store
   (`capture-store.ts`, digest-addressed, before the database commit that
   references them); `build-output.json` records the bundle digest, the
   kernels that ran, and the generated `Challenge.lean` source verbatim
   (a few KB): it is the one artifact that names, in Lean, exactly what
   was certified, so the website can show it without fetching anything.

Local `lax build` runs the same phase through the same runner.

### CLI, authoring, website

`lax certify <proof|statement|lax-N> [--relative-to …] [--run
[--paranoid]]`: regenerate the bundle from the database (the telescopes in
`build-output.json`) or fetch it by digest, print or run the comparator
command; a relative certificate for an implied edge composes Solution
bodies by application along `selectProofTree`'s witness forest, and the
comparator's rejection of an ill-typed composition is the test that the
composition rule is right. `lax doctor` reports the toolchain's bundled
kernels. `lax init` scaffolds spec-2 rows (`@[lax_statement] def`
statement, hypothesis proof, the three library requires);
`assets/instructions.md` gains the spec-2 section with the
`variable`/`include` recipe (a third of live proofs are conditional, some
with 28 assumptions — the recipe gets a real trial in stage 6);
`lax port` stays a guided, agent-edited port. The website reads
`specVersion`, shows the telescope on proof cards, marks a record
"certified: `lake comparator` (<toolchain>, <kernels>), bundle <digest>"
from `build-output.json`, shows the record's `Challenge.lean` collapsed
under the proof network beside the bundle digest and the rerun command
(Jan, 2026-10-03: the Challenge is what makes the mark checkable by a
reader), and states per spec-2 environment that the concept packages a
record depends on are trusted as today.

## Stages

0. **Spike — done 2026-10-03**, confirmations landed the same evening
   (`spike/axiomfree/REPORT.md`, "Stage 0 confirmations"): header-less
   Challenge/Solution pairs pass and the unfolded negative fails (8.5 s);
   a core-only reader lists the tagged names from `ModuleData.entries`
   with the inspector's own `importModules … (loadExts := false)` call.
   Facts: the extension is named after the `initialize` declaration
   (`LaxCore.laxStatementAttr`); a `module` file cannot import a
   header-less library, so `LaxCore` is header-less like every spec-2
   package; Lake's bwrap sandbox sees only the project directory, the
   sysroot, and Lake's home, so a sandboxed `lax certify --run` needs git
   requires or in-project path requires, never `~/.lax/warm`.
1. **Libraries and the table.** `lax-archive/lax-core` (one module, the
   attribute with its hook, an example file whose negatives fail with the
   intended messages, CI under the toolchain); `pins.ts` URLs for CSLib
   and LaxCore; `specVersion` and `libraries` on the rows and in the warm
   workspace; the libraries rule in the lakefile validator; a fixture
   LaxCore and a spec-2 fake environment in the fake-mathlib e2e under
   the v4.35 toolchain (CI gains the toolchain as the admission did). No
   author-visible change. Release. **Landed 2026-10-03** (code; the
   `lax-archive/lax-core` push and the release are Jan's). Deviations: a
   spec-2 row carries `libraries` only and `environments()` derives its
   `mathlibCommit` from the set (one pin written once; every existing
   reader keeps its shape); the import rule (`phases/inspect.ts`) admits a
   required library's root module, so a spec-2 package can `import
   LaxCore` already; the rehearsal toolchain is `v4.35.0-rc3` in a CI
   cache of its own, not in the shared host store.
2. **Inspector and validator.** The four inspector fields and the tag
   reading; spec-2 classification with a table test over the cases above
   (explicit/implicit/instance binders, duplicates, self-edge, concrete
   universe level, `AimpC`, parameterised def with the marker, marker in a
   proof package, frontmatter on a helper, unused `axiom`, sorry through a
   helper); the walk with the background-only set; `telescope` in
   `build-output.json`; spec-1 goldens byte-identical. Release. **Landed
   2026-10-03** (code; the release is Jan's). Deviations: the inspector
   takes `--spec <1|2>` and emits the four facts only under `--spec 2`
   (the report shape is unversioned, so gating keeps the spec-1 golden
   byte-identical rather than regenerating it); a tagged declaration also
   reports `binders` (leading `∀` count) and `signature`, so the "takes
   binders — quantify inside" finding needs no second walk; the spec-2
   golden (`test/fixtures/inspector-golden-spec2/`) runs over a hook-less
   twin of LaxCore so the shapes the real hook refuses are facts in the
   report; the e2e negative is a private proof-shaped theorem plus a
   concrete universe level (both fail in Inspect) and the tagged private
   def is shown to die in Compile under the real hook — the transitively
   reachable statement has its table-test case and awaits stage 3's
   multi-record rehearsal for an e2e; the trusted artifact parser
   (`artifact-schema.ts`) now holds a manifest's `specVersion` to its
   environment row's and a spec-2 record's entries to the telescope
   shape, which stage 1 had left at `"1"`.
3. **Certify.** The generator (golden files), the two-container layout in
   the runner, the capture-store push, the digest in `build-output.json`,
   the same path in local `lax build`; negative bundles that must fail *in
   the comparator* (weakened conclusion, sorry, extra hypothesis, shadowed
   statement, definition as Solution target, ill-typed composition), each
   asserting the phase so a fixture that dies in elaboration is noticed; a
   test that `certificate` edges and generated Challenge theorems are the
   same list. Docker smoke in the spec-2 fake environment; scratch-repo
   rehearsal (`scripts/rehearsal/`). Release.
4. **CLI.** `lax certify` with relative certificates, `lax doctor`,
   `lax init --env` for spec-2 rows, the instructions section. Release.
5. **Website.** `specVersion` plumbing, telescopes on proof cards, the
   certified mark with the collapsed Challenge, the trust note. Renderer
   release; re-pin.
6. **Rollout and docs.** Admit `v4.35.0` at spec 2 once the mathlib tag
   exists (CSLib and LaxCore commits chosen against it; the admission
   checklist in `history/environments-plan.md` gains the two libraries);
   make it the epoch; close `v4.33.0`; hand-port Lax17 first (27
   polymorphic statements and the heaviest hypothesis threading — the
   trial for the universe rule, the recipe, and the real cone cost, which
   sets the kernel setting); production round trip of a two-submission
   chain with a conditional proof, its bundle rerun with `--paranoid` on a
   machine that never ran lax; `spec_v2_draft.md` (agent drafts alongside
   stages 2–3, Jan reconciles), README, history note; this plan retires.

Stages 1 to 3 are the feature; 4 and 5 make it usable; 6 closes it.

## Verification

- Table test for the classification rules; golden files for the generator;
  the edges-equal-theorems test.
- Fake-mathlib e2e with a spec-2 environment and a fixture LaxCore;
  spec-1 golden fixtures byte-for-byte on every change to shared code.
- Every bundle test has a sibling that must fail in the comparator, with
  the phase asserted.
- Docker smoke; scratch-repo rehearsal before any Actions-side change;
  the never-ran-lax rerun as stage 6's gate.

## Risks and accepted trade-offs

- **Cone cost is unmeasured at Lax17 size.** Per-submit cost is the named
  edges' mathlib cones (3k–30k declarations measured: 2–66 s per kernel,
  11–185 MB exports), not the package. Lean's kernel alone per submit;
  more kernels when the Lax17 port says they fit (decision 5).
- **`LaxCore` in the trust base.** One module, reviewed, pinned by commit;
  the validator never trusts its hook.
- **Concept authors you depend on are trusted** (decision 8). Stated on
  the website. The concept dialect, if it ever lands, tightens this
  without changing a data shape.
- **The judge is frozen with the environment.** Evidence stays; if a
  comparator bug is ever found, the mark can be qualified and the bundle
  rerun with later tooling as a new attestation. Built when it happens.
- **Two specs in one codebase.** Branch at the libraries rule, the
  classification, the walk's allowed set, and Certify; goldens both ways;
  `v4.33.0` closes at the flip.
- **`v4.35.0` final slips.** Rehearse on the release candidate; admission
  is a row plus two library commits.

## Deferred (not in this program; none changes a data shape)

The scheduled whole-environment run and its verdict document; the concept
gate as a prerequisite; the module system; a randomised module prefix;
`--paranoid` per submit as policy; a `lax port` rewriter; a proof marker
(`@[lax_proof]`); advisory/suspension machinery; the helper-unfolds-to-a-
statement hint (added when a port shows the need).

## Decisions taken while drafting the spec (2026-10-03, evening; Jan may veto)

The draft (`spec_v2_draft.md`, 18 `> draft note:` blocks) found the plan
silent on these; the answers below are the ones the draft and the stages
now follow.

- **Local `lax build` runs Certify on the host without a sandbox.**
  Local builds never use docker today, the code is the author's own, and
  under Lake's bwrap sandbox the warm store is invisible. The local run is
  informational, says so, and is never reused by `lax submit`; the
  archive's per-submit run is the one that counts.
- **Both packages require `LaxCore`**, as both require mathlib today: lake
  flattens the workspace, so a proof package importing a tagged concept
  needs the library resolvable anyway. `lax init` scaffolds mathlib and
  `LaxCore`; CSLib is added by the author when needed (open decision 1
  stays "allowed").
- **A statement of a package that is only transitively reachable** in a
  proof's chain is a violation, as the spec-1 axiom-hygiene rule was —
  never a silent helper. A `private` theorem of proof shape is a violation
  with a hint. Frontmatter anywhere in the proof package, empty or not, is
  a violation.
- **Later attestations** (more kernels, later tooling) are written by
  `/lax admin revalidate`, which rewrites `build-output.json`; "beside the
  old one" means the old attestation stays in the database's git history.
- **Certify's timeout** shares Replay's limit until the Lax17 port measures
  the cone; then it becomes a limits-table value.
- `lax print spec --env <id>` prints the spec that governs that
  environment.

## Record shape for spec 2 (from the build-output investigation, 2026-10-03)

`spike/axiomfree/build-output-investigation-20261003.md` measured the live
database: `capture.files`, the per-file manifest of the sealed build, is
55% of all `build-output.json` bytes and is read by nobody except the
website, which addresses 0.2% of its entries. Folded into stages 3 and 5,
for spec-2 records only (spec-1 records keep their shape until ported):

- `capture` loses `files`, `leanToolchain`, and `mathlibCommit`; it gains
  `fileCount` and a `references` layer (concept sources and their `.ilean`
  files) beside the capture tar, which the website downloads whole and
  verifies by digest instead of reconstructing tar offsets. Modelled
  effect: 13.4 MB → 5.9 MB over today's corpus.
- Proof entries store the telescope only; `conclusion` and `assumptions`
  are derived by every reader at load, never stored.
- `certificate` is `{ judge, kernels, bundle: { formatVersion, digest,
  registryBlob }, challengeExportSha256, challenge }` with the Challenge
  verbatim and no stored edge list: the publisher regenerates the
  Challenge from the stored data and requires byte equality. Absent on a
  record with no proofs. The bundle is a further layer of the record's
  capture manifest.
- Duplicates of the environment row and of the manifest are dropped.
  `sourceText` and the parsed annotations stay in the record: every
  concept page and `lax serve` need them without a fetch.
- Later, after the port: delete the spec-1 reader branches; unify the two
  `rendererOutput` copies (lax-website `database.ts`, lax `cli/website.ts`).

## Open decisions

1. **CSLib: allowed or required?** Assumed allowed (a submission that does
   not need it should not carry it); mathlib and LaxCore required.
2. **Kernel set per submit** (decision 5's setting): Lean's kernel alone
   until the Lax17 port measures the full set.
3. **`lax certify --run` before `lax register`**: author tool, not a gate;
   registration already rests on the per-submit judge.

## Record

The charter version of this file (574 lines, 2026-10-03) is in git history
once committed; the two reviews are beside the spike report. What the
reviews changed: universe monomorphism dropped for the level-variable rule
(115 of 808 live statements are polymorphic); `lake check` dropped (it
exports the whole mathlib closure, 714 MB and a 17 GB kernel run on a
two-theorem project); Replay kept; the VM-with-bubblewrap option dropped
for the read-only-export layout inside the existing docker sandbox; the
module system dropped; the scheduled run, verdict format, concept gate,
integration branch, per-workstream plan files, and governance section
dropped or deferred.
