**Verdict: the division is useful, but the implementation still permits misattributed certification.** The strongest remaining hole combines the “internal name” exemption with the partially fixed name encoding. Publication also fails to preserve certificate meaning across concept revalidation.

Static review only: no builds, tests, or exploit execution; no files modified. I reviewed `axiomfree` at `0da3139a325e8181642f1d9f79854fe34e40103e`, including concurrent edits. Website observations refer to the sibling checkout at `6d933d75c2ebdd987d6e2b8348faefc7d94ee120`, not a verified deployment.

## Findings, ordered by severity

### 1. High — authored “internal” names still defeat both statement identity and namespace ownership

Locations: [Main.lean:196](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:196), [Main.lean:357](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:357), [inspect-common.ts:99](/home/jan/git/lax/src/submission-validation/phases/inspect-common.ts:99), [inspect-spec2.ts:62](/home/jan/git/lax/src/submission-validation/phases/inspect-spec2.ts:62).

`userLevelName?` discards names satisfying `isInternalDetail`. The new `isCanonicalName` also returns `true` immediately for them. But this is a naming heuristic, not evidence that Lean generated the declaration. In the pinned Lean, an ordinary suffix such as `proof_1` satisfies it.

Consequently:

- Namespace checking skips such declarations because `userName` is absent.
- A dotted component inside such a name is still flattened.
- Statement classification does not require `userName`, despite the draft’s “user-level” requirement.

A concrete two-record scenario:

```lean
-- In an earlier dependency, lax-100001:
def Lax100002.C.A.B.proof_1 : Prop := True

-- In lax-100002's concept module:
@[lax_statement]
def Lax100002.C.«A.B».proof_1 : Prop := False

-- In lax-100002's proof package:
theorem Lax100002Proofs.p :
    Lax100002.C.A.B.proof_1 := True.intro
```

The dependency’s foreign namespace escapes enforcement because of `proof_1`. Its declaration is untagged. The second record’s distinct, tagged `False` definition is reported under the flattened identifier `Lax100002.C.A.B.proof_1`.

The resulting path is:

1. Compile and concept Replay accept both well-typed definitions.
2. Captures preserve them as distinct Lean names.
3. Inspection identifies the tagged `False` definition using the flattened identifier.
4. The proof telescope names the dependency’s nested, `True` definition using that same identifier.
5. Classification treats it as the record’s own statement.
6. The generator emits a reference to the nested `True` definition. A, B, and C can legitimately accept that theorem.
7. Export hashes, bundle regeneration, artifact validation, and database publication faithfully bind this incorrectly identified edge.
8. The website associates the edge with the tagged statement whose recorded body is `False`.

The within-package duplicate guard does not catch this: the two definitions belong to different packages, and only package-local declarations are classified.

The new [Challenge check:61](/home/jan/git/lax/src/submission-validation/certify/challenge-check.ts:61) also passes: it compares the same flattened strings on both sides. It does not recover the lost distinction.

There is a simpler composition failure from the same exemption: two independent records can each declare `def Clash.proof_1 : Nat := …`. Both evade namespace enforcement, but importing them together fails.

**Required change:** preserve structured `Lean.Name` identity throughout classification and translation. Never exempt an endpoint from injective encoding. Enforce ownership independently of whether a name looks internal; distinguish authenticated reserved realizations from arbitrary declarations.

This is a concrete incompleteness in the earlier name-encoding fix, not a restatement of the original unrestricted `«A.B»` collision.

### 2. High — revalidation can change the meaning of an existing certified endpoint

Locations: [submit-publisher.ts:217](/home/jan/git/lax/src/shared/submit-publisher.ts:217), [submit-publisher.ts:348](/home/jan/git/lax/src/shared/submit-publisher.ts:348), [resolution.ts:154](/home/jan/git/lax/src/submission-validation/phases/resolution.ts:154), [website shared.ts:91](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:91).

Revalidation requires the same source triple and preserves a registered record’s state. It nevertheless replaces its build output and capture. There is no corresponding check that existing dependents still refer to the same concept definitions, nor an invalidation of their certificates.

**Failure scenario:**

1. Concept record R uses compile-time code to produce tagged statement `R.S := True`.
2. Record D proves `R.S` and receives a certificate against R’s first capture.
3. A maintainer later revalidates R at the same source commit.
4. R’s compile-time code now produces `R.S := False`, for example after a date threshold.
5. R passes concept Replay: `False` is a perfectly valid definition of type `Prop`. R need not contain any proof edges.
6. Publication replaces R’s capture and statement body while keeping it registered.
7. D’s certificate remains recorded, and its conclusion still links by statement ID to the now-current `R.S`.

