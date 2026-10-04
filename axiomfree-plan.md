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
   comparator replays only the named edges' cones. *Re-read under
   decision 10 (2026-10-04): Replay is a standards hardening, not a
   correctness input; see there for what stays.*
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
10. **Division of intents** (Jan, 2026-10-04, after the Palomar
    comparison and the redundancy walk; confirmed the same day with all
    three open calls: proof Replay dropped, private declarations exempt,
    whole-package axiom-free a hard standard). The pipeline has three
    pieces with three questions, and no piece answers another's:
    - *The judge* — containers A, B, C and `lake comparator` — answers
      **correctness of the Lean theorem**: the Solution theorem has
      exactly the Challenge's type and the kernel accepts its proof. It is
      the sole source of edge soundness. Nothing else in the pipeline
      contributes to that answer and nothing else may claim to.
    - *The edge translation* — the trusted TypeScript that turns a
      telescope reading into Challenge and Solution (`certify/generate.ts`
      and the spec-2 branch of judge inspection) — answers **the theorem
      is the edge**: every constant names a registered statement of a
      package the record requires, the universe rule holds, and the edge
      list the record carries is exactly what is rendered. This is
      correctness-critical, because the judge verifies whatever Challenge
      it is handed: a `C.{u,u}` conclusion passed through would be judged
      correctly and recorded wrongly. These rules are not style and are
      never relaxed. The record stores `Challenge.lean` verbatim and the
      website shows it, so a reader checks with their own eyes that the
      theorem states the edge they care about. That audit covers the
      visible implication and its universes; it does not by itself
      establish what the imported constants mean or that the published
      verdict belongs to those bytes — that is the fourth piece.
    - *Provenance and binding* (named by the Codex intents review,
      `spike/axiomfree/codex-review-intents-20261004.md`, finding 2):
      the judge establishes a property of two export files under a
      configuration. That the Challenge export is the published Challenge
      built against the concept definitions the record identifies, that
      the library artifacts are the recorded pins, and that the verdict
      is attributed to this record, rests on capture production,
      dependency resolution, the warm store, the export handling, the
      publisher's regeneration, and the database. This piece is
      correctness-critical and it is where the trust in concept authors
      (decision 8), the submission's own concept package included, and in
      the pins actually lives. The defensible sentence is therefore: *the
      judge is the sole proof-validity checker for certified edges;
      archive edge soundness additionally requires faithful translation,
      authentic Challenge inputs, and correct binding of the verdict to
      the published record.* Palomar states the same split. *Fable
      review the same day* (`spike/axiomfree/fable-review-intents-20261004.md`):
      the judge's answer still rested on one standards rule — container A
      ran `lake build Challenge` (every closure concept package's
      initializers), `leanexport`, and the inspector in one container
      with `/out` writable throughout, so a concept initializer could
      leave a process behind that rewrites the export or the telescope
      report after they are written; only the no-`initialize` rule stood
      in the way. Fixed by splitting build from export: A1/B1 build in a
      writable tree, A2/B2 are fresh containers that mount that tree
      read-only and run only `leanexport` and the inspector (both import
      with `loadExts := false`, so nothing of a record executes there),
      writing to the one `/out`. Five docker runs per certification.
      Palomar's wording: each export is a verifier-owned file no
      candidate phase can write to. *Second Codex review the same day*
      (`spike/axiomfree/codex-review-intents-2-20261004.md`, with every
      earlier report in hand): the canonical-name fix exempted
      internal-looking names, and Lean's `isInternalDetail` is a
      heuristic (`proof_1`, `eq_1`, `match_1`, `omega_1`, any `_`
      prefix), so an authored `C.«A.B».proof_1` still flattens, escapes
      the namespace rule, and can be tagged; the rule is therefore:
      endpoints (statements, proofs, telescope constants) must be
      user-level *and* canonical, and ownership is enforced for every
      persisted declaration with provenance-based exemptions only
      (reserved theorem realizations, the package's own private and
      macro-scoped names). Three more: a *revalidation* of a concept
      record can change a statement's body (compile-time code with a
      date threshold) while dependents keep certificates judged against
      the old capture — certified dependency identities must include
      capture digests and revalidation must refuse or invalidate; `lax
      certify --run` reuses `.lake`, so a proof build's compile-time IO
      can alter the concept checkout for the next run — the reader tool
      needs the archive's separation of inputs and execution; and the
      inspector reads bodies from the merged environment, so two
      same-name theorems in two modules hide one body from the hygiene
      walk — inspect per-module `ConstantInfo`. Decision 10 stands; what
      the reviews keep finding is in the translation and binding pieces,
      never in the judge, which is the division doing its job.
    - *The inspector and its TypeScript rules* answer **conformity with
      archive standards**: what the archive requires because it wants its
      records a certain way, enforced whether or not correctness needs
      it. Compositionality through the namespace rule; axiom-free and
      sorry-free across the whole package (a helper with `sorry` that no
      edge uses is harmless to the graph and misleading to a reader, so it
      stays a hard standard); the frontmatter rules, the unused-lemma
      warning, the import rule, root-module exactness, docstrings.
      Rejections, all of them, labelled as standards.

    Consequences:
    - *Replay is a standards decision.* Its job was to make the
      inspector's facts forgery-proof; under the division those are
      standards facts, and anything that reaches an edge's cone is
      re-checked by the judge. Replay becomes "the archive's published
      packages are kernel-consistent as a whole". Decided: kept for
      concept packages (every later record imports them; the archive
      presents them as the statement surface a reader trusts), dropped
      for spec-2 proof packages (leaves; the judge covers their edges, and
      a downstream judge re-checks any helper a later proof reaches). No
      standards check consumes Replay's output — Replay is a gate that
      returns nothing and Inspect reads the oleans directly — so the
      exact loss is one case: a dead helper in a hostile package can claim
      a body that does not type-check and the standards check believes
      it. One leanchecker run per proof package saved.
    - *The namespace rule is the composition rule.* Lean's `finalizeImport`
      (v4.35, `subsumesInfo`) refuses two modules declaring the same
      constant unless both are theorems of identical name, type, and level
      parameters. So: private declarations cannot clash (module-mangled;
      modules are unique per record) and are exempt from the prefix test;
      compiler-realized reserved theorems (`congr_simp`, `eq_def`, match
      splitters) clash harmlessly and stay exempt — that exemption is the
      composition rule applied, not a whitelist, and it grows only with
      Lean's reserved-name set per version; everything else carries the
      record's prefix, the only *local* condition that guarantees
      composition with records that do not exist yet. A global
      first-come-first-served name registry was considered and rejected
      (non-local validity, unforeseeable rejections, exceptions for
      revalidation and successors). *Fresh-mind review the same day*
      (`spike/axiomfree/namespace-review-20261004.md`, ~15 cases verified
      on rc3): the prefix rule is sufficient for every *declared*
      constant, and three things names cannot see were missed — (B2) the
      reserved-name exemption admits a realized **definition** under an
      imported name (`<enum>.enumToBitVec` from the `bv_decide`
      normalizer), which Lean refuses to co-import, so the exemption is
      theorem-kind only; (F1) `initialize` and its sugar register
      name-keyed global extensions that clash at import, so records
      declare none; (E1) a **global** `syntax`/`macro_rules`/`elab`
      rewrites every importer, the generated Challenge included — a
      concept-package macro turns `theorem Cert.p : 1 = 2 := sorry` into
      `Cert.p : True`, axiom-free, and both exports agree — so every
      syntax extension and attribute application in a record is `scoped`
      or `local`. E1 is a *provenance* hole, not a style one, and the
      rule alone is not the defence: the trusted Certify phase holds the
      exported Challenge's theorem types to the recorded telescopes
      (constants, level instances, level parameters), which is also the
      independent structural check the Codex intents review asked for.
    - *Names must round-trip.* The spec-2 inspector flattens names with
      `Name.toString (escape := false)` and the generator splits on dots,
      which is not injective (`Lax1.C.«A.B»` vs `Lax1.C.A.B`); with the
      silent de-duplication in `uniqueDeclarations` a record could tag one
      and prove the other (Codex intents review, finding 1). Fixed at the
      boundary as a translation rule: a non-internal name whose components
      do not round-trip is a violation, and a duplicated reported name is
      a violation unless both are theorems.
    - *Findings carry their intent.* The report artifact and the issue
      comment say whether a rejection came from the judge, the
      translation, or the standards: three different instructions to an
      author (your proof is wrong; your theorem is not the edge you think;
      your package does not meet the house rules).
    - *The inspector's reading stays where it is*: over Compile's capture,
      `loadExts := false`, never inside container B; its output is the
      author's claim plus standards facts.
    - *Spec text.* `spec_v2_draft.md`'s hygiene paragraph states the
      whole-package rule as an archive standard beside the sentence that
      edge correctness comes from the judge alone; the spec-1 trust-chain
      paragraph (kernel-grade vs metadata-grade facts) does not carry over
      to spec 2. Spec-notes entry for the private exemption, since spec.md
      un-mangles private names before the test.

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
spec 1). Binder names and kinds are irrelevant to proof-hood, are not part
of an edge, and are not recorded: the generator states every hypothesis as
`(hᵢ : Sᵢ)` and applies the proof with `@`. Edge `{S₁..Sₖ} → C`; duplicates
collapse in the graph but keep their positions in the telescope; `k = 0`
is unconditional; a self-edge grounds nothing. **Universe rule**: every
statement constant in the chain is instantiated with the proof's own
universe variables, never a concrete level, and the conclusion's level
arguments are pairwise distinct (a proof of `C.{u,u}` proves a special
case, not `C`); hypotheses may repeat a variable. Every edge is then
universally quantified over universes and name-only composition is sound;
the generated Challenge theorem copies the proof's level parameters. Anything
else of theorem kind is a helper, and so is a theorem Lean generated
(origin `auxiliary` or `realized`, or `private` with a parent: an
abstracted `f._proof_1 : A → C`, under a `private def` too, an equation
lemma) whatever its shape — the endpoint gate excludes it; only a `scoped`
or unreported origin of proof shape is refused, honest hygienic macros
included (a macro names a proof with `mkIdent`) (ultracode review
2026-10-04, I1). A helper carrying docstring frontmatter
is a violation (a spec-1 habit must fail loudly). Unused hypotheses are
assumptions; section variables the elaborator dropped are not binders.

