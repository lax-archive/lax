# TODO

Open work items, roughly in order. History lives in `history/` and git —
the rework execution record is `history/rework-execution.md`, the go-live
record (database port, cutover, HTTPS, first releases, round trip) is
`history/go-live.md`. Current state lives in README.md; proposed spec
amendments in spec-notes.md; the rework charter in rewrite.md +
rewrite-plan.md (fully executed).

## Axiom-free spec 2 and kernel certification (2026-10-03)

The plan is `axiomfree-plan.md`: Jan's decisions (attribute marker from a
pinned `LaxCore`, libraries pinned as a set with mathlib and CSLib, Replay
kept, kernel set a per-environment setting), the design, and six stages
released to `main` one by one. The spike is done (`spike/axiomfree/REPORT.md`);
the outside review and the common-sense review sit beside it and are folded
in; all decisions confirmed. Stage 1 landed 2026-10-03 (the library at
`~/git/lax-core`, to be pushed as `lax-archive/lax-core`; the pins, the
`specVersion`/`libraries` rows, the warm-store set, the libraries rule, the
spec-2 fake environment in `test/e2e/host-spec2.test.ts` under the
`v4.35.0-rc3` rehearsal toolchain). Stage 2 landed 2026-10-03 (the
inspector's `--spec 2` facts read from `LaxCore.laxStatementAttr`'s
entries, the spec-2 classification in `phases/inspect-spec2.ts`, the
background-only walk, `telescope`/`levelParams` in `build-output.json`,
the spec-2 golden, spec-1 goldens byte-identical). Stage 3 landed
2026-10-03 (the generator with its goldens, the Certify phase in the
runner, the local host run, the comparator verdict in one place, the
certificate layer in the capture store, the `certificate` block and the
spec-2 record shape of `recorded-shape.ts`) and was hardened 2026-10-04
after the outside review (`spike/axiomfree/codex-review-stages1-3-20261003.md`;
all seven "fix now" findings and the cheap "later" items — the judge is now
a third container over two frozen exports; see the stage line in
`axiomfree-plan.md`). Stage 4 landed 2026-10-04 (`lax certify` — record,
edge, and relative certificates composed along `selectProofTree`'s witness
forest, `--fetch`, the sandboxed `--run`; `lax doctor`'s
comparator/sandbox/kernel rows for a spec-2 row; `lax init --env`
scaffolding the spec-2 shape; `lax print spec --env`; the guided spec-2
`lax port`; the instructions section). Stage 5 landed 2026-10-04 on
lax-website branch `axiomfree` (not merged, not released). Next: stage 6
(Jan: merge and release the renderer and re-pin it; admit `v4.35.0` at
spec 2 once the mathlib tag exists, epoch flip, close `v4.33.0`, the Lax17
hand-port, the production round trip with a `--paranoid` rerun on a
machine that never ran lax, the spec reconciliation of `spec_v2_draft.md`
— it still describes two containers and lacks `_root_.`). Stage-4 items for Jan: the sandboxed `lax certify --run`
against a *real* record (the e2e exercises it over local fixture
repositories only after the folder is materialised unsandboxed, because
bubblewrap cannot see them; whether Lake's sandbox clones from GitHub and
pulls mathlib's artifact cache is the rehearsal's question); `lax certify`
of a Lax17-sized relative certificate (the composed Solution of a
28-hypothesis chain). Jan's items before stage 3 ships:

- **Docker smoke of Certify, again** — RUN 2026-10-04 twice: after the third
  pass on the five-container layout (`spec2-certify` in 42 s: A1 4.2 s, A2
  3.4 s, B1 4.2 s, B2 2.2 s, C 1.1 s; no proof Replay; peak 837 MiB in concept
  Replay) and after the fourth with the judge self-test (47 s, self-test
  7.3 s, every probe true in the real container).
  Original item: the 2026-10-03 run covered the
  two-container layout; the three-container one (A exports the Challenge, B
  builds and exports the Solution, C judges both exports with nothing of the
  builds mounted and a read-only `git` shim) is owed a run
  (`LAX_SMOKE_CASE=spec2-certify npm run smoke:submission-validation` with
  the spec-2 row injected — recipe in `test/smoke/submission-validation.ts`).
  The smoke needs the real mathlib warm store for rc3 (`~/.lax/warm/v4.35.0-…`,
  built on first run, ~6 min). The layout is now five containers (A1/A2,
  B1/B2, C — fable review finding 1.1): check that the export steps' `.lake`
  mounts are read-only in `docker inspect`, and settle whether docker adds
  `noexec` to an explicit `--tmpfs=/tmp:rw,nosuid,nodev,size=…` option
  string — commit d5eaa9b found `/tmp` noexec empirically while
  `container.ts` never asks for it; nothing relies on it today
  (`certify/phase.ts` header), but the comment should say what is true.