The website can therefore present a certified proof of the current `False` statement, although C judged D against the previous `True` definition. Normal imports can also combine D’s old proof olean with R’s replacement concept olean without rechecking D.

This **requires an authorized maintainer revalidation**; it is not an author-only publication operation. However, routine revalidation must remain safe against authored compile-time behavior.

The publisher’s dependency comparison at [submit-publisher.ts:268](/home/jan/git/lax/src/shared/submit-publisher.ts:268) correctly protects a publication against dependencies changing during that publication. It does not protect already-published dependents from a later replacement.

**Required change:** make certified dependency identities include immutable capture identities, and preserve those historical identities in readers and the website. Revalidation that changes concept artifacts must create a new semantic version or explicitly invalidate/revalidate the dependent graph. Source-commit equality is insufficient.

### 3. High for reader verification — `lax certify --run` lets a proof build poison subsequent Challenge inputs

Locations: [certify.ts:103](/home/jan/git/lax/src/cli/certify.ts:103), [certify.ts:154](/home/jan/git/lax/src/cli/certify.ts:154), [certify.ts:541](/home/jan/git/lax/src/cli/certify.ts:541), [certify.ts:560](/home/jan/git/lax/src/cli/certify.ts:560).

The reader command deliberately retains `.lake` between invocations. It rewrites the bundle’s five files and `lean-toolchain`, then runs ordinary `lake comparator`.

In the pinned comparator:

- Solution builds may write throughout the project’s `.lake`, including dependency checkouts and build products.
- Challenge is built and exported before Solution.
- Lake accepts an existing dependency checkout at the required revision even when dirty; it only warns about local changes.

See the pinned [Check.lean:356](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:356) and [Materialize.lean:57](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/Load/Materialize.lean:57).

**Failure scenario:** proof source executes compile-time IO during the first reader run and alters a concept dependency’s source or cached artifacts inside `.lake`. The first Challenge export is already protected, but the altered tree survives. On the next invocation, the CLI restores only the top-level bundle files. Challenge and Solution can now agree over the altered concept definition, and the CLI announces “Certified” while retaining the original git pins.

A dirty-checkout warning is neither rejection nor authentication; ordinary CLI output also need not expose the full comparator transcript.

The new initializer ban does not prevent this. `run_cmd` and other elaboration-time code execute during source rebuilding without persisted initializers.

**Required change:** use fresh workspaces and independently authenticate and freeze the concept closure before executing proof builds. Give reader verification the same separation of inputs and execution as archive certification.

This is an integrity hole in rerunning a certificate, distinct from the already-known absence of historical export replay.

### 4. Medium — whole-package `sorry` hygiene examines merged bodies, so a stored `sorry` can disappear from inspection

Locations: [Main.lean:779](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:779), [Main.lean:277](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:277), [inspect.ts:389](/home/jan/git/lax/src/submission-validation/phases/inspect.ts:389).

The inspector enumerates each module’s `constNames`, but obtains the declaration through `env.find?`. Its axiom traversal likewise reads the merged environment and caches by name. It therefore does not necessarily inspect the body stored in that module.

The new duplicate exception compounds this: it considers two theorem declarations “realized theorems” whenever both lack `userName`. That includes authored `proof_1` names.

**Failure scenario:** two proof modules independently contain:

```lean
-- Module A
theorem Lax100003Proofs.helper.proof_1 : True := by sorry

-- Module B
theorem Lax100003Proofs.helper.proof_1 : True := True.intro
```

The root imports A and then B. Lean permits equal-name, equal-type theorem duplicates and selects B’s body. Inspection attributes that merged body to both module entries. The duplicate exception admits them, and the hygiene check sees no `sorryAx`. The capture still publishes A’s sorry-bearing declaration and source.

This goes beyond the earlier D2 attribution issue: it bypasses the archive’s hard whole-package publication rule. Even a correctly restricted exception for genuine reserved theorems would still require per-module body inspection; equal theorem types do not imply equal axiom dependencies.

**Required change:** inspect each module’s original `ConstantInfo` and its appropriate dependency environment. Apply hygiene before deduplication. Restoring Replay alone would not establish sorry-freedom: `sorryAx` is a well-typed axiom.

### 5. Medium — metadata-only publication breaks the certificate’s source binding

Locations: [metadata-resubmission.ts:281](/home/jan/git/lax/src/submission-validation/metadata-resubmission.ts:281), [metadata-publisher.ts:125](/home/jan/git/lax/src/shared/metadata-publisher.ts:125), [project.ts:162](/home/jan/git/lax/src/submission-validation/certify/project.ts:162), [verify-bundle.ts:117](/home/jan/git/lax/src/submission-validation/certify/verify-bundle.ts:117).