Hygiene, both packages. The `axiom` declaration kind is a violation. The
axiom set of every declaration is a subset of the background three:
`sorryAx` and the native-computation axioms are not background. This is
the existing walk (`phases/inspect.ts`) with the "statements of required
packages" branch deleted, run over Replay-authenticated oleans as today.
Under decision 10 this is an archive standard, not a correctness input:
edge correctness comes from the judge alone.

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
`levelParams`, and `telescope` (ordered binders, each the constant name
and its level instantiation; the conclusion constant; or
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
3. *(As executed after the stages 1–3 review, 2026-10-04; the original
   two-container step is in git history.)* Container B mounts the proof
   capture and the whole project, builds the Solution and exports it with
   the same `leanexport` rule to `solution.export`; it is the only
   container that executes proof-package code and is torn down first.
   Container C, the judge, is a fresh container with the bundle's five
   files and both exports read-only, the toolchain, a read-only `git`
   shim, and nothing writable but `/out`; it runs `lake comparator
   --challenge-from-export --solution-from-export --inadvisably-no-sandbox
   [--paranoid]`, which builds and resolves nothing. The host records both
   export digests. Exit 0 is the verdict; the comparator's own rejection
   diagnostics are violations reported by edge; a kernel that failed to
   run, a launch failure, or an unexplained stop is an infrastructure
   failure, never a finding against the author (Codex intents review,
   finding 6); exit 2 is a pipeline failure.
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
   rehearsal (`scripts/rehearsal/`). Release. **Landed 2026-10-03** (code:
   `src/submission-validation/certify/` — `generate.ts`, `lean-name.ts`,
   `bundle.ts`, `project.ts`, `phase.ts`, `host.ts`, `verdict.ts` — plus
   `sandbox/tools/run-certify.mjs` and `recorded-shape.ts`; the docker
   smoke's `spec2-certify` case ran the same night against the real
   mathlib at rc3 and passed after one fix — docker mounts `--tmpfs` with
   `noexec`, so the comparator's `git` shim moved from /tmp to the
   project's writable `.lake` mount; container B certifies in 6.7 s — the
   scratch-repo rehearsal and the release are Jan's). Deviations: the record
   shapes follow the build-output investigation
   (`spike/axiomfree/build-output-investigation-20261003.md`) rather than
   this plan's point 4 — `certificate` is `{ judge, kernels, bundle,
   challengeExportSha256, challenge }` with **no edge list** (the trusted
   parser regenerates `Challenge.lean` from the stored telescopes and
   requires byte equality), the key is **absent** for a record without
   proofs, the bundle is a **further layer of the record's OCI capture
   manifest** (not a separate artifact), and a spec-2 record stores no
   field a reader derives (`recorded-shape.ts`: no `conclusion`/
   `assumptions`, no capture pins, no `inputs.manifest.id`, no
   `paper.folder/main/engine`, and — the investigation's first point, a
   second commit — no `capture.files`: the capture carries `bytes`,
   `fileCount` and a `references` layer of the concept sources and
   `.ilean` files, and every consumer verifies the tar by digest and
   holds the extracted tree to the count); the Challenge imports the **root modules**
   of the concept packages the edges name (a statement's module is not
   recorded, and a root imports exactly its package); container A builds a
   lakefile that is the bundle's minus the proof require (lake loads every
   required package, so the bundle's own lakefile cannot run without the
   proof package), while B runs the bundle's lakefile with a path-entry
   manifest exactly as a submission build is provisioned; `lake comparator`
   probes PATH for `git` even unsandboxed and the stock image has none, so
   the in-container tool puts a failing shim first on the comparator's
   PATH; local `lax build` runs the same A/B split on the host (export,
   then `--challenge-from-export`), with path requires symlinked under the
   generated project, so its bundle digest is local; the kernel set is
   `certificationKernels` in the limits table (`"lean"` | `"paranoid"`, a
   row override), the phase shares Replay's timeout; the
   sorry-through-a-helper negative dies in Inspect (the axiom walk sees
   `sorryAx` on the helper), so the comparator's own refusals are driven
   over the real comparator against hand-edited Solutions in the e2e, and
   the two-container layout is rehearsed on the host with the real tool
   script (docker is still owed). **Hardened 2026-10-04** after the outside
   review (`spike/axiomfree/codex-review-stages1-3-20261003.md`), one
   sentence per finding: (1) three containers — A exports the Challenge, B
   builds and exports the Solution (`lake build Solution` then the same
   `leanexport` rule as A), and C, a fresh container with the bundle's five
   files read-only, both exports as single read-only file binds, the
   toolchain and tools alone (`runtime: "judge"`, no warm store), a
   host-written read-only `git` shim first on PATH and nothing writable but
   `/out`, runs `lake comparator --challenge-from-export --solution-from-export
   --inadvisably-no-sandbox`, which with both exports builds and resolves
   nothing (pinned `Check.lean runComparator`), so no code the proof package
   runs shares a filesystem with the kernels; `certificate` gains
   `solutionExportSha256` beside `challengeExportSha256`, both the host's
   digests of the files C read. (2) The publisher regenerates the whole
   bundle from the record — telescopes, the record's and the dependencies'
   source triples, the row's library pins — re-seals it and holds the
   published tar to it byte for byte and to `certificate.bundle.digest`
   (`certify/verify-bundle.ts`), binds `kernels` to the row's
   `certificationKernels`, and documents the two export digests as
   host-recorded provenance a rerun compares; the warm closure's manifest
   entries are the one input it holds to shape and pins instead of
   regenerating (TODO.md). (3) The proof-tree composer writes a per-file
   sha256 inventory beside an extracted spec-2 capture at download and
   verifies every file against it on reuse (spec 1 keeps its recorded
   inventory). (4) One name representation: a spec-2 inspector report writes
   every name with `Name.toString (escape := false)` (spec-1 reports
   byte-identical), the generator quotes conservatively with `«»` and refuses
   (`certify` violation `name`) a component that cannot be quoted — empty,
   `_`, a guillemet, whitespace, a control character — and the names handed
   to `leanexport` and `comparator.json` are quoted too, since both read
   Lean's name syntax (found by the e2e: `Syntax.decodeNameLit` panics on a
   bare `证明`); the e2e proves `«定理».{«λ»}`/`«证明»` from Inspect through
   elaboration to the comparator, and a generator golden is derived from the
   real inspector report. (5) Metadata-only resubmission goes through
   `recordedBuildOutput` (`metadataCandidate`) on both the classifier and
   the publisher, and the stored keys admit `certificate`, so a spec-2
   record takes the fast path. (6) `planCertificate` accepts local package
   sources (`record.local`: the sibling closure and the proof package's
   direct path requires) and marks the plan `local`, with path requires in
   the bundle; a nonstrict sibling statement certifies in the e2e. (7)
   Container A (and B) mount only the closure's own subtrees under `/deps`,
   never a dependency's other package. Later items taken: `readBundle`
   validates magic, checksums, member types, unique names, termination and
   trailing data; the `references` layer's members are in byte order;
   `runToFile` closes its descriptor once and takes a timeout, which the
   host certificate passes. Deferred: the archive-reader consolidation and
   the warm-manifest pin (TODO.md).
4. **CLI.** `lax certify` with relative certificates, `lax doctor`,
   `lax init --env` for spec-2 rows, the instructions section. Release.
   **Landed 2026-10-04** (code: `src/cli/certify.ts`,
   `certify/compose.ts`, the generalised `theoremText` in
   `certify/generate.ts`; the release is Jan's). Deviations: a record
   target **regenerates by default** and fetches with `--fetch` (the
   draft left it open), and the bundle goes to `./certificate-<target>`
   rather than under `~/.lax/certificates/` (that directory is the fetch
   cache); the relative theorem is `Cert.<statement-id>` as the draft
   spelled it, with `_root_.` on every reference and the given statements
   as explicit hypotheses in `--relative-to` order, each at the one
   universe instance the composition demands (two instances, or an unused
   polymorphic given, are refused rather than guessed, as is a witness
   with a universe parameter its conclusion does not determine); the
   regenerated `lake-manifest.json` comes from the **local** warm
   workspace's locked manifest, so regeneration needs the environment
   provisioned (`lax doctor --env`) while `--fetch` does not, and the
   regenerated digest is reported against the record's rather than
   required to match (only the Challenge must); `--run` is the plain
   `lake comparator --config comparator.json` in the folder, sandboxed,
   with git and `bwrap` checked first and no unsandboxed mode; `lax
   doctor` shows the comparator, the sandbox, and the kernel rows only
   for a spec-2 environment (a spec-1 toolchain bundles none, and the
   epoch's report must not gain five notes); the spec-2 scaffold declares
   **two** statements, one proven outright and one from the other,
   because a hypothesis-style proof over a single statement is a
   self-edge; `lax print spec --env` prints `spec_v2_draft.md` for a
   spec-2 row with a one-line banner on stderr, stdout staying the
   document; `lax port --env <spec-2>` adds the row's required library
   requires and `import LaxCore` to the statement-declaring modules and
   prints the `@[lax_statement] def` per statement (binders or universe
   parameters get a note instead), proofs untouched. The e2e judges the
   written bundles with the real comparator unsandboxed first (the fixture
   repositories are local paths bubblewrap cannot clone) and then runs
   the CLI's sandboxed `--run` over the materialised folder.
5. **Website.** `specVersion` plumbing, telescopes on proof cards, the
   certified mark with the collapsed Challenge, the trust note. Renderer
   release; re-pin. **Landed 2026-10-04** on lax-website branch
   `axiomfree` (three commits, not pushed, not merged to its main): the
   loader keys on `inputs.manifest.specVersion`, derives edges from
   telescopes, fetches the `references` layer whole and verifies it
   (ustar parsed, allowlisted names, byte-compared with `sourceText`);
   telescopes replace the assumption list on spec-2 proof cards; a
   `certified` chip, the comparator line with bundle digest and rerun
   commands, the closed Challenge details, and the trust note sit in a
   certificate block under the proof network; `environments.json` carries
   `specVersion` (from the records' manifests, else a `generateSite`
   option lax may pass, else `src/config.ts`); the raw `body` is carried
   but never rendered. Spec-1 HTML byte-identical. Jan: merge, release the
   renderer, re-pin in lax.
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

## State at the end of 2026-10-04 (day session)

Decision 10 and four outside reviews landed in three worker passes
(uncommitted at the time of writing; `npm run check` green, 1094 tests),
and the five-container Certify ran in docker: `spec2-certify` in 42 s
(Challenge build 4.2 s + export 3.4 s, Solution build 4.2 s + export
2.2 s, judge 1.1 s; concept Replay 9.3 s is the heaviest span at
837 MiB; no proof Replay). A fourth pass (judge self-test, tool digests,
the draft fold) and a verification review of the day's diff against the
four reports followed; see TODO.md for what each closed and the
decisions left to Jan.

## State at the end of 2026-10-04's night session

Stages 0–4 are on branch `axiomfree` (not merged to `main`, no release);
stage 5 is on lax-website's `axiomfree` (four commits, not merged). The
merged tip passes `npm run check` (92 files, 1042 tests) and the
`spec2-certify` docker smoke with the three-container Certify (Challenge
export 5.5 s, Solution export 5.6 s, judge 1.0 s; 45 s for the whole
submission). Two outside reviews shaped the code: the charter review and
the stages 1–3 review (`spike/axiomfree/codex-review-*.md`), both folded
in. What remains is stage 6 and Jan's items listed in TODO.md; the next
Codex review is due after stage 6's first round trip.

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

2026-10-04, ultracode review I1: a theorem of proof shape that Lean
generated (`auxiliary`/`realized` origin, e.g. `f._proof_1` from
`abstractNestedProofs`) is a helper instead of a `translation` violation;
`scoped` and unknown origins stay refused, the private-proof rule is
unchanged. Real-Lean coverage: `withFacts._proof_1` in the lax-39
realized-names e2e (`test/e2e/host-spec2.test.ts`).

2026-10-04, I1 follow-up (review of the I1 fix): `originOf` decided
privacy first, so the nested proof of a `private def`
(`_private.M.0.f._proof_1`) was origin `private` and refused as a private
proof. The `private` origin now carries the un-mangled parent when Lean
generated the name (no range, and reserved, a matcher realization, or
under an own parent); such a theorem is a helper, and the private-proof
rule applies only to theorems written `private`. The namespace exemption
is unchanged (still keyed on the module). Real-Lean coverage:
`hiddenWithFacts._proof_1` in the same e2e. The "only a forged olean"
wording for macro-scoped proof shapes was wrong (a hygienic command macro
produces one) and is reworded; the refusal stays.

2026-10-04, ultracode review C2: binder kinds are no longer recorded. The
inspector's telescope, both validators, the record's `telescope`, the
challenge check and the website carry statement and levels only; the
generator states every hypothesis as `(hᵢ : Sᵢ)`, so no Challenge needs
`checkBinderAnnotations false`. Proof-hood still accepts any binder kind
(the golden keeps `instHyp`). The author guide's instance-binder advice was
wrong (instance resolution never finds a `Prop` def that is not a class)
and is gone. This revises the "preserve rather than normalize" resolution
of Codex-intents finding 7.