- **Judge self-test before any candidate code runs** — LANDED 2026-10-04
  (fourth pass, uncommitted at the time of writing): `certify/self-test.ts`
  runs a core-only three-module project through the same containers before
  A1 (matching pair passes, mismatched pair rejected by the comparison,
  export forged `value := type` refused by Lean's kernel) plus an eight-probe
  confinement check in the judge runtime (host canaries invisible, `lo` the
  only interface, `leanchecker` resolved to the toolchain, writes refused);
  nine tool sha256s digested before S1 and re-checked after C; the
  certificate's `judge` block carries `selfTest` and `tools`, and
  `parseCertificate` refuses a certificate without them. Cost in the smoke:
  7.3 s of 47 s. Owed in lax-website: its parser of `certificate.judge`
  must accept the two new keys before a spec-2 record is published.
  Original item:
- **Judge self-test before any candidate code runs** (from Palomar's
  policy, `PalomarRegistry/PalomarSubmission/SECURITY.md`, 2026-10-04):
  Certify should first export and judge three one-line modules of its own
  in the same containers and policy — a matching pair must pass, a
  mismatched pair must be rejected by the comparison, and a copy of the
  matching Solution export whose proof is replaced by its statement must be
  refused by Lean's kernel — and probe the sandbox (a canary written under
  the host home, `/tmp`, and the job dir invisible; no network; the judge's
  PATH resolving `which leanchecker` to the toolchain's). A wrong answer is
  an infrastructure failure, never a candidate result. Record the probe in
  the certificate's `judge` block. Cheap: three exports and one comparator
  run, and it turns "the judge said yes" into "a judge that just said no to
  a fake said yes". Second, smaller item from the same source: record the
  sha256 of `lake`, `lean`, `leanexport`, `leanchecker` and the kernels as
  installed beside the toolchain name, checked before and after the
  sandboxed runs.
- **Division of intents** (plan decision 10, 2026-10-04, confirmed by
  Jan the same day) — the five items below LANDED in the working tree the
  same day (uncommitted; `npm run check` green), together with Codex
  intents-review findings 1 (canonical-name rule, since C3 of the
  ultracode review a `String.toName` round trip of Lean's escaped
  printing, refused as `name-not-canonical`; a repeated name is refused
  unless both are theorems), 5 (the private
  exemption requires the package's own module), 6 (a kernel that failed
  to run is an infrastructure failure, never `kernel-rejected`) and the
  draft's narrower Replay wording. Not triggerable on rc3 in the
  realized-shape fixture: `hcongr_<n>`. Kept for the record: the judge answers correctness, the edge translation
  answers "the theorem is the edge", the inspector answers archive
  standards. Implementation items, each small, in this order:
  - **Private declarations exempt from the namespace rule** (they are
    module-mangled and cannot clash); spec-notes entry, since spec.md
    un-mangles before the prefix test; a unit test with a top-level
    `private theorem` in a proof package.
  - **Findings carry their intent**: a `judge | translation | standards`
    field on every finding, surfaced in the report artifact's rendering
    (`src/cli/run-artifacts.ts`) and the outcome comment, so an author
    reads "your proof is wrong" vs "your theorem is not the edge" vs
    "house rules".
  - **Drop Replay for spec-2 proof packages, keep it for concept
    packages** (decided). One `if` in
    `pipeline.ts replayStage` keyed on the environment's spec version and
    the package kind; the spec-2 draft's "Compile, Replay, Inspect" text
    follows.
  - **Realized-shape fixture at admission**: a proof package that triggers
    every compiler-realized reserved name the inspector exempts
    (`congr_simp`, `eq_def`, `unfold`, `hcongr_<n>`, match splitters and
    `congr_eq_<n>`) so a new Lean version's new shape is caught at
    environment admission, never by an author; add to the admission
    checklist in `history/environments-plan.md`.
  - **Spec text**: `spec_v2_draft.md` hygiene paragraph as a standard
    beside "edge correctness comes from the judge alone"; the trust-chain
    paragraph does not carry over to spec 2; the Challenge shown verbatim
    on the record page is the reader's audit surface for the translation.
  - **Fresh-mind review of the proof namespace conventions** — DONE
    2026-10-04, report at `spike/axiomfree/namespace-review-20261004.md`;
    its findings are the next block. The brief was: an independent agent
    whose sole job is to work out the right namespace conventions for
    proof packages so that composition — importing any set of the
    environment's records into one Lean environment — always succeeds.
    Give it only the question, Lean's import rule (`finalizeImport` /
    `subsumesInfo` in the environment's toolchain), the spec-2 draft's
    Namespaces section, and the inspector's `userLevelName?`; not this
    session's reasoning, which is what it is meant to check. Things we may
    have missed: auto-named instances and `deriving` output, names
    realized under a *mathlib* namespace by two records with different
    statements, `open ... in` and `export` aliases, universe-polymorphic
    duplicates, structure projections and auxiliary recursors, and
    anything the concept-package side (`Lax261.<Module>` ownership) leaves
    reachable from a proof package. Save its report beside the plan.
- **Namespace review findings** (`spike/axiomfree/namespace-review-20261004.md`,
  2026-10-04; verified on rc3 with a scratch project) — LANDED the same
  day by the second worker pass (uncommitted; `npm run check` green,
  1077 tests): `certify/challenge-check.ts` holds every `Cert.<id>`
  theorem to the recorded telescope; reserved non-theorems are flagged
  `realized` and held to the prefix; `initialize` entries and global
  parser/macro/elab entries are read inertly and refused; duplicates
  refused unless two reserved theorems; author phrasing in
  `assets/instructions.md`. From the Fable review: the build/export
  split (A1, A2, B1, B2, C; export steps mount the build tree read-only
  and write only `/out`), signals exit 3 = infrastructure, name hygiene
  (NFC, no marks/format chars, one script per component), non-https
  warm entries refused, `olean-unreadable` as a standards finding. Not
  as a committed fixture: the `enumToBitVec` reproduction (needs
  `Std.Tactic.BVDecide` in the fake mathlib). Kept for the record:
  - **Challenge held to the telescope (E1, correctness).** After container
    A, compare each exported `Cert.<id>` theorem's stored type and level
    parameters with the recorded telescope: the same statement constants
    with the same level instances in the same binder positions, the same
    conclusion. Mismatch is a `translation` violation. Implementation
    choice: run the inspector (`loadExts := false`) over A's Challenge
    olean and reuse the telescope reader, or parse `challenge.export`;
    either way the comparison is host-side over structured data, never a
    text diff. This closes the global-macro rewrite and is the
    independent structural check from the Codex review.
  - **Reserved-name exemption is theorem-kind only (B2).** A realized
    definition under an imported name (`<enum>.enumToBitVec`) is a
    namespace violation with the message "realized definition under an
    imported name; use a different tactic". Admission checklist: re-grep
    the toolchain's realizers for public `defnDecl` on every bump.
  - **No `initialize` in records (F1).** Detect `regularInitAttr` /
    `builtinInitAttr` entries in a record module's olean, or any constant
    with an `initFn` component; standards violation covering
    `register_option`, `register_simp_attr`, `declare_syntax_cat`,
    persistent extensions. (A reader's `lax certify --run` still runs
    authored elaboration-time IO; see the second Codex review, finding 3.)
  - **Global syntax state is a violation (E1 rule).** A non-scoped entry a
    record module contributes to the parser, macro, term-elab,
    command-elab, or attribute extensions (`ScopedEnvExtension` entries
    with their scope, readable inertly like `matcherNamesOf`) is a
    standards violation; `scoped`/`local` pass. If reading the entries
    inertly turns out costly, land the type check first and leave this as
    a TODO with the extension names listed.
  - **Within-package duplicate names (D2).** Dedupe by `(name, module)`;
    a repeated `name` is a violation unless it is a reserved theorem
    (realized in two modules of the same package, which Lean merges).
    Refines the worker's rule from the Codex review.
  - Optional hygiene the reviewer listed, Jan decides: forbid `export`
    into a namespace outside the package (C3); forbid `@[extern]`/
    `@[export]`, `unsafe`, `partial` (I1, I2); author phrasing for
    `assets/instructions.md` ("put everything under `namespace
    LaxNNNProofs`; never `_root_`; never `initialize`; `scoped
    notation`/`local attribute`; avoid `bv_decide`/`bv_normalize` on
    enums you did not define").
  - **Eager composition guard** (open question 3): a scheduled job that
    builds one file importing every proof package of an environment;
    catches every clash class except attribute drift, before the first
    relative certificate across an offending pair.
- **Codex intents review, open items** (`spike/axiomfree/
  codex-review-intents-20261004.md`, 2026-10-04; findings 1, 5, 6 and the
  draft wording landed, see above; these are Jan's or later):
  - **Publish the judged exports, or a reconstruction that is compared to
    them.** The record carries `challengeExportSha256` /
    `solutionExportSha256`, but the exports themselves are not in the
    five-file bundle, and `lax certify --run` judges a *rebuilt* project
    without comparing its fresh exports to the recorded digests
    (`src/cli/certify.ts runComparator`). "Replay the archive's historical
    evidence" and "prove this proposition again from source" are
    different operations and should be two commands, or one command with
    a `--historical` mode that fetches the exports by digest. A verdict
    manifest binding exports, configuration, tools, and record id is the
    same item.
  - **Reader's checklist on the record page**: what a reader must check
    beyond Challenge.lean — the Solution's application of the named
    proof, `comparator.json`'s target list and permitted axioms, the
    statement definitions in the concept source, the lakefile pins and
    toolchain, and the export digests. The website's certificate panel
    should list these with links; the reflowed Challenge alone is a
    partial audit (finding 3).
  - **Warm closure pinned per environment** (already above; finding 2
    repeats it): until then, the publisher's regeneration does not
    authenticate the full dependency closure.
  - **Independent structural checker for the translation**: a second
    implementation (or a Lean-side check in the judge project) that the
    exported Challenge's theorems reference exactly the registered
    statement constants the record names, so that regeneration with the
    same TypeScript is not the only check (best-practices section).
  - **Unused-helper and proof-dependency findings stay advisory**; every
    hard standard documents its rationale and its enforcement limit, and
    the `standards` label is never read as "security-irrelevant".
- **Fable intents review, open items** (`spike/axiomfree/
  fable-review-intents-20261004.md`, 2026-10-04; finding 2 — the
  build/export split — plus findings 4, 5 (cheap half), 6, 7 went to the
  second worker; these remain):
  - **Show compiled bodies of the package-local cone** (finding 3). The
    reader's audit surface shows olean bodies only for tagged statements;
    auxiliaries a statement refers to are shown from *source*, which
    compile-time IO in the concept package can make differ from the
    judged olean. The inspector already has `usedConstants`; emit the
    pretty-printed bodies of the package-local cone of every statement,
    the website shows them beside the source with the note "compiled, as
    shown", and the trust note says which of the two a reader is
    trusting. Palomar has no analogue because its Challenge imports no
    candidate code; this is lax's own answer for the concept side.
  - **Carry the direct-require set in the report** (finding 5, the other
    half): `verify-bundle.ts` treats the whole resolved closure as direct,
    so the publisher cannot repeat the direct-require rule. Record the
    direct set in `build-output.json` and have the publisher regenerate
    the lakefile from it.
  - **`uniqueDeclarations` merges same-name theorems without comparing
    types** (D2, the half the second worker's refinement may not cover):
    two reserved theorems of the same name in two modules of one package
    are kept as one; if they ever differed in type Lean would refuse the
    root import first, so this is a consistency note, not a hole — record
    which module's copy the id refers to.
  - **Stale wording** the review lists: plan line ~226 (names "emitted
    escaped from a `Lean.Name`") and draft 1736/1749–1765 still describe
    the pre-split flow; Jan's reconciliation.
  - **Docker smoke**: verify whether docker adds `noexec` to an explicit
    `--tmpfs` option string (commit d5eaa9b found the tmpfs noexec
    empirically; `container.ts` passes `rw,nosuid,nodev` only).
- **Pin the warm manifest per spec-2 environment.** The publisher regenerates
  and re-seals the whole certificate bundle from the record (`certify/
  verify-bundle.ts`) except the warm closure's entries in `lake-manifest.json`
  — mathlib's transitive dependencies at the revs its manifest pins — which
  only the provisioned warm store knows; they are taken from the tar and held
  to their shape and to the row's library pins. A committed copy of the warm
  manifest per environment (an admission-checklist item) would let the
  publisher regenerate that too and close the gap.
- **Second Codex intents review** (`spike/axiomfree/
  codex-review-intents-2-20261004.md`, 2026-10-04, written with every
  earlier report in hand; premises of 1, 3, 4 checked against the Lean
  source and the code) — the worker items LANDED the same day (third
  pass, uncommitted; `npm run check` green, 1094 tests): the inspector
  emits one `origin` per declaration with evidence (`authored` /
  `private {module}` / `scoped {module}` / `realized {parent}` /
  `auxiliary {parent}`, each from Lean's own facts), every rule consults
  `origin` and none the display name; per-module bodies in the axiom
  walk and hygiene before de-duplication; `lax certify --run` verifies
  every manifest checkout at its pin and clean and removes the record
  packages' build products (residual `TODO(decision 10)` in certify.ts:
  a library's `.lake/build` survives between runs); `kernel-rejected`
  only for kernel exit 1; local `--replay` covers both packages. Kept
  for the record; the "Jan's decisions" sub-list is still open:
  - **Provenance-based ownership (finding 1, High).** `isInternalDetail`
    is a heuristic, not provenance: an authored `Lax1.C.«A.B».proof_1`
    is exempt from the namespace rule and the canonical-name rule and
    can still be tagged. Rules: (a) a tagged statement and a proof-shaped
    theorem must have a `userName` (be user-level) and be canonical, or
    they are refused as `translation`; (b) the namespace prefix test
    applies to *every* declaration the package contributes, with
    exemptions only for authenticated provenance — `isReservedName` true
    and theorem kind (realizations under imported constants), the
    package's own `_private.<module>.0.` names, the package's own
    macro-scoped (`_@.<module>._hyg.`) and `_aux_<module>_` names — never
    for "looks internal"; the realized-shape e2e fixture and the existing
    fixtures are the test that no generated name of an honest package
    trips it; (c) telescope constants go through the same user-level +
    canonical gate.
  - **Per-module hygiene (finding 4).** The inspector enumerates each
    module's `constNames` but reads the body with `env.find?` over the
    merged environment, so two same-name theorems in two modules (one
    `sorry`, one not) show the merged body twice. Read each module's own
    `ConstantInfo` from its `ModuleData.constants`, run the axiom walk on
    that, and apply hygiene before de-duplication; the duplicate
    exception then requires the inspector's `realized` origin (an
    `isReservedName` fact), not merely an absent `userName`.
  - **`lax certify --run` reuses `.lake` (finding 3).** A proof build's
    elaboration-time IO can alter the concept dependency checkout inside
    `.lake`; the next run's Challenge is built against it and "Certified"
    is printed. Before every run: verify each `.lake/packages/<pkg>` is at
    its pinned revision and clean (`git rev-parse HEAD`, `git status
    --porcelain` empty) or refuse; delete the record packages' build
    products (keep mathlib's cache); and say in the output that the
    Challenge was built from freshly verified checkouts.
  - **Kernel crash vs rejection (incomplete fix of finding 6).** The
    comparator prints its rejection notice for *every* nonzero kernel
    exit, a crash included (Check.lean); read the kernel's own exit code
    from the transcript and treat anything but the documented rejection
    code (signal range, 134, …) as infrastructure. `run-certify.mjs`
    exit 2 (spawn failure: missing `leanexport`/inspector) must be
    infrastructure in A/B's readers too.
  - **`lax build --replay` must replay spec-2 proof packages locally**
    (the draft recommends it for checked helpers but `host/pipeline.ts`
    excludes them even with the flag): opt-in local replay covers both
    packages.
  - **`src/cli/certify.ts` ~191 drops `verdict.intent`** when building the
    reader CLI finding; keep it.
  - **Jan's decisions from this review:**
    - *Revalidation semantics (finding 2, High).* `/lax admin
      revalidate` of a concept record replaces its capture while
      dependents keep certificates judged against the old one; a
      statement whose body changed (compile-time code with a date
      threshold passes concept Replay) is then shown as proven. Options:
      refuse a revalidation whose concept capture digest changes while
      registered dependents exist; or make it a new version under the
      supersedes mechanism; and in every case record the dependency
      capture digests in the certificate (`verify-bundle.ts` has them in
      the manifest already) and have the website resolve a certified
      edge's endpoints by (statement id, capture digest).
    - *Metadata-only resubmission keeps the certificate at the old
      commit (finding 5).* `record.source` moves to C2, the bundle's
      own-package require still names C1, so `lax certify` regenerates a
      different digest than `--fetch` returns. Record the certified
      source commit separately from the presentation source, or
      regenerate the bundle on the metadata path under the "Lean sources
      byte-identical" equivalence the comparison already proves.
    - *Website trust note* (lax-website `shared.ts` ~244) says readers
      need not trust the pipeline; narrow it to what the Challenge and
      the bundle establish (the reader's checklist item above).
- **Verification pass** (`spike/axiomfree/verification-20261004.md`,
  2026-10-04): 28 of 29 worker-assigned findings CLOSED by re-tracing the
  diff, 1 PARTIAL (the issue comment carried no intent; sent to the fourth
  pass with five small flagged items: `oleanRefusalPattern` too wide, A1
  build failure wording, `canonStr` injectivity comment, dead
  `privateOwner`, no test pinning the proof-Replay drop). Residuals it
  named that no block tracked:
  - **UTS#39 confusables**: name hygiene covers NFC, marks, and script
    mixing per component, not single-script confusables (Fable 1.3's
    other half); the website linking every Challenge name to its card is
    the cheap complement.
  - **Attribute applications are out of the global-syntax rule** (namespace
    review E2, by that review's own verdict): `attribute [simp] …` on an
    imported declaration changes every importer's simp set; harmless to
    the certificate, a courtesy rule for other authors if wanted.
  - **A forged reserved theorem with a wrong type** breaks co-import with
    an honest record that realizes the same name (namespace C1-5's
    reserved half); no soundness effect, a composition nuisance only.
- **Reader consolidation** (review, "later"): `archive-schema.ts` accepts a
  broad envelope and `artifact-schema.ts parsePublishedCapture` picks the
  capture shape by field presence (`files` absent → spec 2); spec selection
  should come from the owning environment row, once, and every archive and
  capture reader branch on that.
- The spec draft (`spec_v2_draft.md`) still describes two containers; Jan
  reconciles ("Two containers" → three, the judge's mounts).
- **Scratch-repo rehearsal** (`scripts/rehearsal/`) for the Actions-side
  change: `certificate.tar` in the validate artifact and
  `VALIDATION_CERTIFICATE_PATH` in both publish steps, the certificate
  layer's push before the CAS commit, a spec-2 record landing in the
  database in its new shape.
- The transitively-reachable-statement e2e stage 2 only table-tested is
  still owed; the chain e2e of stage 3 (`host-spec2.test.ts`, lax-41 over
  lax-38) covers the direct require only.
- The build-output investigation's capture change landed with stage 3 as
  its own commit: a spec-2 record's `capture` is `{ formatVersion, digest,
  sourceCommit, bytes, fileCount, references: { digest, bytes,
  registryBlob }, registryBlob }` — no `files` — and the `references`
  layer (concept sources + `.ilean`, `application/vnd.lax.references.v1+tar`)
  rides in the record's OCI manifest. lax-website still reads
  `capture.files` for its reference maps; until stage 5 reads the layer,
  the local renderer adapter (`src/cli/website.ts`) withholds a spec-2
  capture's address from the pinned renderer, which then shows no links.

## Sibling drafts (2026-09-19)

`lax build --nonstrict` landed: sibling `path` requires built in place, the
draft-dependency warning behind the same flag, strict default everywhere
(spec.md "lax build" specifies both since 2026-09-19). Owed:

- `lax serve` is unreachable for the whole render: `generateSite` blocks
  the event loop for 14–21 s on the current database, so a link clicked
  during a rebuild hangs until it finishes. Move the render to a worker or
  a child process.
- A real round trip on two scratch drafts: iterate with `--nonstrict`,
  register the dependency, follow the printed git require, submit the
  dependent. The e2e (`cross-submission.test.ts`) covers the build; the
  author journey is untested.
- The strict refusal of a path require does not look the sibling up, so an
  author who registered the dependency and forgot the edit sees "not
  supported by the archive" plus the chain hint, not the triple. Run
  `--nonstrict` once to get the triple; document or fold if it bites.
- Two concurrent builds (the sibling's own and a dependent's) write the
  sibling's `.lake` at once; three racing rounds did not break, and the
  proofs → `../concepts` edge has always had the same race. No lock; note it
  if it ever bites.

## Inspector report size (2026-09-16)

Lax17's resubmission on v4.33 (405 modules, 38,484 declarations) failed as
an infrastructure failure: its proofs inspector report is 49 MB, and both
pipelines rejected anything above a 32 MiB literal. The bound is now a
named limit, `inspectorReportBytes` (256 MiB), read by both runners. Still
owed:

- **Compact the report format.** 396k package-local dependency edges are
  spelled out as ~100-character fully qualified names (31.5 of 46.8 compact
  MB); `module` and the `propext/Classical.choice/Quot.sound` axiom triple
  are repeated per declaration; pretty-printing adds 2.6 MB. A name table
  with integer edges, a module index, and compact JSON would land the same
  report near 10 MB. This changes the inspector source (so every
  environment's inspector rebuilds once) and the parser in
  `phases/inspect-runner.ts`, with the golden fixture; do it together.

- **Unused-lemma warnings near their own cap.** The same submission raises
  7,142 `unused-lemma` warnings; the trusted artifact parser rejects more
  than 10,000 findings (`artifact-schema.ts`, `MAX_FINDINGS`) and the CLI
  renders the first 1,000. 1,712 of them name compiler-generated
  `mk.inj`/`mk.injEq`/`mk.sizeOf_spec` lemmas that `userLevelName?` in the
  inspector should drop: on v4.33 Lean no longer marks them reserved, so
  the filter needs a v4.33 rule (and a golden-fixture case). Consider also
  folding the warnings into one per module, or capping them in the
  collector, before another large submission trips the artifact bound.

## Stability pass 2026-09-07: what it owes

Landed on `claude/lax-repo-improvements-qruciz` (compile thread budget
named and per-environment, `--memory-swap` pinned to the cap, credentialed
jobs building from their own checkout, cancelled runs reported, publish
job timeouts, the record gates placed once in `record-gates.ts`, delete
re-listing dependents at the snapshot, the unknown-verb reply naming the
verbs, the instructions' two-run first submit). Still owed before it ships:

- **Scratch-repo rehearsal** (`scripts/rehearsal/`) for the
  `submission.yml`/`setup-lax` change — the standing rule for any
  Actions-side change. What to watch: the publish jobs building their own
  tree (about 13 s more each), a deliberately cancelled validate job
  producing a failure comment and clearing the reaction, and a delete
  raced by a submit refusing with the fresh dependents list.
- The failure comment a cancelled validate job now gets is the
  infrastructure wording ("no trustworthy report was produced"), accurate
  for a timeout and slightly misleading for a manual cancel; the reporter
  cannot tell the two apart from the report alone. Reword if it confuses
  an author.
- `scripts/environments/admit.mjs`/`table.mjs` render only `leanThreads`
  and `memoryBytes`; a `compileLeanThreads` override is written by hand.

## Submission presentation flags (core implemented 2026-09-09; Website pending)

The `lax` validator and trusted artifact parser now accept and retain the
optional manifest booleans `unlisted` and `anonymous`; see spec.md,
manifest.yaml.
The remaining work belongs to `lax-website`:

- Add both fields to the Website manifest type. Exclude `unlisted: true`
  submissions from the landing-page submission list and all search/tag index
  inputs, while continuing to generate directly addressable submission,
  concept, proof, and paper pages.
- For `anonymous: true`, suppress author names and identity links, generated
  citations, and every source-repository link across submission, concept,
  proof, paper-card, graph, and metadata surfaces. Cover every supported
  repository provider, not only GitHub. Public database and source data stay
  unchanged; this is presentation anonymity, not confidentiality.
- Add Website fixtures and assertions for each flag independently and
  together. Once deployed, update `assets/instructions.md`, advance the
  renderer pin used by `lax serve`, and include the new fallback renderer in
  the next CLI release.

## Audit leftovers (audit 2026-09-03, fixes landed 2026-09-04)

The record is `history/audit-20260903.md`. All three fix-now findings and
all eleven fix-soon findings are fixed, each with the test that would have
caught it; the spec-relevant behaviour changes are folded into spec.md.
What the audit deliberately left, and what the fixes left
behind:

- **Production checked 2026-09-04.** lax-3's stale-dependency failure
  (2026-09-03 19:29, racing the chain sweep) was retried the same evening
  and published at 20:10 (`0d5dc53`), so nothing is owed there. The
  stranded-dependents sweep found none: the three deleted records
  (lax-15, lax-55, lax-61) are required by no live record. The one
  pre-2026-09-03 paper record is lax-48 (below).
- **Recorded and not fixed** (the audit's "record and move on"): `lax
  register`'s preflight prints the permanence note and demands a typed
  confirmation for a supersession the archive will refuse, and
  `instructions.md` plus a docstring at `resolution.ts:251` state only the
  weaker of the two ownership rules; the count-check diagnosis never offers
  "that file is not part of your main document"; the oracle prints
  `floor − 2/total` as a measurement when Myers' search exceeds its budget,
  so a true 0.0 reads as a hairline 0.9799; a duplicate `\input` collapses
  destinations silently (pdfTeX warns, latexmk does not fail — scan the
  transcript for "duplicate ignored"); proof-tree housekeeping (a failed
  re-run leaves a stale `.olean` beside no report, concurrent capture
  promotion crashes with `ENOTEMPTY`, the runtime cache key omits the
  toolchain `warmDir()` includes); `submit-publisher.ts:256` claims
  `parseArchiveFiles` re-validates a published `paper` block, which it does
  not. (The cancelled-validate silence — 7 of 200 runs — was fixed
  2026-09-07: both reporters accept `cancelled`.)
- **The same defect class, one step out.** Findings pushed straight into
  `violations` by `pipeline.ts` and `host/pipeline.ts` bypass
  `FindingCollector` and so its sanitizer; they reach only `ok:false`
  reports, which the publisher never parses, so nothing is at risk today.
  Route them through the collector. Likewise nine separate spellings of
  "normalize line endings" (the formatter's own is inline in
  `safeTranscript`) want one exported helper in `comment-format.ts`, and
  `"pics"` is a literal in four places across `web.ts` and the generated
  converter.
- **Coverage the fixes could not reach.** `checkGeneratedFilesIgnored` is
  wired in the `scope === "both"` success block, which only a full Lean
  build reaches, so no unit test crosses it — the cheapest real coverage is
  `test/e2e/host-paper.test.ts` with `paper.pdf` dropped from
  `test/support/host.ts:90`'s fixture ignore list. Those hand-written
  ignore lists (also `test/smoke/submission-validation.ts:432`) are the
  sixth copy of the generated-file names and should read
  `generatedFilesGitignore()`.
- **What the new typecheck does not cover.** `scripts/**` is checked for
  `.ts` only; the `.mjs` drivers (`port-db`, `rehearsal`, `reflowtex/fetch`)
  need `allowJs`+`checkJs`, which will surface its own list. And tsc accepts
  the temporal-dead-zone read that started all this — an ESLint
  `no-use-before-define` would catch that class, at the price of a linter.
- **`proof-tree.json`'s `selection` value** changed from `"random"` to
  `"fallback"`. Nothing in this repo or lax-website reads it; out-of-tree
  tooling would break.

## Pipeline simplification: rolled out and closed, 2026-08-07

Nothing left here — the record is `history/pipeline-simplification-rollout.md`,
including the production sweep (seven records resubmitted bottom-up) and the
deliberate failure probe that closed the last untested path. The superseded
Website App private key was deleted and `roundtrip-20260807` was merged into
lax-submissions `main`, so every recorded source is reachable from the
default branch.

Merged and released as 0.1.21: the fail-early static gate, the
route → validate → publish-submit DAG with the Website dispatch folded into
the publish jobs, and the report artifact as the author's channel. The
rollout that went with it: both App keys now live in `lax-database-publish`
(a freshly generated Website key — GitHub never shows an existing one
again), that environment's deployment policy is a custom one naming `main`
instead of the "protected branches" policy that constrained nothing (the
repo has no branch protection rule and no ruleset), the
`lax-website-dispatch` environment is deleted, and the CLI App
(`lax-cli-publisher`, org-owned like the other two) has the `Actions: read`
permission the report download needs.

## Go-live leftovers (context: history/go-live.md)

- **Round-trip sources: settled.** lax-submissions `main` is now `4af91ea`,
  which carries the recorded source of all seven chain submissions —
  lax-13/lax-14 at `d35ba57`, lax-11/lax-12 at `becb578`, lax-3/lax-5/lax-15
  at `4af91ea`. The old `roundtrip-20260806` and `port/chain-requires`
  branches name commits no record points at any more, so they are free to
  delete.
- **Scratch-repo teardown**: delete `jan3er/lax-scratch-{control,database,
  submission}` and ghcr package `lax-scratch-captures`, and rotate the
  personal token that stood in for the App mints (Jan).
- **port-db driver robustness** (matters only if the driver runs again):
  retry transient `gh` failures during polling instead of failing the
  record; check for our command marker before re-posting after a timed-out
  POST; raise the 20-min default timeout (lax-17 validates in ~28 min).
- Delete the dead `lax-capture-*` GitHub Releases on lax-database and the
  stale `LAX_VALIDATION_IMAGE` Actions variable on lax-archive/lax.
- **Org domain verification** for laxarchive.org (lax-archive Settings →
  Pages → verified domains) against domain takeover.

## CLI

- **The CLI cannot renew a login, so `lax login` is due every 8 hours**
  (Jan, GitHub App settings). The App issues expiring user tokens, and
  GitHub renews one only for a client that presents the App's *client
  secret* — which a published CLI has nowhere to keep. The renewal request
  therefore always comes back `incorrect_client_credentials` (verified
  against github.com, 2026-08-09), and re-logging in is the only path.
  The messages no longer blame a GitHub outage for it, but the fix is a
  setting, not code: turn **Expire user authorization tokens** off in the
  `lax-cli-publisher` App. New logins then store no `expiresAt`, the
  renewal path is never entered, and the login lasts until it is revoked.
  Decide against the security trade-off (a leaked `ghu_` stops expiring on
  its own; `lax logout` and GitHub's revocation page still kill it).

## Paper layer (paper-plan.md + paper-web-plan.md — code stages landed 2026-09-02; Jan-owned gates remain)

A submission may carry a LaTeX paper the archive compiles itself (`paper:`
in `manifest.yaml`, `% lax begin <id>` / `% lax end` markers); beside the
PDF the archive derives a reflowable web view (ReflowTeX, non-blocking,
`web: false` opts out), and the site's paper page shows both surfaces with
a card per marked passage. All code stages of both plans are merged
(lax-website 2026-09-03 morning, lax the same day); the author contract
is in instructions.md, the rules in spec.md ("Papers"). The fork
`lax-archive/reflowtex` exists (`lax`
branch, one commit per changed file) and the pin points at it. Jan waived
the scratch-repo rehearsal for the 2026-09-03 merge ("finish all the
way"); the standing rule itself stands for the next Actions-side change.
The first real papers (lax-65, then the 2026-09-08 corpus pass over 44
papers — `history/reflow-maturation-20260908.md`, which holds the defect
classes, the per-round numbers and the lessons) closed the trusted-path
and rendering defects that one fixture could not reach. What remains:

- **Deploy the 2026-09-08 reflow pass.** In order, all of it uncommitted
  to any remote today:
  1. push the fork checkout's `lab` branch onto `lax-archive/reflowtex`'s
     `lax` branch (8 commits over the pinned `61dc460`; noreply author —
     GitHub rejects the gmail address, so Jan may have to push), then bump
     `REFLOWTEX_REV` in `pins.ts`. `reflowtex/fetch.mjs` already asserts
     the new schema surface (`fnref`, `footnote_ref`, `Paragraph.width`,
     `Paragraph.footnote`), so a stale pin fails the fetch loudly.
  2. merge the `lax-website-reflow` worktree's `reflow-lab` branch (viewer
     + schema gate + the uncommitted sidenote work, below) into
     lax-website `main`.
  3. `npm run check` and `LAX_SMOKE_CASE=paper-web npm run
     smoke:submission-validation`, then recut the bundle fixture
     (`npm run paper-web:fixture`, `test/fixtures/paper-web/paper-web.tar`)
     — the old one carries the pre-footnote schema.
  4. re-pin and release the renderer for `lax serve` (the mechanism is
     done: `https://laxarchive.org/_renderer/latest.json`, packaged by
     `release.yml` on the `v*` tag; only the lax-website rev needs
     moving). The picture converter's wheel is *not* part of this — only
     the trusted container derivation uses it.
  5. `npm run admin -- revalidate` the three paper records:
     **lax-157538** (no `paper.web` at all today), **lax-48** (registered;
     blank figures and missing icons from the pre-2026-09-03 Ghostscript
     conversion — this is the admin verb's first production use), and
     **lax-242665**.

  The lax-side changes (`assets/tex/laxreflow.sty`,
  `reflowtex/encode_web.py`, `reflowtex/fetch.mjs`, `paper/web*.ts`,
  `paper/extract*.ts`, `config.ts`, their tests) and the lab harness
  itself (`scripts/reflow-lab/`, still untracked) commit with step 1.
- **Six web-compile classes still failing or shimmed** (round 3, 6 of 45
  entries skipped on `web-compile`; the lualatex + `-shell-escape` +
  injected-package combination breaks documents whose own pdflatex build
  is fine):
  - **acmart + unicode-math**: `\widehat\CC` (a `\mathcal` alias under
    `\widehat`) aborts with `Missing { inserted` at
    `\__um_group_begin:` — `decomposition-trees`,
    `model-checking-interpretations`. A source-side limit as far as we
    know; the paper keeps a PDF-only page. Worth one more look at whether
    the injection order can avoid it.
  - **AAAI `\boundary`**: `aaai24.sty` papers that
    `\newcommand{\boundary}` collide with LuaTeX's `\boundary` primitive
    (`preprocmso`). `luatex85` does not cover it; a shim would have to
    `\let\boundary\undefined` before the class, which is a real decision
    (the primitive is otherwise reachable).
  - **remember-picture / overlay under externalization**: the sub-run
    exporting one picture cannot see a node another picture defined
    (`No shape named 'inText' is known`, `monadic-stability`).
  - **lmcs shipout**: the class takes `\shipout` in a way that leaves
    pgf's `\pgfexternal@originalshipout` undefined in the sub-run
    (`struc-bound-exp`).
  - **Externalization cost on long figure-rich papers**: externalization
    re-runs the whole document once per picture, so `grid-wideness` (124
    pages, 190 files) took 623 s and blew the then-10-minute limit. The
    limit is now 30 min (`paperWebCompileTimeoutMs`); re-measure it.
  - **`bbm` Metafont fonts**: `bbm` ships Metafont sources only, so
    `bbm10`/`bbm7` are requested by the export and no Type1 outline
    exists (`lax-web-pfbs.txt` lists them, `lax-fonts/` has no
    `bbm*.pfb`) — `\mathbbm` glyphs stay metric boxes in lax-157538.
- **The oracle residual for papers still under 0.98.** All 20 `web-oracle`
  skips were decomposed (`diff --minimal` hunks; the hunk decomposition
  *is* the Myers metric, and a Python re-implementation of `web-oracle.ts`
  reproduces every job's similarity to 6 decimals). 27 481 divergence
  tokens, and **not one of them is a real text loss** — no hunk anywhere
  shows the view dropping a sentence the PDF sets. The classes:
  token-boundary skew in math **33 %**, moved text (floats and captions)
  **22 %**, math-font glyph asymmetry **21 %**, token-boundary skew in
  words **10 %**, text inside included figures **6 %**.
  - **Oracle-side, being implemented now** — measured to take **12 of 20**
    over the floor, from 0 today: **(A)** merge-tolerant `compareTokens`
    (a hunk whose two sides concatenate to the same characters is not a
    divergence) — alone 10 of 20; **(B)** character-level `removeTokenRun`,
    which also drives `relocatedUnmatched` to 0 everywhere; **(C)** fold
    U+2206 to U+0394 in `oracleTokens` — one line, and `arxiv-0902-0732`
    0.9715 → 0.9902. Not "drop single-character tokens": measured, it
    *lowers* similarity on 14 of 18 jobs by shrinking the denominator.
  - **Stream side, what is left after A+B+C** (8 papers): non-CM 8-bit
    faces (Euler, Palatino) mis-decoded in `encode_web.py`'s
    `decode_glyph` — 1 398 tokens, `daniel-thesis` alone; cmex/cmsy
    lowercase slot letters, where the fix is to mirror pdf.js's
    slot-letter fallback rather than delete evidence; a clipped
    `\includegraphics` that attribute 902 never stamps, so two papers lose
    their figures *and* their figure text (being fixed now); and floats,
    which the walk emits out of page order — 6 050 tokens, 4 papers —
    wanting either emission at the shipped position or an extension of
    `relocated` to any content the serializer moved.
- **Sidenotes**: the viewer and `manuscript-reflow.js` lift each footnote
  segment into the margin rail where the page has one (the schema carries
  `fnref` / `footnote_ref` / `Paragraph.footnote` and the block states
  `data-latex-footnote-width`), with endnotes as the fallback. Working in
  the `lax-website-reflow` worktree but **uncommitted** — commit it before
  the merge above, or the merged viewer sets endnotes only.
- **tcolorbox callout frames are not drawn.** `shield externalize` (armed
  globally when the package loads) makes the boxes typeset inline, so
  their *text* reaches the stream while the frame, a pgf literal, does
  not. A callout therefore reads as plain body text. Carrying the frame
  would mean giving the walk a box-decoration concept.
- **Nothing in the reflow surface is a link.** `pdf_dest` / `pdf_annot`
  whatsits are dropped by `strip_unsupported_nodes`, so `\ref`, `\cite`
  and bibliography URLs render as dead text — often still in hyperref
  blue, which advertises a link that is not there. (The pdf.js surface
  renders no annotation layer either, so the regression is against the
  downloadable PDF.)
- **[Jan] The fixed-measure column at wide viewports** — a site CSS
  decision, not a defect: the reflow band is ~576 px at an 1100 px
  viewport and ~544 px at 700 px, so nearly half a wide window is empty.
  The gutter is deliberate (margin notes, marked passages, sidenotes). Decide
  whether the measure should grow with the viewport, and by how much.
- **[Jan] Production round trips** closing both plans — a real paper (the
  flagship drafts in `~/git/lax-submissions`) through validate → publish →
  site page with both surfaces — recorded in `history/`; measure the TeX
  image pull there (84 s on lax-61, where it *was* the critical path — a
  layer cache is worth deciding once real papers arrive). Afterwards
  retire paper-plan.md and paper-web-plan.md into `history/`.
- **[Jan] Delete the throwaway repository**
  `jan3er/lax-paper-roundtrip-20260902` from the lax-61 stage-3 round trip
  (`history/paper-roundtrip-20260902.md`): `gh auth refresh -h github.com
  -s delete_repo`, then `gh repo delete … --yes`.
- **Virtual fonts that compose** keep metric boxes: the export follows a
  nameless virtual face to the outline its program draws from and keeps
  only the slots the two share (landed 2026-09-03 for `BOONDOX-r-cal`,
  lipics `\mathcal`), but a slot built from two glyphs (an accent) has no
  single source and stays a box. BOONDOX bold / fraktur / doublestruck
  are untested.
- **Cache the PyMuPDF wheel in the Validate job** (optional): `npm run
  reflowtex:fetch` now downloads 25 MB per paper-bearing run. The existing
  `actions/cache` pair covers `reflowtex/venv`, keyed on
  `requirements.lock`; the wheel would want its own pair over
  `reflowtex/pymupdf`, keyed on the `PYMUPDF_*` pins rather than on all of
  `pins.ts` (which every unrelated pin bump would invalidate). The step
  already tolerates failure — a missed download degrades to a
  `web-toolchain` skip — so this is throughput, not correctness.
- xelatex is untested for the end-marker relocation
  (`test/e2e/paper-neutrality.test.ts` measures pdflatex and lualatex):
  add `texlive-xetex` to the CI TeX set, or verify at the first
  xelatex-engine paper.
- **Upstreaming candidates** from `lax-archive/reflowtex` to
  `radek-p/reflowtex` — all of them fixes to silent drops upstream shares,
  none of them archive-specific: the `has_ink` gate (standalone figures
  vanished from the view), the shipout walk's box/column/rule/footnote
  branches and the `lineno` frame-vs-margin-decoration split, the
  `\@startsection` skip restore at a page top, the Type1 glyph-name →
  Unicode addressing (upstream sends every math relation to the PUA), the
  ligature/small-cap `text` field, and the missing-character drop.
  Marker capture and the `page` field on a picture are ours to keep.
- Known limits, carried: pdf.js stays `pdfjs-dist` 5.6 (the last line
  that runs on Node 20.19; its optional `@napi-rs/canvas` native
  dependency is never loaded); the paper containers run under the Lean
  memory/cpu caps (a smaller per-invocation cap is a knob); the TeX image
  digest is not recorded in the report's runtime identity (the pin lives
  in `pins.ts`, so a bump is a reviewed edit).

## Archive environments (closed 2026-09-04; record in history/)

Several Lean/mathlib versions: a yearly **epoch** as the default, monthly
mathlib `vX.Y.0` release tags, and retained pins for closed environments which
still have existing submissions. All six stages, the first admission
(`v4.33.0`, CLI 0.1.39) and the first off-epoch round trip (lax-851268,
deleted afterwards) landed 2026-09-04; the plan is
`history/environments-plan.md` and the round trip, with its measurements,
is `history/environments-roundtrip-20260904.md`. The epoch moved to v4.33.0
and v4.30.0 closed to new records on 2026-09-13; its support is now limited to
records which already existed. What stays open:

- **Port the registered v4.30.0 records to the epoch** (Clemens, in
  `lax-submissions`; runbook step 2, bottom-up). Done 2026-09-13:
  lax-13 → lax-865980 and lax-14 → lax-345067. Left, per
  `https://laxarchive.org/index.json`: **lax-5**, **lax-12**, **lax-41**,
  **lax-48**, **lax-49**. lax-48 is the one that carries a paper, so it
  also wants the revalidation the reflow item above owes it — port and
  revalidate are different records now, decide which the paper deploy
  targets. The 35 v4.30.0 drafts need nothing: they predate `closedAt`
  and may still submit where they are.
  Both ports took two to three submits, each first attempt failing in
  `compile-proofs`; budget for that, and read the failures out of the
  report artifact (`lax submit` renders it) rather than the issue comment.
- **Admit v4.34.0, and see the admit job open its first pull request.**
  The 2026-09-15 scheduled run found v4.34.0 and failed in `npm test`:
  two tests read the expected environment list outside the seam scope
  their subject ran in (`doctor.test.ts`, `validation-host-setup.test.ts`;
  issue #116), so under the workflow's injected candidate they expected
  it where the report had none. Fixed 2026-09-16, suite green with a
  candidate injected. Until the admission lands, authors on v4.34.0 are
  refused. Next: push, then `gh workflow run environments.yml -f
  tag=v4.34.0` — the first run to exercise `gh pr create` from the admit
  job ("Allow GitHub Actions to create and approve pull requests" has
  been on since 2026-09-04 evening; the first admission's pull request
  was opened by hand). Merge the pull request, release, close #116.

## Admin tool (admin-plan.md — issue-scoped verbs and the driver landed 2026-09-04)

`/lax admin revalidate|delete|reset-draft|owners` are live in the control
plane (numeric-id allowlist `ADMIN_GITHUB_IDS`, gates repeated
credential-free in both publishers; spec.md, "Maintainer actions"), driven
from a maintainer's machine by `npm run admin -- …` (`scripts/admin/`,
the maintainer's own `gh` token, comments and reads only). Still owed:

- **Production round trip**: `npm run admin -- revalidate lax-48` is the
  first real use (see the lax-48 item above). Watch the run once: the
  Validate job on a closed issue, the `revalidate` result comment, the
  ghcr push, and the Website rebuild of a record whose state did not
  change. A scratch-repo rehearsal (`scripts/rehearsal/`) first if the
  shape of the Actions-side change feels risky.
- **Not built**: `undelete` (restore from git history; needs the
  tombstone → pre-tombstone diff and a rule for the retired id),
  `verify` (the archive-level `lax doctor`), and `gc-captures`
  (unreferenced ghcr artifacts). `sweep` is `revalidate --all`.
- **Pre-release database sanity check — stale dependency pins** (incident
  2026-09-15): lax-271696, lax-62 and lax-3 were registered while their
  `Lax808846` git requires still pinned 5a2645e, one commit behind the
  registered lax-808846 @ 9394e53 (word-ram had been re-drafted and
  registered after its dependents were submitted). Nothing caught it:
  `build-output.json` records dependencies by name only
  (`requiredByConcepts: ["Lax808846"]`), Register freezes without
  re-running Resolution, and `lax register` prints no warning. Repaired
  the same day with `reset-draft` → repin → resubmit → register. Landed the
  same evening (spec.md, "Lifecycle" and "Resolution"): trusted
  Resolution **refuses a git require on a draft** (local `lax build` keeps
  it as a warning, `lax submit` refuses before posting), and `reset-draft`
  refuses a record that a registered record builds on. Still owed before
  the official release: the final database check (`verify`, or a one-off
  script) walking every registered record's frozen lakefiles and asserting
  that each cross-submission `rev` equals the dependency's *current*
  canonical source commit. Decided against for now (2026-09-15): recording
  the resolved pins in `build-output.json` so Register can compare commits
  — which leaves one path open: a draft validated against a *registered*
  dependency, then an admin `reset-draft` of that dependency (allowed while
  the dependent is still a draft), a resubmit, and a register of both. The
  maintainer sees the draft dependents in the delete preview only; if this
  bites, list them in the reset-draft preview or record the pins after all.
- **Deferred by design**: the plan's server-side two-phase confirm
  (`/lax admin confirm <preview-id>`) — the typed confirmation lives in
  the driver, as it does for `lax delete`; and an `admin.yml`
  `workflow_dispatch` — `rebuild-website` is a `repository_dispatch` the
  maintainer's own token already may send, so nothing new runs in the
  publish environment.
- Partially answers the abuse-stance item below; the takedown rationale
  goes in the issue comment, never in the record.

## spec.md reconciliation queue (Jan, manually)

Empty since 2026-09-14: every spec-notes entry up to that date is folded in
and removed. Still open beside spec.md: spec_conceptdialect_draft.md
(spec-notes, 2026-07-29).

## Author frictions (from hiccups.md, still open)

- Apache-2.0-only license gate — salvaged MIT/BSD source has no path;
  decide allowlist vs. loud documentation.
- `Batteries.*` imports rejected (`IMPORT_PREFIXES` in
  `phases/inspect.ts`); authors must hunt a Mathlib module that
  transitively imports it. Also: the violation message no longer lists
  what *is* importable — restore that.
- Flat concepts + per-module namespace ownership makes faithful
  multi-module ports impossible (28 modules → one 762 KB module).

## Concept dialect (spec_conceptdialect_draft.md — advisory model)

Still fully open; zero implementation in this tree. The draft (2026-07-29,
awaiting reconciliation) makes "safe dialect" a derived non-blocking label
and adds the mention rule (list 8) closing the `autoParam` value-door that
spec_conceptdialect.md still has open. Implementation order (re-map onto the
Actions architecture when planned): corpus restructure first (in
lax-submissions, while everything is a mutable draft); Compile split so
proof code can never write what gets captured, with capture provenance;
versioned machine-readable dialect schema (kind lists, payload rules,
generated term-kind snapshot and excluded-name set); gate executable beside
the inspector (guarded frontend, identifier resolution against the mention
rule, info-tree check for elaboration-resolved spellings, `--dump-schema`);
Dialect phase between Provision and Compile; CLI warning walk during local
Resolution (warn, never refuse; `--require-safe` reserved); website label;
initial batch verification over every record in dependency order.

## Carried over from the old repo (still applies here)

- **Abuse stance**: takedown/moderation policy, and what
  "registered is forever" means legally. (Rate limiting now largely
  inherits GitHub's issue/Actions limits — revisit whether that suffices.)
- **Scaffold-as-tutorial pass**: the `lax init` scaffold is the de-facto
  tutorial; give it a small worked example using the annotation vocabulary
  and a README pointing at `lax print spec` and the site.
- **Violation-message audit**: each violation should cite the spec section
  and show the offending line. (The rewrite's 25 distinct violation kinds
  are a good base to build on.)
- **Support channel**: point `--help` / failure output at the issue tracker.
- **Stale `.lake/packages/<LaxN>` clones** linger in author trees once a
  require is dropped or re-pinned (since 2026-08-06 local builds
  materialize dependency clones there *by design* — full repo clones, so
  potentially large). `lax doctor` now names the ones the manifest no
  longer lists, but nothing collects them: the pipeline knows the exact
  name set at `seedManifest` time, so `lax build` deleting packages absent
  from the manifest it just wrote is the better home for the sweep.
- **Registered submission depending on a deleted draft**: deletion only
  warns about stranded dependents; nothing prunes or blocks the registered
  side. Verify the rewrite's publisher has the same gap, then decide.
- **Flagship drafts restructure** (in `~/git/lax-submissions`, not here):
  submission-polish.md — one-statement and type rules fire at submit today;
  the multiple-statements relaxation changes this plan, revisit it then.
- **Workbench/public-repo split for submissions** (Jan's idea, 2026-07-29):
  private workbench repo + a public repo that only changes on submission;
  script first, CLI flag later. Simpler now that waves are gone.
- **Registered-repo mirrors** (idea): keep a mirror of each registered
  repository so archived builds survive upstream deletion.
- **Replay floor**: the remaining per-invocation floor is the one mathlib
  environment import per leanchecker/inspector run; a warm importer would
  cut it. Re-profile now that the pipeline collapse has landed (`--profile`
  exists and works).
- Website-side items now live in `lax-archive/lax-website`: tombstone page
  vs. 404, contributing page wiring, site publication atomicity, search
  index at ~100 submissions, endorsement attestations (v0.3), multi-atom
  source cards (v0.4), and the multiple-statements presentation
  (anonymous per-statement indices) from rewrite.md.

## Second maintainer onboarding

Carried and adapted: invite the second maintainer to the `lax-archive` org
(decide role, consider org 2FA requirement); npm maintainer access (2FA —
publish rights are the deploy gate); the secrets doctrine is now: both App
private keys live only in the one protected Actions environment
(`lax-database-publish`, which deploys only from `main`), a maintainer's
laptop holds nothing — and a key that leaves that environment cannot be read
back, only regenerated. All three App registrations (`lax-cli-publisher`,
`lax-database-publisher`, `lax-website-dispatcher`) were confirmed org-owned
on 2026-08-07. Sweep docs for "maintainer call" spots that assume one
person.

## ORCID-authed comments (design pending)

Comment section on record pages, authed via ORCID OAuth. The old design
homed the data in the server's ops.sqlite — that home no longer exists;
needs a new one (the database repo is public and append-only, so probably
not there). Needs the moderation stance above first.