`metadataCandidate` retains the existing certificate but updates `capture.sourceCommit`; metadata publication also advances `record.source`. The retained bundle’s own-package git requirements still name the previous commit.

**Failure scenario:** publish a certified draft at C1, then change only its title at C2. Metadata publication records C2 while preserving the certificate bundle pinned to C1. The normal publisher’s exact regeneration invariant would reject that bundle against the new record, but this path does not perform that check.

Consequences are observable in [certify.ts:389](/home/jan/git/lax/src/cli/certify.ts:389): normal regeneration uses C2 and produces another digest, whereas `--fetch` returns the C1 bundle. The diagnostic suggests another local pin set, although publication itself created the mismatch.

The metadata comparison establishes unchanged Lean source files, so this is **not evidence of a false theorem**. It is a provenance inconsistency.

**Required change:** represent the original certified source separately from the current presentation source, with explicit reuse evidence, or regenerate the bundle and record that its execution evidence was reused under a defined equivalence rule.

## Earlier fixes that remain incomplete

- **Intents finding 1 and namespace D2:** findings 1 and 4 above explain precisely why the current fixes remain bypassable. Absence of `userName` does not establish generated or reserved provenance.
- **Intents finding 6:** [verdict.ts:152](/home/jan/git/lax/src/submission-validation/certify/verdict.ts:152) still classifies a kernel crash as author rejection if the comparator printed its rejection notice. The pinned comparator prints that notice for **every nonzero kernel exit**, including crashes. A subprocess exit such as 134 can become comparator exit 1 and evade the container boundary classifier. The independent-kernel-disagreement branch is an improvement, but does not solve this case.
- **A/B failures remain conflated:** [run-certify.mjs:73](/home/jan/git/lax/src/submission-validation/sandbox/tools/run-certify.mjs:73) maps failed spawn to 2 and signals to 1. [phase.ts:245](/home/jan/git/lax/src/submission-validation/certify/phase.ts:245) and [phase.ts:320](/home/jan/git/lax/src/submission-validation/certify/phase.ts:320) then classify these as translation/judge violations. A missing `leanexport`, or the newly required inspector failing to start, is infrastructure failure. Conversely, the host path treats every export failure as infrastructure without distinguishing malformed authored input.
- **The revised Replay advice is incorrect:** [spec_v2_draft.md:1415](/home/jan/git/lax/spec_v2_draft.md:1415) recommends `lax build --replay` for checked reusable helpers, but [host/pipeline.ts:478](/home/jan/git/lax/src/submission-validation/host/pipeline.ts:478) explicitly excludes spec-2 proof packages even with that option.
- **The F1 consequence is overstated:** [TODO.md:151](/home/jan/git/lax/TODO.md:151) says banning initializers means nothing in a record runs IO during `lax certify --run`. Source elaboration still runs authored IO, as finding 3 demonstrates.

I disagree with treating Lean’s tolerance of duplicate theorem types as sufficient justification for dropping their individual bodies from standards inspection. Proof irrelevance supports logical substitution under appropriate checking; it does not establish identical provenance or sorry-freedom.

## Dropping proof-package Replay: actual readers and trust

The narrow argument is defensible: C can establish each exported edge without first replaying the whole proof package. It does **not** follow that every subsequent olean consumer is protected.

| Reader after Compile | What it reads and trusts |
|---|---|
| Capture creation, sealing, extraction and cache verification | Copies/hashes inventoried oleans and companions. Establishes byte integrity, not kernel validity or source correspondence. |
| Proof inspector | Imports own and dependency proof oleans with `trustLevel := 1024`, `loadExts := false`; trusts stored declarations while reading types, tags and bodies. Its hygiene traversal is not a kernel check. |
| Container B’s Lake/Lean build | Imports captured proof declarations and uses them while elaborating Solution. Ordinary imported olean declarations are trusted. |
| Container B’s `leanexport` | Traverses selected declarations and their dependencies. Exporting is not the final proof-validity check; C must reject invalid exported proof dependencies. |
| A later record’s proof Compile and inspector | Imports earlier proof captures as dependencies. Capture hashes authenticate bytes, not unused helpers. That later record’s C checks its own certified edges. |
| `generate-prooftree` composer | [Main.lean:302](/home/jan/git/lax/assets/prooftree/Main.lean:302) imports proof captures at high trust with extensions disabled. It kernel-checks declarations copied/generated into its output; that does not authenticate every input declaration. |
| Reader/local source builds, including `lax certify --run` | Produce and consume local cached proof oleans. These are source-rebuild results rather than the archive’s frozen proof capture; finding 3 applies. |
| Ordinary downstream Lean users | Trust imported proof declarations unless they independently replay or otherwise check them. No archive-wide guarantee covers unused proof helpers. |

Container A and concept Replay should not import proof-package oleans through the permitted concept dependency graph. Container C reads exports, not oleans. The publisher, database and website consume metadata and digest-addressed artifacts rather than performing another Lean check.

The new inspection of A’s generated Challenge is another olean reader, but of **Challenge plus concepts**, not proof-package oleans.

Thus dropping Replay is safe only for the narrowly stated edge-validity obligation, assuming correct translation and immutable binding. Findings 1–3 show those assumptions still need work. It does not support a general claim that published proof packages are safe, checked reusable libraries.

## Intent-label audit

The explicit `intent:` assignments and classifier-supplied intents are broadly recognizable, but several boundaries remain misleading.

| Assignment | Assessment |
|---|---|
| Comparator type/axiom/kernel judgments → `judge` | Appropriate for an actual judgment. Crash and unknown-failure fallbacks must not inherit this meaning. |
| Endpoint name encoding, statement resolution, universe restrictions, Challenge mismatch → `translation` | Appropriate. The new Challenge check belongs here. |
| Namespace, whole-package hygiene, imports, root module, frontmatter → `standards` | Appropriate as primary purposes. The label must not imply these rules are irrelevant to certification security. |
| Every Solution build/export failure → `judge` | Too broad. The accompanying message itself describes generator/classifier disagreement; failures can also be infrastructure faults. |
| `@[lax_statement]` in the proof package → `translation` | Primarily a standards restriction: these declarations are not admitted as endpoints by the classifier. |
| Every duplicate name → `translation` | Appropriate for ambiguous edge attribution, but duplicates involving only helpers also enforce composition/standards. |

[certify.ts:191](/home/jan/git/lax/src/cli/certify.ts:191) discards `verdict.intent` when constructing the reader CLI finding, so this author-facing path loses the distinction.

The implementation also intentionally leaves shared-phase findings without an intent ([contracts.ts:39](/home/jan/git/lax/src/submission-validation/contracts.ts:39)), while TODO still promises one on every finding. Resolve that contract explicitly rather than silently filling unknown cases with `judge`.

## Best practices

- **Judge:** retain fresh C with immutable export inputs and no candidate build tree. Use structured results distinguishing rejection, crash, resource exhaustion, launch failure and checker disagreement. Unknown outcomes should not become author rejection.
- **Translation:** carry structured names and declaration origin through every stage. Validate Challenge’s actual exported targets against those identities and telescopes. Comparing two readings produced by the same lossy encoding is insufficient.
- **Standards:** enforce ownership for every persisted declaration, with narrowly justified exceptions. Inspect original per-module bodies. Keep composition, axiom hygiene and executable extension policy explicit even when they are not proof-validity checks.
- **Binding and publication:** identify dependency captures immutably in certificate provenance. Preserve historical meanings through revalidation and metadata updates. Have the reader verifier consume authenticated, isolated inputs.
- **Website:** the Challenge is correctly HTML-escaped and rendered directly at [shared.ts:270](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:270); I found no rendering transformation that repairs or causes the identity bug. Its [trust note:244](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:244), however, still says readers need not trust the pipeline. That overstates what displayed text and a bundle currently establish.

Palomar’s policy makes the missing boundary explicit: export-mode comparison does not authenticate correspondence to a project; the verifier must authenticate the Challenge and its dependency closure. Its independently trusted Challenge model cannot simply be assumed when the same author supplies Lax’s concepts and proofs. [Palomar SECURITY.md](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/SECURITY.md)

The normal publication path is materially improved: [submission.ts:752](/home/jan/git/lax/src/workflows/submission.ts:752) invokes exact five-file regeneration, and the publisher rechecks dependency state before its database write. I found no new ordinary full-publication artifact-substitution route through those checks. The remaining failures above concern what those authenticated bytes mean and whether that meaning remains bound over time.

## Concurrent-edit observations

Files changed under me. Hash comparisons detected changes in `TODO.md`, `contracts.ts`, `certify/{host,phase}.ts`, `host/pipeline.ts`, `phases/inspect*.ts`, `lean/inspector/Main.lean`, and later `spec_v2_draft.md`, `assets/instructions.md`, `history/environments-plan.md`, plus several tests/fixtures. I also observed the new `certify/challenge-check.ts` and corresponding `run-certify.mjs` changes.

I reread the relevant changed implementation and draft passages; the findings include the new Challenge check and namespace fixes. The website source snapshot did not change. This report describes the observed moving working tree, not an atomic checkout.
